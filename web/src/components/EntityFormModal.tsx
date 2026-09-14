import { useState } from "react";
import { Modal } from "./Modal";
import { FormFields, type FieldConfig, type FieldValue } from "./FormFields";
import { ApiError } from "../lib/api";
import type { EntityWriteResult } from "../lib/types";

interface EntityFormModalProps {
  title: string;
  fields: readonly FieldConfig[];
  initialValues: Record<string, FieldValue>;
  extraFields?: React.ReactNode;
  submitLabel?: string;
  onSubmit: (values: Record<string, FieldValue>, note: string) => Promise<EntityWriteResult>;
  onSuccess: (result: EntityWriteResult) => void;
  onClose: () => void;
  wide?: boolean;
}

export function EntityFormModal({
  title, fields, initialValues, extraFields, submitLabel = "Guardar", onSubmit, onSuccess, onClose, wide,
}: EntityFormModalProps) {
  const [values, setValues] = useState<Record<string, FieldValue>>(initialValues);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  function handleChange(key: string, value: FieldValue) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!note.trim()) { setError("El motivo es obligatorio: queda en la auditoría."); return; }
    setBusy(true);
    setError(undefined);
    try {
      const result = await onSubmit(values, note.trim());
      onSuccess(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo guardar.");
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose} {...(wide === undefined ? {} : { wide })}>
      <form onSubmit={handleSubmit}>
        {error ? <p className="form-error-banner">{error}</p> : null}
        {extraFields}
        <FormFields fields={fields} values={values} onChange={handleChange} />
        <div className="field span-2" style={{ marginTop: 14 }}>
          <label htmlFor="entity-note">Motivo *</label>
          <textarea id="entity-note" rows={2} value={note} onChange={(event) => setNote(event.target.value)}
            placeholder="Por qué se hace este cambio" />
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancelar</button>
          <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? "Guardando…" : submitLabel}</button>
        </div>
      </form>
    </Modal>
  );
}
