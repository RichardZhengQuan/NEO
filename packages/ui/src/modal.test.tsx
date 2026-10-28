import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState, type ReactElement } from 'react';
import { ConfirmProvider, useConfirm } from './confirm.js';
import { I18nProvider } from './i18n.js';
import { Modal } from './primitives.js';

afterEach(cleanup);

function wrap(ui: ReactElement) {
  return render(<I18nProvider locale="en">{ui}</I18nProvider>);
}

function backdropFor(dialog: HTMLElement): HTMLElement {
  const backdrop = dialog.parentElement!;
  expect(backdrop.classList.contains('neo-modal-backdrop')).toBe(true);
  return backdrop;
}

function pressBackdrop(backdrop: HTMLElement): MouseEvent {
  const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
  fireEvent(backdrop, event);
  // jsdom skips the browser's default mousedown focus action. Run it after
  // React's synchronous close/cleanup, when it would blur the restored opener.
  if (!event.defaultPrevented) (document.activeElement as HTMLElement | null)?.blur();
  fireEvent.mouseUp(backdrop);
  fireEvent.click(backdrop);
  return event;
}

function ModalPage(props: { onClose: () => void; dismissable?: boolean; restoreFocus?: boolean; unmountOnClose?: boolean }) {
  const [open, setOpen] = useState(false);
  const targetRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open modal</button>
      <button ref={targetRef}>Restore target</button>
      {(!props.unmountOnClose || open) && (
        <Modal
          open={open}
          title="Example modal"
          dismissable={props.dismissable}
          restoreFocus={props.restoreFocus ? targetRef.current : undefined}
          onClose={() => {
            props.onClose();
            setOpen(false);
          }}
        >
          <button>Inside control</button>
          <p>Selectable dialog text</p>
        </Modal>
      )}
    </>
  );
}

function openModal() {
  const opener = screen.getByRole('button', { name: 'Open modal' });
  opener.focus();
  fireEvent.click(opener);
  const dialog = screen.getByRole('dialog', { name: 'Example modal' });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Inside control' }));
  return { opener, dialog, backdrop: backdropFor(dialog) };
}

function ConfirmPage({ onConfirm }: { onConfirm: (pending: Promise<boolean>) => void }) {
  const confirm = useConfirm();
  return <button onClick={() => onConfirm(confirm({ message: 'Delete this note?' }))}>Delete</button>;
}

function openConfirm() {
  let pending!: Promise<boolean>;
  wrap(
    <ConfirmProvider>
      <ConfirmPage onConfirm={(result) => { pending = result; }} />
    </ConfirmProvider>,
  );
  const opener = screen.getByRole('button', { name: 'Delete' });
  opener.focus();
  fireEvent.click(opener);
  const dialog = screen.getByRole('dialog');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Confirm' }));
  return { opener, dialog, pending };
}

describe('Modal overlay focus restoration', () => {
  it.each([false, true])('restores the opener after the backdrop mousedown default (unmount: %s)', (unmountOnClose) => {
    const onClose = vi.fn();
    wrap(<ModalPage onClose={onClose} unmountOnClose={unmountOnClose} />);
    const { opener, backdrop } = openModal();

    const event = pressBackdrop(backdrop);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement, 'overlay dismissal must retain opener focus after the mousedown default').toBe(opener);
    expect(event.defaultPrevented).toBe(true);
  });

  it('restores the explicit restoreFocus target after the backdrop mousedown default', () => {
    const onClose = vi.fn();
    wrap(<ModalPage onClose={onClose} restoreFocus />);
    const { backdrop } = openModal();
    const target = screen.getByRole('button', { name: 'Restore target' });

    const event = pressBackdrop(backdrop);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement, 'overlay dismissal must retain restoreFocus after the mousedown default').toBe(target);
    expect(event.defaultPrevented).toBe(true);
  });

  it('cancels useConfirm and restores its opener after the backdrop mousedown default', async () => {
    const { opener, dialog, pending } = openConfirm();

    const event = pressBackdrop(backdropFor(dialog));

    expect(await pending).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement, 'useConfirm overlay dismissal must retain opener focus after the mousedown default').toBe(opener);
    expect(event.defaultPrevented).toBe(true);
  });

  it.each(['dialog', 'text'])('keeps the modal open when a press starts on %s and releases on the backdrop', (start) => {
    const onClose = vi.fn();
    wrap(<ModalPage onClose={onClose} />);
    const { dialog, backdrop } = openModal();
    const target = start === 'dialog' ? dialog : screen.getByText('Selectable dialog text');
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });

    fireEvent(target, event);
    fireEvent.mouseUp(backdrop);
    // A drag from a descendant can synthesize click on their common ancestor.
    fireEvent.click(backdrop);

    expect(event.target).toBe(target);
    expect(event.defaultPrevented).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBe(dialog);
  });

  it('ignores backdrop presses when the modal is not dismissable', () => {
    const onClose = vi.fn();
    wrap(<ModalPage onClose={onClose} dismissable={false} />);
    const { dialog, backdrop } = openModal();

    const event = pressBackdrop(backdrop);

    expect(event.target).toBe(backdrop);
    expect(event.defaultPrevented).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBe(dialog);
  });

  it('closes only the nested modal and restores focus into the outer dialog', () => {
    const onOuterClose = vi.fn();
    const onInnerClose = vi.fn();
    function NestedModals() {
      const [outerOpen, setOuterOpen] = useState(false);
      const [innerOpen, setInnerOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOuterOpen(true)}>Open outer</button>
          <Modal open={outerOpen} title="Outer modal" onClose={() => { onOuterClose(); setOuterOpen(false); }}>
            <button onClick={() => setInnerOpen(true)}>Open inner</button>
            <Modal open={innerOpen} title="Inner modal" onClose={() => { onInnerClose(); setInnerOpen(false); }}>
              <button>Inner control</button>
            </Modal>
          </Modal>
        </>
      );
    }
    wrap(<NestedModals />);
    const outerOpener = screen.getByRole('button', { name: 'Open outer' });
    outerOpener.focus();
    fireEvent.click(outerOpener);
    const outerDialog = screen.getByRole('dialog', { name: 'Outer modal' });
    const innerOpener = screen.getByRole('button', { name: 'Open inner' });
    expect(document.activeElement).toBe(innerOpener);
    fireEvent.click(innerOpener);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Inner control' }));

    const event = pressBackdrop(backdropFor(screen.getByRole('dialog', { name: 'Inner modal' })));

    expect(onInnerClose).toHaveBeenCalledTimes(1);
    expect(onOuterClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Inner modal' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Outer modal' })).toBe(outerDialog);
    expect(document.activeElement, 'inner overlay dismissal must retain focus in the outer dialog').toBe(innerOpener);
    expect(event.defaultPrevented).toBe(true);
  });

  it.each(['Close', 'Confirm'])('restores useConfirm opener focus after %s', async (name) => {
    const { opener, pending } = openConfirm();

    fireEvent.click(screen.getByRole('button', { name }));

    expect(await pending).toBe(name === 'Confirm');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
