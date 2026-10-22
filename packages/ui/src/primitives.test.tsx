import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ImageBlock } from '@neo/protocol';
import { BlockRenderer } from './blocks.js';
import { I18nProvider } from './i18n.js';
import { Modal } from './primitives.js';

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
