export function LoadingState({ label = "Cargando…" }: { label?: string }) {
  return (
    <div className="state-block" role="status">
      <div className="spinner" />
      <p>{label}</p>
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string | undefined }) {
  return (
    <div className="state-block">
      <MagnifyingGlass className="icon" aria-hidden="true" />
      <h3>{title}</h3>
      {hint ? <p>{hint}</p> : null}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state-block is-error" role="alert">
      <WarningCircle className="icon" aria-hidden="true" weight="bold" />
      <h3>No se pudo cargar</h3>
      <p>{message}</p>
      {onRetry ? (
        <div style={{ marginTop: 14 }}>
          <button type="button" className="btn btn--sm" onClick={onRetry}>Reintentar</button>
        </div>
      ) : null}
    </div>
  );
}
import { MagnifyingGlass, WarningCircle } from "@phosphor-icons/react";
