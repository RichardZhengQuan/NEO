/**
 * Toast stack. Timed toasts pause while hovered or focused; reminder toasts
 * stay until acted on. Announced politely to screen readers.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Button, Icon, IconButton, useT } from '@neo/ui';
import { dismissToast, useToasts, type Toast } from '../state/notifications.js';

const TONE_ICON: Record<Toast['tone'], string> = {
  info: 'info',
  success: 'check-circle',
  error: 'alert-circle',
  warning: 'alert-triangle',
  reminder: 'bell-ring',
  memory: 'brain',
};

function ToastView({ toast }: { toast: Toast }): ReactElement {
  const t = useT();
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const remaining = useRef(toast.duration ?? 0);
  const started = useRef(Date.now());

  useEffect(() => {
    if (toast.duration === null || paused) return;
    started.current = Date.now();
    const id = setTimeout(() => dismissToast(toast.id), remaining.current);
    return () => {
      clearTimeout(id);
      remaining.current = Math.max(800, remaining.current - (Date.now() - started.current));
    };
  }, [paused, toast.duration, toast.id]);

  return (
    <div
      className="toast"
      data-tone={toast.tone}
      role={toast.tone === 'error' ? 'alert' : 'status'}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="toast__icon">
        <Icon name={toast.icon ?? TONE_ICON[toast.tone]} size={17} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p className="toast__title">{toast.title}</p>
        {toast.body && <p className="toast__body">{toast.body}</p>}
        {toast.actions && toast.actions.length > 0 && (
          <div className="toast__actions">
            {toast.actions.map((a, i) => (
              <Button
                key={i}
                size="sm"
                variant={a.primary ? 'primary' : 'secondary'}
                loading={busy === i}
                disabled={busy !== null}
                onClick={() => {
                  setBusy(i);
                  void Promise.resolve(a.onClick()).finally(() => {
                    setBusy(null);
                    dismissToast(toast.id);
                  });
                }}
              >
                {a.label}
              </Button>
            ))}
          </div>
        )}
      </div>
      <IconButton icon="x" label={t('common.dismiss')} size="sm" onClick={() => dismissToast(toast.id)} />
    </div>
  );
}

export function Toaster(): ReactElement {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div className="toaster" aria-live="polite" aria-relevant="additions">
      {toasts.map((toast) => (
        <ToastView key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
