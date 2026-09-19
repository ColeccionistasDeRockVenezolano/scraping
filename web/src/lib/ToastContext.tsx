import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

interface Toast {
  id: number;
  kind: "success" | "error" | "info";
  message: string;
  actionLabel?: string;
  onAction?: () => void | Promise<void>;
}

interface ToastOptions {
  durationMs?: number;
  actionLabel?: string;
  onAction?: () => void | Promise<void>;
}

interface ToastContextValue {
  notify: (kind: Toast["kind"], message: string, options?: ToastOptions) => void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const notify = useCallback((kind: Toast["kind"], message: string, options: ToastOptions = {}) => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, {
      id, kind, message,
      ...(options.actionLabel ? { actionLabel: options.actionLabel } : {}),
      ...(options.onAction ? { onAction: options.onAction } : {}),
    }]);
    window.setTimeout(
      () => setToasts((prev) => prev.filter((toast) => toast.id !== id)),
      options.durationMs ?? 4500,
    );
  }, []);

  return (
    <ToastContext.Provider value={{ notify }}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast--${toast.kind}`}>
            <span>{toast.message}</span>
            {toast.actionLabel && toast.onAction ? (
              <button type="button" className="toast__action" onClick={() => {
                void toast.onAction?.();
                setToasts((prev) => prev.filter((item) => item.id !== toast.id));
              }}>
                {toast.actionLabel}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast debe usarse dentro de ToastProvider");
  return ctx;
}
