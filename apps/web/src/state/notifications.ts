/**
 * In-app toasts. Shown on every platform (OS notifications are a separate
 * channel). Reminder toasts stay until acted on; others time out.
 */
import { create } from 'zustand';

export type ToastTone = 'info' | 'success' | 'error' | 'warning' | 'reminder' | 'memory';

export interface ToastAction {
  label: string;
  onClick: () => void | Promise<void>;
  primary?: boolean;
}

export interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  body?: string;
  icon?: string;
  actions?: ToastAction[];
  /** ms; null = until dismissed. */
  duration: number | null;
  /** Toasts with the same key replace each other (e.g. one per reminder). */
  key?: string;
  createdAt: number;
}

export interface ToastInput {
  tone?: ToastTone;
  title: string;
  body?: string;
  icon?: string;
  actions?: ToastAction[];
  duration?: number | null;
  key?: string;
}

const MAX_TOASTS = 4;
let counter = 0;

export const useToasts = create<{ toasts: Toast[] }>(() => ({ toasts: [] }));

export function pushToast(input: ToastInput): string {
  const tone = input.tone ?? 'info';
  const toast: Toast = {
    id: `toast_${++counter}`,
    tone,
    title: input.title,
    body: input.body,
    icon: input.icon,
    actions: input.actions,
    duration: input.duration !== undefined ? input.duration : tone === 'reminder' ? null : tone === 'error' ? 7000 : 4500,
    key: input.key,
    createdAt: Date.now(),
  };
  useToasts.setState((s) => {
    const rest = toast.key ? s.toasts.filter((t) => t.key !== toast.key) : s.toasts;
    // Drop the oldest dismissable toasts first when there are too many.
    const next = [...rest, toast];
    while (next.length > MAX_TOASTS) {
      const i = next.findIndex((t) => t.duration !== null);
      next.splice(i >= 0 ? i : 0, 1);
    }
    return { toasts: next };
  });
  return toast.id;
}

export function dismissToast(id: string): void {
  useToasts.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

export function dismissToastKey(key: string): void {
  useToasts.setState((s) => ({ toasts: s.toasts.filter((t) => t.key !== key) }));
}
