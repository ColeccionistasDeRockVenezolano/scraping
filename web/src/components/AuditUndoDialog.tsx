// CRV · Deshacer UNA decisión del historial: una fusión o una conversión de
// las de antes del diario (22-09-2026), cuando un solo proceso podía fusionar
// cientos de fichas y deshacerlo entero no tendría sentido.
//
// La vista previa la calcula el backend haciendo el deshacer de verdad y
// volviendo atrás (GET /audit/:id/undo), así que lo que dice aquí es
// exactamente lo que pasará al confirmar.
import { useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, auditApi, CATALOG_CHANGE_EVENT, CATALOG_DATA_CHANGED_EVENT } from "../lib/api";
import { entityHref, kindLabel } from "../lib/changes";
import { relativeTime } from "../lib/curation";
import { useAsync } from "../lib/useAsync";
import { useToast } from "../lib/ToastContext";
import type { CatalogChangeEvent } from "../lib/api";
import { Modal } from "./Modal";

export function AuditUndoDialog({ auditId, onClose }: { auditId: number; onClose: () => void }) {
  const { notify } = useToast();
  const { data, loading, error, reload } = useAsync(() => auditApi.undoPreview(auditId), [auditId]);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();

  const what = data?.kind === "absorption" ? "conversión" : "fusión";
  const restored = data
    ? `${kindLabel(data.restores.kind)}: ${data.restores.label ?? data.restores.id}`
    : "";
  const href = data ? entityHref(data.restores.kind, data.restores.id) : null;

  async function confirm() {
    if (!data) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      const result = await auditApi.undoEntry(auditId, note.trim());
      notify("success", `Deshecha la ${what} (cambio #${result.runId}). Puedes rehacerla desde la barra o el Historial.`);
      // Igual que cualquier escritura: la barra «Deshacer» queda a la vista y
      // las listas abiertas se recargan.
      window.dispatchEvent(new CustomEvent<CatalogChangeEvent>(CATALOG_CHANGE_EVENT, {
        detail: { runId: result.runId, method: "POST", path: `/audit/${auditId}/undo` },
      }));
      window.dispatchEvent(new Event(CATALOG_DATA_CHANGED_EVENT));
      onClose();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "No se pudo deshacer.");
      reload();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={data ? `Deshacer esta ${what}` : "Deshacer del historial"} onClose={onClose} sheet>
      {loading && !data ? (
        <p className="hint">Calculando qué haría…</p>
      ) : error || !data ? (
        <p className="form-error-banner" role="alert">{error ?? "No se encontró ese cambio del historial."}</p>
      ) : (
        <>
          <div className="undo-dialog__what">
            <strong>{restored}</strong>
            <span className="hint">
              {data.runId !== null ? `cambio #${data.runId} · ` : ""}
              <span title={new Date(data.at).toLocaleString("es-VE")}>{relativeTime(data.at)}</span>
            </span>
            {data.reason ? <span className="undo-dialog__note">«{data.reason}»</span> : null}
          </div>

          {data.undoable ? (
            <p>
              {data.kind === "absorption"
                ? "La persona vuelve al catálogo con sus créditos, su alias en la otra ficha se retira y sus datos dejan de estar rechazados: "
                : "La ficha vuelve al catálogo con todo lo que la fusión le quitó: "}
              {href ? <Link to={href} onClick={onClose}>{restored}</Link> : restored}.
            </p>
          ) : (
            <div className="form-error-banner" role="alert">
              <p style={{ margin: 0 }}>{data.reasonNot ?? "No se puede deshacer."}</p>
            </div>
          )}

          {data.undoable ? (
            <div className="field" style={{ marginTop: 14 }}>
              <label htmlFor="audit-undo-note">Motivo *</label>
              <textarea
                id="audit-undo-note" rows={2} value={note} onChange={(event) => setNote(event.target.value)}
                placeholder={`Por qué se deshace esta ${what}`}
              />
            </div>
          ) : null}
          {saveError ? <p className="form-error-banner" role="alert">{saveError}</p> : null}
          <div className="form-actions">
            <button type="button" className="btn btn--ghost" onClick={onClose}>Cerrar</button>
            {data.undoable ? (
              <button type="button" className="btn btn--danger" onClick={() => void confirm()} disabled={saving || !note.trim()}>
                {saving ? "Deshaciendo…" : `Deshacer esta ${what}`}
              </button>
            ) : null}
          </div>
        </>
      )}
    </Modal>
  );
}
