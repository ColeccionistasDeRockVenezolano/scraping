// CRV · Avisos breves. Algunos traen una acción: una corrección individual
// deja «Deshacer» a la vista durante 30 s (PLAN_CURADURIA E8.4), para no
// obligar a buscar el lote en el historial por un cambio que se acaba de
// hacer. El resto caduca a los 4,5 s.
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

/** Acción opcional de un aviso: un botón junto al texto. */
export interface ToastAction {
  label: string;
  onAction: () => void | Promise<void>;
}

interface ToastOptions {
  action?: ToastAction;
  /** Cuánto dura a la vista; los avisos con acción necesitan más tiempo. */
  durationMs?: number;
}

interface Toast {
  id: number;
  kind: "success" | "error" | "info";
  message: string;
  action?: ToastAction;
}

interface ToastContextValue {
  notify: (kind: Toast["kind"], message: string, options?: ToastOptions) => void;
}

const DEFAULT_MS = 4500;
/** Lo que dura «Deshacer» en pantalla (E8.4). */
export const UNDO_TOAST_MS = 30_000;

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((prev) => prev.filter((toast) => toast.id !== id)), []);

  const notify = useCallback((kind: Toast["kind"], message: string, options?: ToastOptions) => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, kind, message, ...(options?.action ? { action: options.action } : {}) }]);
    window.setTimeout(() => dismiss(id), options?.durationMs ?? (options?.action ? UNDO_TOAST_MS : DEFAULT_MS));
  }, [dismiss]);

  return (
    <ToastContext.Provider value={{ notify }}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast--${toast.kind}`}>
            <span className="toast__text">{toast.message}</span>
            {toast.action ? (
              <button
                type="button" className="toast__action"
                onClick={() => { dismiss(toast.id); void toast.action?.onAction(); }}
              >
                {toast.action.label}
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
