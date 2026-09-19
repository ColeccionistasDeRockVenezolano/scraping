// CRV · E7: vista previa de conflictos que pueden decidirse por trust_level.
import { useEffect, useState } from "react";
import { ApiError, curationApi, type CurationFindingGroupFilter } from "../lib/api";
import type { TrustedConflictPreview } from "../lib/types";
import { Modal } from "./Modal";

export function TrustedConflictDialog({ filter, onDone, onClose }: {
  filter: CurationFindingGroupFilter;
  onDone: () => void;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<TrustedConflictPreview | null>(null);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [note, setNote] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ applied: number; skippedStale: number; failed: number; remaining: number }>();

  useEffect(() => {
    let active = true;
    setBusy(true);
    curationApi.trustedConflictsPreview(filter)
      .then((next) => { if (active) setPreview(next); })
      .catch((err) => { if (active) setError(err instanceof ApiError ? err.message : "No se pudo calcular la vista previa."); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [filter]);

  async function apply() {
    if (!preview || !note.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await curationApi.trustedConflictsApply(filter, {
        previewHash: preview.previewHash,
        ...(excluded.size ? { excludeConflictIds: [...excluded] } : {}),
        note: note.trim(),
      });
      setResult(next);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo aplicar la decisión por confianza.");
    } finally {
      setBusy(false);
    }
  }

  const included = preview?.items.filter((item) => item.eligible && item.conflictId !== null && !excluded.has(item.conflictId)).length ?? 0;

  return (
    <Modal title="Resolver por fuente de mayor confianza" onClose={onClose} wide>
      <p className="dialog-lead">
        Solo se proponen conflictos donde una fuente tiene un <code>trust_level</code> estrictamente mayor.
        Los empates quedan abiertos para decisión individual.
      </p>
      {busy && !preview ? <p role="status">Calculando vista previa…</p> : null}
      {error ? <p className="form-error-banner" role="alert">{error}</p> : null}
      {preview ? (
        <>
          <p aria-live="polite">
            {preview.eligible} elegibles · {preview.ties} empates · {preview.unavailable} no disponibles
            {preview.truncated ? " · vista previa limitada; se puede continuar después" : ""}
          </p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Incluir</th><th>Conflicto</th><th>Fuente A</th><th>Fuente B</th><th>Decisión</th></tr></thead>
              <tbody>
                {preview.items.map((item) => (
                  <tr key={item.findingId}>
                    <td>
                      <input
                        type="checkbox"
                        checked={item.conflictId !== null && item.eligible && !excluded.has(item.conflictId)}
                        disabled={!item.eligible || item.conflictId === null}
                        onChange={() => {
                          if (item.conflictId === null) return;
                          setExcluded((current) => {
                            const next = new Set(current);
                            if (next.has(item.conflictId!)) next.delete(item.conflictId!); else next.add(item.conflictId!);
                            return next;
                          });
                        }}
                        aria-label={`Incluir ${item.title}`}
                      />
                    </td>
                    <td>{item.title}</td>
                    <td>
                      {item.claimA ? (
                        <>
                          {item.claimA.sourceName}<br />
                          <span className="badge badge--outline">{item.claimA.sourceTrustLevel}</span>
                        </>
                      ) : "—"}
                    </td>
                    <td>
                      {item.claimB ? (
                        <>
                          {item.claimB.sourceName}<br />
                          <span className="badge badge--outline">{item.claimB.sourceTrustLevel}</span>
                        </>
                      ) : "—"}
                    </td>
                    <td>{item.eligible ? `Elegir ${item.chosen?.toUpperCase()}` : item.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!result ? (
            <>
              <div className="field">
                <label htmlFor="trust-conflict-note">Motivo *</label>
                <textarea
                  id="trust-conflict-note" rows={2} value={note} onChange={(event) => setNote(event.target.value)}
                  placeholder="Por qué este grupo puede resolverse por la confianza de las fuentes"
                />
              </div>
              <div className="form-actions">
                <button className="btn" type="button" onClick={onClose} disabled={busy}>Cancelar</button>
                <button className="btn btn--primary" type="button" onClick={() => void apply()} disabled={busy || !note.trim() || included === 0}>
                  {busy ? "Aplicando…" : `Aplicar ${included} decisiones`}
                </button>
              </div>
            </>
          ) : (
            <div className="alert-block" role="status">
              Aplicados: {result.applied} · obsoletos: {result.skippedStale} · fallidos: {result.failed} · pendientes: {result.remaining}
            </div>
          )}
        </>
      ) : null}
    </Modal>
  );
}
