/**
 * ConfirmProvider: focus-restoration regression test.
 *
 * Verifies that after a confirm dialog closes (via Escape or Cancel), focus
 * returns to the element that called confirm() — not to document.body.
 *
 * Before the fix, Modal captured document.activeElement in a plain useEffect
 * which ran after React's commit phase. React's autoFocus on the confirm button
 * fires during commit, so document.activeElement was already the button inside
 * the dialog, not the original opener. On close, Modal tried to focus an
 * already-unmounted element, so focus fell to document.body.
 *
 * The fix: ConfirmProvider captures document.activeElement immediately in the
 * confirm() callback (before setPending triggers the render that mounts the
 * dialog), then passes it to Modal via the restoreFocus prop.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { type ReactElement } from 'react';
import { I18nProvider } from './i18n.js';
import { ConfirmProvider, useConfirm } from './confirm.js';

afterEach(cleanup);

function wrap(ui: ReactElement) {
  return render(<I18nProvider locale="en">{ui}</I18nProvider>);
}

/** A minimal page that exposes a trigger button wired to useConfirm(). */
function Page() {
  const confirm = useConfirm();
  return (
    <button
      onClick={() => {
        void confirm({ message: 'Are you sure?' });
      }}
    >
      Delete
    </button>
  );
}

describe('ConfirmProvider focus restoration', () => {
  it('restores focus to the trigger after Escape closes the dialog', async () => {
    wrap(
      <ConfirmProvider>
        <Page />
      </ConfirmProvider>,
    );

    const trigger = screen.getByRole('button', { name: 'Delete' });

    // Give focus to the trigger and open the dialog.
    await act(async () => {
      trigger.focus();
      trigger.click();
    });

    // The dialog should be open — wait for the confirm button to appear.
    const confirmBtn = await screen.findByRole('button', { name: /confirm/i });
    expect(document.activeElement).toBe(confirmBtn);

    // Close via Escape.
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape', bubbles: true });
      // Flush microtasks so the promise settles and state updates propagate.
      await Promise.resolve();
    });

    // Focus must have returned to the original trigger, not document.body.
    expect(document.activeElement).toBe(trigger);
  });

  it('restores focus to the trigger after Cancel is clicked', async () => {
    wrap(
      <ConfirmProvider>
        <Page />
      </ConfirmProvider>,
    );

    const trigger = screen.getByRole('button', { name: 'Delete' });

    await act(async () => {
      trigger.focus();
      trigger.click();
    });

    const cancelBtn = await screen.findByRole('button', { name: /cancel/i });

    await act(async () => {
      cancelBtn.click();
      await Promise.resolve();
    });

    expect(document.activeElement).toBe(trigger);
  });
});
