import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import type { ImageBlock } from '@neo/protocol';
import { BlockRenderer } from './blocks.js';
import { I18nProvider } from './i18n.js';
import { Modal } from './primitives.js';
import { ConfirmProvider, useConfirm } from './confirm.js';

vi.mock('./remote-image.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./remote-image.js')>(),
  useRemoteImages: () => ({ status: 'show', hosts: [], allow: () => undefined }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Modal without focusable controls', () => {
  it.each([false, true])('prevents Tab from escaping the dialog (shift: %s)', (shiftKey) => {
    render(
      <I18nProvider locale="en">
        <button>Outside control</button>
        <Modal open={true} title="Text-only modal" onClose={vi.fn()} hideClose>
          Plain text content
        </Modal>
      </I18nProvider>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Text-only modal' });
    expect(document.activeElement).toBe(dialog);
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });

    fireEvent(document, event);

    // jsdom does not perform default Tab navigation, so check cancellation too.
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(dialog);
  });
});

function nestedModals() {
  const onOuterClose = vi.fn();
  const onInnerClose = vi.fn();
  render(
    <I18nProvider locale="en">
      <Modal open={true} title="Outer modal" onClose={onOuterClose} hideClose>
        <button>Outer control</button>
        <Modal open={true} title="Inner modal" onClose={onInnerClose} hideClose>
          <button>Inner first</button>
          <button>Inner last</button>
        </Modal>
      </Modal>
    </I18nProvider>,
  );
  return { onOuterClose, onInnerClose };
}

describe('nested Modals', () => {
  it('closes only the inner modal on Escape', () => {
    const { onOuterClose, onInnerClose } = nestedModals();
    const innerControl = screen.getByRole('button', { name: 'Inner first' });
    innerControl.focus();

    fireEvent.keyDown(innerControl, { key: 'Escape' });

    expect(onInnerClose).toHaveBeenCalledTimes(1);
    expect(onOuterClose).not.toHaveBeenCalled();
  });

  it.each([false, true])('wraps focus inside the inner modal without running the outer trap (shift: %s)', (shiftKey) => {
    nestedModals();
    const outerDialog = screen.getByRole('dialog', { name: 'Outer modal' });
    // Portals are DOM siblings, so focus alone would hide the outer handler running.
    const outerTrap = vi.spyOn(outerDialog, 'querySelectorAll');
    const first = screen.getByRole('button', { name: 'Inner first' });
    const last = screen.getByRole('button', { name: 'Inner last' });
    const start = shiftKey ? first : last;
    const end = shiftKey ? last : first;
    start.focus();

    fireEvent.keyDown(start, { key: 'Tab', shiftKey });

    expect(document.activeElement).toBe(end);
    expect(outerTrap).not.toHaveBeenCalled();
  });
});

describe('Lightbox inside a Modal', () => {
  it('closes only the Lightbox on Escape', () => {
    const onClose = vi.fn();
    const block: ImageBlock = {
      type: 'image',
      url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      alt: 'Preview image',
    };
    render(
      <I18nProvider locale="en">
        <Modal open={true} title="Image modal" onClose={onClose}>
          <BlockRenderer block={block} />
        </Modal>
      </I18nProvider>,
    );
    const imageButton = screen.getByRole('button', { name: 'Preview image' });
    fireEvent.click(imageButton);
    const lightbox = screen.getByRole('dialog', { name: 'Preview image' });
    expect(lightbox.classList.contains('neo-lightbox')).toBe(true);

    fireEvent.keyDown(lightbox, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Preview image' })).toBeNull();
    expect(document.body.contains(lightbox)).toBe(false);
    expect(screen.getByRole('button', { name: 'Preview image' })).toBe(imageButton);
    expect(screen.getByRole('dialog', { name: 'Image modal' })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('Modal without focusable controls', () => {
  it.each([false, true])('prevents Tab from escaping the dialog (shift: %s)', (shiftKey) => {
    render(
      <I18nProvider locale="en">
        <Modal open={true} onClose={vi.fn()} hideClose>
          <p>Hello</p>
        </Modal>
      </I18nProvider>,
    );
    const content = screen.getByText('Hello');
    const preventDefault = vi.spyOn(KeyboardEvent.prototype, 'preventDefault');

    fireEvent.keyDown(content, { key: 'Tab', shiftKey });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(preventDefault.mock.contexts[0]).toMatchObject({ key: 'Tab', target: content });
  });
});


function SequentialConfirmation({ onOuterClose, onAnswer }: { onOuterClose: () => void; onAnswer: (value: boolean) => void }) {
  const [outer, setOuter] = useState(false);
  const [unrelated, setUnrelated] = useState(false);
  return <I18nProvider locale="en"><ConfirmProvider>
    <button onClick={() => setOuter(true)}>Open outer</button>
    <button onClick={() => setOuter(false)}>Remove outer</button>
    <button onClick={() => setUnrelated(true)}>Open unrelated</button>
    <Modal open={outer} title="Sequential outer" onClose={() => { onOuterClose(); setOuter(false); }}>
      <ConfirmationOpener onAnswer={onAnswer} />
      <button>Outer last</button>
    </Modal>
    <Modal open={unrelated} title="Unrelated newer" onClose={() => setUnrelated(false)} hideClose><button>Unrelated only</button></Modal>
  </ConfirmProvider></I18nProvider>;
}
function ConfirmationOpener({ onAnswer }: { onAnswer: (value: boolean) => void }) {
  const confirm = useConfirm();
  return <button onClick={() => { void confirm({ title: 'Inner confirmation', message: 'Continue?', confirmLabel: 'Proceed' }).then(onAnswer); }}>Open inner</button>;
}
function openSequential(strict = false) {
  const onOuterClose = vi.fn(), onAnswer = vi.fn();
  const content = <SequentialConfirmation onOuterClose={onOuterClose} onAnswer={onAnswer} />;
  const view = render(strict ? <StrictMode>{content}</StrictMode> : content);
  const outerOpener = screen.getByRole('button', { name: 'Open outer' });
  outerOpener.focus(); fireEvent.click(outerOpener);
  const innerOpener = screen.getByRole('button', { name: 'Open inner' });
  innerOpener.focus(); fireEvent.click(innerOpener);
  return { ...view, onOuterClose, onAnswer, outerOpener, innerOpener };
}

describe('sequential Modal keyboard ownership', () => {
  it.each([false, true])('wraps only the actual later confirmation at a Tab boundary (shift: %s)', (shiftKey) => {
    openSequential();
    const outer = screen.getByRole('dialog', { name: 'Sequential outer' });
    const outerTrap = vi.spyOn(outer, 'querySelectorAll');
    const inner = screen.getByRole('dialog', { name: 'Inner confirmation' });
    const first = within(inner).getByRole('button', { name: 'Close' });
    const last = within(inner).getByRole('button', { name: 'Proceed' });
    const start = shiftKey ? first : last, end = shiftKey ? last : first;
    start.focus();
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
    fireEvent(start, event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(end);
    expect(outerTrap).not.toHaveBeenCalled();
  });

  it.each([false, true])('closes inner only, restores its opener and resumes outer across repeated opens (StrictMode: %s)', async (strict) => {
    const { onOuterClose, onAnswer, innerOpener, outerOpener } = openSequential(strict);
    for (let i = 0; i < 3; i++) {
      await act(async () => { fireEvent.keyDown(screen.getByRole('button', { name: 'Proceed' }), { key: 'Escape' }); });
      expect(screen.queryByRole('dialog', { name: 'Inner confirmation' })).toBeNull();
      expect(screen.getByRole('dialog', { name: 'Sequential outer' })).toBeTruthy();
      expect(onOuterClose).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(innerOpener);
      expect(onAnswer).toHaveBeenLastCalledWith(false);
      if (i < 2) fireEvent.click(innerOpener);
    }
    fireEvent.keyDown(innerOpener, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Sequential outer' })).toBeNull();
    expect(onOuterClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(outerOpener);
  });

  it('does not steal focus when a non-top outer closes, and skips its detached opener on later inner cleanup', async () => {
    const { outerOpener } = openSequential();
    const proceed = screen.getByRole('button', { name: 'Proceed' });
    proceed.focus(); fireEvent.click(screen.getByRole('button', { name: 'Remove outer' }));
    expect(screen.queryByRole('dialog', { name: 'Sequential outer' })).toBeNull();
    expect(document.activeElement).toBe(proceed);
    await act(async () => { fireEvent.keyDown(proceed, { key: 'Escape' }); });
    expect(screen.queryByRole('dialog', { name: 'Inner confirmation' })).toBeNull();
    expect(document.activeElement).toBe(outerOpener);
  });

  it('gives an unrelated newer dialog ownership above an already nested confirmation', async () => {
    openSequential();
    const proceed = screen.getByRole('button', { name: 'Proceed' });
    proceed.focus(); fireEvent.click(screen.getByRole('button', { name: 'Open unrelated' }));
    const top = screen.getByRole('button', { name: 'Unrelated only' });
    expect(document.activeElement).toBe(top);
    fireEvent.keyDown(top, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Unrelated newer' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Inner confirmation' })).toBeTruthy();
    expect(document.activeElement).toBe(proceed);
    await act(async () => { fireEvent.keyDown(proceed, { key: 'Escape' }); });
    expect(screen.getByRole('dialog', { name: 'Sequential outer' })).toBeTruthy();
  });

  it('retains standalone backdrop dismissal and exact opener restoration', () => {
    const onClose = vi.fn();
    function Standalone() { const [open, setOpen] = useState(false); return <I18nProvider locale="en"><button onClick={() => setOpen(true)}>Standalone opener</button><Modal open={open} title="Standalone" onClose={() => { onClose(); setOpen(false); }}><button>Standalone content</button></Modal></I18nProvider>; }
    render(<Standalone />);
    const opener = screen.getByRole('button', { name: 'Standalone opener' });
    opener.focus(); fireEvent.click(opener);
    fireEvent.mouseDown(screen.getByRole('dialog', { name: 'Standalone' }).parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'Standalone' })).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
