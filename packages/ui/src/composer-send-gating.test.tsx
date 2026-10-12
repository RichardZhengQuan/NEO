import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Composer } from './composer.js';
import { I18nProvider } from './i18n.js';

afterEach(cleanup);

describe('composer send gating', () => {
  it('keeps draft editing enabled while Send and Enter are disabled, and preserves the normal default', () => {
    const onSend = vi.fn();
    const view = render(<I18nProvider locale="en"><Composer onSend={onSend} sendDisabled /></I18nProvider>);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);
    fireEvent.change(textarea, { target: { value: 'Unfinished question' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe('Unfinished question');
    view.rerender(<I18nProvider locale="en"><Composer onSend={onSend} /></I18nProvider>);
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('Unfinished question', [], expect.any(Function));
  });

  it('gates the current text and attachments without discarding the draft', async () => {
    const onSend = vi.fn();
    const view = render(<I18nProvider locale="en"><Composer onSend={onSend} sendDisabled={(text, images) => text !== 'Plan tomorrow' || images.length > 0} /></I18nProvider>);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Plan tomorrow' } });
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false);
    const image = new File(['fixture'], 'draft.png', { type: 'image/png' });
    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [image] } });
    await screen.findByRole('img', { name: 'draft.png' });
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe('Plan tomorrow');
    fireEvent.click(screen.getByRole('button', { name: 'Remove draft.png' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('Plan tomorrow', [], expect.any(Function));
  });
});
