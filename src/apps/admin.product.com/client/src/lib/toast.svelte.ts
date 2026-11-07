/**
 * Lightweight toast store for the admin SPA.
 *
 * Toasts are added via `toast.success`, `toast.error`, or `toast.info` and
 * auto-dismiss after a timeout. The `<Toast />` component renders the queue.
 */
export type ToastKind = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

// Exported state container: we mutate `.items` rather than reassigning,
// which is the only shared-state pattern Svelte 5 allows across modules.
export const toasts = $state<{ items: Toast[] }>({ items: [] });

let counter = 0;

export function pushToast(kind: ToastKind, message: string, timeout = 4000): number {
  const id = ++counter;
  toasts.items = [...toasts.items, { id, kind, message }];
  if (timeout > 0) {
    setTimeout(() => dismissToast(id), timeout);
  }
  return id;
}

export function dismissToast(id: number): void {
  toasts.items = toasts.items.filter((t) => t.id !== id);
}

export const toast = {
  success: (message: string, timeout?: number) => pushToast('success', message, timeout),
  error: (message: string, timeout?: number) => pushToast('error', message, timeout),
  info: (message: string, timeout?: number) => pushToast('info', message, timeout),
};
