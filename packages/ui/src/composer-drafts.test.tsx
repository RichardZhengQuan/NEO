import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ImagePart } from '@neo/protocol';
import { Composer, type ComposerHandle, type ComposerProps } from './composer.js';
import { I18nProvider } from './i18n.js';
import { createRetainedStateStore, RetainedStateProvider, RetainedStateScope } from './retained-state.js';

type DraftStore = ReturnType<typeof createRetainedStateStore>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(store: DraftStore, props: Partial<ComposerProps> = {}, scope = 'composer:recorded') {
  return render(
    <I18nProvider locale="en">
      <RetainedStateProvider store={store}>
        <RetainedStateScope scope={scope}>
          <Composer onSend={() => undefined} {...props} />
        </RetainedStateScope>
      </RetainedStateProvider>
    </I18nProvider>,
  );
}

function type(text: string): void {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });
}

function input(): HTMLTextAreaElement {
  return screen.getByRole('textbox') as HTMLTextAreaElement;
}

async function attach(container: HTMLElement, name = 'dinner.png'): Promise<void> {
  const file = new File(['image fixture'], name, { type: 'image/png' });
  fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
  await waitFor(() => expect(screen.getByRole('img', { name })).toBeTruthy());
}

function deferImageReads(): Array<{ result: string | null; onload: (() => void) | null }> {
  const readers: Array<{ result: string | null; onload: (() => void) | null }> = [];
  vi.stubGlobal('FileReader', class {
    result: string | null = null;
    onload: (() => void) | null = null;
    readAsDataURL(): void { readers.push(this); }
  });
  return readers;
}

async function finishImageRead(reader: { result: string | null; onload: (() => void) | null }): Promise<void> {
  await act(async () => {
    reader.result = 'data:image/png;base64,aW1hZ2U=';
    reader.onload!();
  });
}

describe('retained composer drafts', () => {
  it('restores exact input and usable attachment previews after leaving and returning', async () => {
    const store = createRetainedStateStore();
    const mounted = show(store);
    type('  Unfinished dinner invitation\n');
    await attach(mounted.container);
    const preview = screen.getByRole('img', { name: 'dinner.png' }).getAttribute('src');
    expect(preview).toMatch(/^data:image\/png;base64,/);
    mounted.unmount();

    const onDraftChange = vi.fn();
    show(store, { onDraftChange });
    expect(input().value).toBe('  Unfinished dinner invitation\n');
    expect(screen.getByRole('img', { name: 'dinner.png' }).getAttribute('src')).toBe(preview);
    expect(onDraftChange).toHaveBeenLastCalledWith('  Unfinished dinner invitation\n');
  });

  it('clears submitted text and attachments so returning does not resend them', async () => {
    const store = createRetainedStateStore();
    const onSend = vi.fn();
    const mounted = show(store, { onSend });
    type('  Send this  ');
    await attach(mounted.container);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledOnce();
    expect(onSend).toHaveBeenCalledWith('Send this', [expect.objectContaining({ type: 'image', mediaType: 'image/png', alt: 'dinner.png' })], expect.any(Function));
    expect(input().value).toBe('');
    expect(screen.queryByRole('img', { name: 'dinner.png' })).toBeNull();
    mounted.unmount();
    show(store);
    expect(input().value).toBe('');
    expect(screen.queryByRole('img', { name: 'dinner.png' })).toBeNull();
  });

  it('restores failed text and image submission once even while the page is unmounted', async () => {
    const store = createRetainedStateStore();
    let restoreDraft: (() => void) | undefined;
    const onSend = (_text: string, _images: ImagePart[], restore?: () => void) => { restoreDraft = restore; };
    const mounted = show(store, { onSend });
    type(' Keep my exact draft ');
    await attach(mounted.container);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    mounted.unmount();
    act(() => { restoreDraft!(); restoreDraft!(); });
    show(store);
    expect(input().value).toBe(' Keep my exact draft ');
    expect(screen.getAllByRole('img', { name: 'dinner.png' })).toHaveLength(1);
  });

  it('keeps newer text and attachments when an earlier send fails', async () => {
    const store = createRetainedStateStore();
    let restoreDraft: (() => void) | undefined;
    const mounted = show(store, { onSend: (_text, _images, restore) => { restoreDraft = restore; } });
    type('Earlier draft');
    await attach(mounted.container, 'old.png');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    type('Newer input');
    await attach(mounted.container, 'new.png');
    act(() => restoreDraft!());
    expect(input().value).toBe('Newer input');
    expect(screen.getByRole('img', { name: 'new.png' })).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'old.png' })).toBeNull();
  });

  it('preserves input set during onSend and reports imperative text changes', () => {
    const store = createRetainedStateStore();
    const handleRef = createRef<ComposerHandle>();
    const onDraftChange = vi.fn();
    let restoreDraft: (() => void) | undefined;
    show(store, { handleRef, onDraftChange, onSend: (_text, _images, restore) => { restoreDraft = restore; handleRef.current!.setText('Follow-up'); } });
    type('First request');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(input().value).toBe('Follow-up');
    expect(onDraftChange).toHaveBeenLastCalledWith('Follow-up');
    act(() => restoreDraft!());
    expect(input().value).toBe('Follow-up');
  });

  it('keeps image attachments pasted alongside the text draft', async () => {
    const store = createRetainedStateStore();
    const mounted = show(store);
    type('Pasted picture');
    const file = new File(['clipboard fixture'], 'paste.png', { type: 'image/png' });
    fireEvent.paste(input(), { clipboardData: { items: [{ kind: 'file', type: file.type, getAsFile: () => file }] } });
    await waitFor(() => expect(screen.getByRole('img', { name: 'paste.png' })).toBeTruthy());
    mounted.unmount();
    show(store);
    expect(input().value).toBe('Pasted picture');
    expect(screen.getByRole('img', { name: 'paste.png' })).toBeTruthy();
  });

  it('isolates privacy scopes and new sessions while invalidating old failure restorations', () => {
    const store = createRetainedStateStore();
    let restoreDraft: (() => void) | undefined;
    let mounted = show(store, { onSend: (_text, _images, restore) => { restoreDraft = restore; } });
    type('Recorded input');
    mounted.unmount();
    mounted = show(store, {}, 'composer:off-record');
    expect(input().value).toBe('');
    type('Private input');
    mounted.unmount();
    mounted = show(store, { onSend: (_text, _images, restore) => { restoreDraft = restore; } });
    expect(input().value).toBe('Recorded input');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    mounted.unmount();
    act(() => store.clear());
    act(() => restoreDraft!());
    mounted = show(store);
    expect(input().value).toBe('');
    mounted.unmount();
    mounted = show(store, {}, 'composer:off-record');
    expect(input().value).toBe('');
    mounted.unmount();
    show(createRetainedStateStore());
    expect(input().value).toBe('');
  });

  it('does not let an unfinished attachment read leak into a cleared session', async () => {
    const readers = deferImageReads();
    const store = createRetainedStateStore();
    const mounted = show(store);
    type('Old session input');
    fireEvent.change(mounted.container.querySelector('input[type="file"]')!, {
      target: { files: [new File(['old'], 'private.png', { type: 'image/png' })] },
    });
    mounted.unmount();
    act(() => store.clear());
    show(store);
    type('New session input');
    await finishImageRead(readers[0]!);
    expect(input().value).toBe('New session input');
    expect(screen.queryByRole('img', { name: 'private.png' })).toBeNull();
  });

  it('finishes reading an attachment into the retained draft while its page is away', async () => {
    const readers = deferImageReads();
    const store = createRetainedStateStore();
    const mounted = show(store);
    type('Pending picture');
    fireEvent.change(mounted.container.querySelector('input[type="file"]')!, {
      target: { files: [new File(['picture'], 'pending.png', { type: 'image/png' })] },
    });
    mounted.unmount();
    await finishImageRead(readers[0]!);
    show(store);
    expect(input().value).toBe('Pending picture');
    expect(screen.getByRole('img', { name: 'pending.png' }).getAttribute('src')).toBe('data:image/png;base64,aW1hZ2U=');
  });

  it('discards unfinished attachment reads from a submitted draft', async () => {
    const readers = deferImageReads();
    const mounted = show(createRetainedStateStore());
    type('First request');
    fireEvent.change(mounted.container.querySelector('input[type="file"]')!, {
      target: { files: [new File(['old'], 'late.png', { type: 'image/png' })] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    type('Next request');
    await finishImageRead(readers[0]!);
    expect(input().value).toBe('Next request');
    expect(screen.queryByRole('img', { name: 'late.png' })).toBeNull();
  });

  it('retains the local-only behavior when no retained-state provider is mounted', () => {
    const mounted = render(<I18nProvider locale="en"><Composer onSend={() => undefined} /></I18nProvider>);
    type('Standalone input');
    mounted.unmount();
    render(<I18nProvider locale="en"><Composer onSend={() => undefined} /></I18nProvider>);
    expect(input().value).toBe('');
  });
});
