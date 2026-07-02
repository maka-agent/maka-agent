// packages/ui/src/toast.tsx
//
// In-app toast notification system + Promise-returning confirm dialog. Both
// share a single context so a feature flow can chain them — e.g. ask for
// confirmation, then surface a toast with an Undo action.
//
// Why we don't keep using `window.confirm` / `window.alert` / `window.prompt`:
//   - Native dialogs block the renderer's event loop and can't be themed.
//   - The look-and-feel never matches the rest of the app.
//   - macOS IME and accessibility behavior with native prompts is uneven.
//
// Toast lifecycle is intentionally tiny: in-memory state and a 4s auto-dismiss
// timer, cancellable from the toast itself.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from './icons.js';
import { useModalA11y } from './modal-a11y.js';
import { Button } from './ui.js';

export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

export interface ToastAction {
  label: string;
  onClick(): void;
}

export interface ToastInput {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** Auto-dismiss after this many ms. 0 disables the timer. Default 4000. */
  duration?: number;
  action?: ToastAction;
}

export interface ConfirmInput {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

export interface ToastApi {
  toast(input: ToastInput): string;
  success(title: string, description?: string): string;
  error(title: string, description?: string): string;
  info(title: string, description?: string): string;
  warning(title: string, description?: string): string;
  confirm(input: ConfirmInput): Promise<boolean>;
  dismiss(id: string): void;
}

interface InternalToast extends Required<Pick<ToastInput, 'title' | 'variant' | 'duration'>> {
  id: string;
  description?: string;
  action?: ToastAction;
}

interface PendingConfirm extends ConfirmInput {
  resolve(result: boolean): void;
}

const DEFAULT_DURATION = 4000;
const TOAST_POSITION = 'bottom-right';
const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider(props: { children: ReactNode }) {
  const [toasts, setToasts] = useState<InternalToast[]>([]);
  const [confirmState, setConfirmState] = useState<PendingConfirm | null>(null);
  const activeConfirmRef = useRef<PendingConfirm | null>(null);
  const confirmQueueRef = useRef<PendingConfirm[]>([]);
  const idSeed = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((entry) => entry.id !== id));
  }, []);

  const push = useCallback(
    (input: ToastInput): string => {
      const id = `t${++idSeed.current}`;
      const entry: InternalToast = {
        id,
        title: input.title,
        description: input.description,
        variant: input.variant ?? 'info',
        duration: input.duration ?? DEFAULT_DURATION,
        action: input.action,
      };
      setToasts((prev) => [...prev, entry]);
      if (entry.duration > 0) {
        window.setTimeout(() => dismiss(id), entry.duration);
      }
      return id;
    },
    [dismiss],
  );

  const confirm = useCallback((input: ConfirmInput): Promise<boolean> => {
    return new Promise((resolve) => {
      const request: PendingConfirm = { ...input, resolve };
      if (activeConfirmRef.current) {
        confirmQueueRef.current.push(request);
        return;
      }
      activeConfirmRef.current = request;
      setConfirmState(request);
    });
  }, []);

  const resolveConfirm = useCallback(
    (result: boolean) => {
      const current = activeConfirmRef.current;
      if (!current) return;
      activeConfirmRef.current = null;
      current.resolve(result);
      const next = confirmQueueRef.current.shift() ?? null;
      activeConfirmRef.current = next;
      setConfirmState(next);
    },
    [],
  );

  useEffect(() => {
    return () => {
      activeConfirmRef.current?.resolve(false);
      activeConfirmRef.current = null;
      for (const pending of confirmQueueRef.current) {
        pending.resolve(false);
      }
      confirmQueueRef.current = [];
    };
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      toast: push,
      success: (title, description) => push({ title, description, variant: 'success' }),
      error: (title, description) => push({ title, description, variant: 'error', duration: 6000 }),
      info: (title, description) => push({ title, description, variant: 'info' }),
      warning: (title, description) => push({ title, description, variant: 'warning' }),
      confirm,
      dismiss,
    }),
    [push, confirm, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {props.children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
      {confirmState && (
        <ConfirmDialog request={confirmState} onResolve={resolveConfirm} />
      )}
    </ToastContext.Provider>
  );
}

/**
 * Read the toast API from context. Throws when called outside a provider so
 * we don't silently swallow notifications during refactors.
 */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside a <ToastProvider>');
  return ctx;
}

const VARIANT_ICON: Record<ToastVariant, ReactNode> = {
  info: <Info size={16} strokeWidth={1.75} aria-hidden="true" />,
  success: <CheckCircle2 size={16} strokeWidth={1.75} aria-hidden="true" />,
  warning: <AlertTriangle size={16} strokeWidth={1.75} aria-hidden="true" />,
  error: <AlertCircle size={16} strokeWidth={1.75} aria-hidden="true" />,
};

function ToastViewport(props: { toasts: InternalToast[]; onDismiss(id: string): void }) {
  if (props.toasts.length === 0) return null;
  return (
    <ol
      className="maka-toast-viewport"
      data-position={TOAST_POSITION}
      role="region"
      aria-live="polite"
      aria-label="通知"
    >
      {props.toasts.map((entry) => (
        // role="alert" lets screen readers announce each toast even
        // though the parent <ol> already has aria-live="polite" —
        // browsers / AT pairings handle the live region announce
        // better when the live items themselves carry an alert
        // role rather than relying on the region inheritance.
        <li key={entry.id} className="maka-toast" data-variant={entry.variant} role="alert">
          <span className="maka-toast-icon" aria-hidden="true">{VARIANT_ICON[entry.variant]}</span>
          <div className="maka-toast-copy">
            <strong>{entry.title}</strong>
            {entry.description && <small>{entry.description}</small>}
          </div>
          {entry.action && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="maka-toast-action"
              onClick={() => {
                entry.action!.onClick();
                props.onDismiss(entry.id);
              }}
            >
              {entry.action.label}
            </Button>
          )}
          <Button
            type="button"
            variant="quiet"
            size="icon-sm"
            className="maka-toast-close"
            aria-label="关闭通知"
            onClick={() => props.onDismiss(entry.id)}
          >
            <X size={14} strokeWidth={1.75} aria-hidden="true" />
          </Button>
        </li>
      ))}
    </ol>
  );
}

function ConfirmDialog(props: { request: PendingConfirm; onResolve(result: boolean): void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useModalA11y(dialogRef, () => props.onResolve(false), cancelRef);
  const {
    title,
    description,
    confirmLabel = '确定',
    cancelLabel = '取消',
    destructive = false,
  } = props.request;

  return (
    <div className="maka-modal-backdrop maka-confirm-backdrop" role="presentation" onClick={() => props.onResolve(false)}>
      <div
        ref={dialogRef}
        className="maka-modal maka-confirm-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="maka-confirm-title"
        aria-describedby={description ? 'maka-confirm-description' : undefined}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="maka-modal-header">
          <h2 className="maka-modal-title" id="maka-confirm-title">{title}</h2>
          {description && (
            <p className="maka-modal-subtitle" id="maka-confirm-description">{description}</p>
          )}
        </div>
        <div className="maka-modal-footer">
          <Button
            ref={cancelRef}
            type="button"
            variant="ghost"
            onClick={() => props.onResolve(false)}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={destructive ? 'destructive' : 'default'}
            onClick={() => props.onResolve(true)}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
