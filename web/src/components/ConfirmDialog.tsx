import { useState } from "react";
import { Modal } from "./Modal";

interface ConfirmDialogProps {
  title: string;
  description: string;
  confirmLabel?: string;
  danger?: boolean;
  requireNote?: boolean;
  onConfirm: (note: string) => Promise<void> | void;
  onClose: () => void;
}

/** Confirmación con motivo obligatorio: toda escritura del operador exige nota (src/api/auth.ts). */
export function ConfirmDialog({ title, description, confirmLabel = "Confirmar", danger, requireNote = true, onConfirm, onClose }: ConfirmDialogProps) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function handleConfirm() {
    if (requireNote && !note.trim()) { setError("La nota es obligatoria."); return; }
    setBusy(true);
    setError(undefined);
    try {
      await onConfirm(note.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo completar la acción.");
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <p style={{ color: "var(--text-muted)", fontSize: 13.5, margin: "0 0 14px" }}>{description}</p>
      {requireNote ? (
        <div className="field">
          <label htmlFor="confirm-note">Motivo *</label>
          <textarea id="confirm-note" value={note} onChange={(event) => setNote(event.target.value)} rows={3} autoFocus
            placeholder="Por qué se hace este cambio (queda en la auditoría)" />
        </div>
      ) : null}
      {error ? <p className="form-error-banner" style={{ marginTop: 12 }}>{error}</p> : null}
      <div className="form-actions">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancelar</button>
        <button type="button" className={danger ? "btn btn--danger" : "btn btn--primary"} onClick={handleConfirm} disabled={busy}>
          {busy ? "Guardando…" : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
