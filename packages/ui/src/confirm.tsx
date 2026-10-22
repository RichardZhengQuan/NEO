/**
 * Promise-based confirmation dialogs.
 *
 * `useConfirm()` returns `confirm(options) → Promise<boolean>`. Inside a
 * <ConfirmProvider> it shows a styled modal; without one it falls back to the
 * browser's `window.confirm` so components keep working anywhere.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Badge, Button, Modal, type Tone } from './primitives.js';
import { useT } from './i18n.js';

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive action: the confirm button is red. */
  danger?: boolean;
  /** A badge next to the message, e.g. the risk of a tool action. */
  badge?: { label: string; tone?: Tone };
  /** A small muted line under the message (e.g. the tool's name). */
  detail?: string;
}

export type ConfirmFn = (options: ConfirmOptions | string) => Promise<boolean>;

const fallbackConfirm: ConfirmFn = async (options) => {
  const message = typeof options === 'string' ? options : [options.title, options.message].filter(Boolean).join('\n\n');
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
  try {
    return window.confirm(message);
  } catch {
    return false;
  }
};

const ConfirmContext = createContext<ConfirmFn>(fallbackConfirm);

export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext);
}

interface Pending extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }): ReactElement {
  const t = useT();
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  // Capture the focused element before the dialog opens so Modal can restore
  // it on close. We must read this before setPending() triggers a render that
  // mounts the Modal (which applies autoFocus during commit, before effects).
  const openerRef = useRef<HTMLElement | null>(null);

  const confirm = useCallback<ConfirmFn>((options) => {
    const opts = typeof options === 'string' ? { message: options } : options;
    return new Promise<boolean>((resolve) => {
      // A new request supersedes an open one (which counts as cancelled).
      pendingRef.current?.resolve(false);
      // Capture the opener before the dialog mounts; autoFocus on the confirm
      // button runs during React's commit phase (before any effects), so
      // document.activeElement inside Modal's useEffect would be the button.
      openerRef.current = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
      const next = { ...opts, resolve };
      pendingRef.current = next;
      setPending(next);
    });
  }, []);

  const settle = (ok: boolean) => {
    pendingRef.current?.resolve(ok);
    pendingRef.current = null;
    openerRef.current = null;
    setPending(null);
  };

  const value = useMemo(() => confirm, [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <Modal
        open={pending !== null}
        onClose={() => settle(false)}
        title={pending?.title ?? t('common.are_you_sure')}
        size="sm"
        initialFocus="[data-confirm-default] button"
        restoreFocus={openerRef.current}
        footer={
          <>
            <Button variant="ghost" onClick={() => settle(false)}>
              {pending?.cancelLabel ?? t('common.cancel')}
            </Button>
            <span data-confirm-default="" style={{ display: 'contents' }}>
              <Button variant={pending?.danger ? 'danger' : 'primary'} onClick={() => settle(true)} autoFocus>
                {pending?.confirmLabel ?? t('common.confirm')}
              </Button>
            </span>
          </>
        }
      >
        {pending?.badge && (
          <div style={{ marginBottom: '0.5rem' }}>
            <Badge tone={pending.badge.tone ?? 'neutral'}>{pending.badge.label}</Badge>
          </div>
        )}
        <p style={{ margin: 0, fontSize: '0.9375rem', lineHeight: 1.55, color: pending?.badge ? 'var(--neo-text)' : 'var(--neo-text-muted)' }}>{pending?.message}</p>
        {pending?.detail && (
          <p style={{ margin: '0.5rem 0 0', fontSize: '0.75rem', color: 'var(--neo-text-subtle)', fontFamily: 'var(--neo-font-mono)' }}>{pending.detail}</p>
        )}
      </Modal>
    </ConfirmContext.Provider>
  );
}
