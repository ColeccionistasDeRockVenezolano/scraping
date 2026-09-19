// CRV · Diálogo de un lote de correcciones (E4/E8): todo nace de una vista
// previa y nada se escribe sin revisarla. Fases: previsualización (por ítem:
// acción, antes → después; casillas para excluir), aplicación (con el hash de
// esa vista previa y motivo obligatorio), resultado con recuentos y deshacer.
// Los lotes grandes se continúan con otra llamada igual mientras queden
// pendientes; un 409 `stale_preview` pide volver a previsualizar sin escribir.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, curationApi, type CurationFindingGroupFilter, type CurationFixesPreviewRequest } from "../lib/api";
import { formatCount } from "../lib/curation";
import { useToast } from "../lib/ToastContext";
import { CurationValue } from "./CurationValue";
import { Modal } from "./Modal";
import type { FindingAction, FixBatch, FixItem, FixItemStatus } from "../lib/types";

/** Etiquetas de los recuentos del lote (STATUS_COUNT_KEY del backend). */
const COUNT_LABELS: Readonly<Record<string, string>> = {
  matched: "coinciden", notApplicable: "sin corrección disponible", truncated: "fuera del tope",
  items: "ítems", pending: "pendientes", blocked: "bloqueados", excluded: "excluidos",
  applied: "aplicados", skippedStale: "obsoletos (la ficha cambió)", failed: "fallidos",
  undone: "deshechos", notUndoable: "no reversibles",
};

const ITEM_STATUS_LABEL: Readonly<Record<FixItemStatus, string>> = {
  pending: "Pendiente", blocked: "Bloqueado", excluded: "Excluido", applied: "Aplicado",
  skipped_stale: "Obsoleto (la ficha cambió)", failed: "Falló", undone: "Deshecho", not_undoable: "No reversible",
};

const ITEM_STATUS_BADGE: Readonly<Record<FixItemStatus, string>> = {
  pending: "badge badge--outline", blocked: "badge badge--red", excluded: "badge",
  applied: "badge badge--teal", skipped_stale: "badge badge--yellow", failed: "badge badge--red",
  undone: "badge", not_undoable: "badge badge--outline",
};

function countEntries(counts: Record<string, unknown>): Array<[string, number]> {
  return Object.entries(counts)
    .filter(([key, value]) => typeof value === "number" && key !== "items" && key !== "matched" && key !== "notApplicable" && key !== "truncated")
    .map(([key, value]) => [key, value as number]);
}

function formatItemValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Sí" : "No";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Vista antes → después. El valor detectado conserva el tramo resaltado de CurationValue. */
function BeforeAfter({ item }: { item: FixItem }) {
  if (!item.after) return <span className="hint">—</span>;
  const before = item.before ?? {};
  const changes = Object.entries(item.after).filter(([key, value]) => JSON.stringify(before[key]) !== JSON.stringify(value));
  if (!changes.length) return <span className="hint">—</span>;
  return (
    <div className="fix-diff">
      {changes.map(([key, value]) => {
        const previous = before[key];
        const highlight = typeof previous === "string" && previous === item.finding?.value;
        return (
          <div key={key}>
            <strong>{key}</strong>:{" "}
            {highlight ? <CurationValue value={previous} evidence={item.finding?.evidence ?? {}} /> : formatItemValue(previous)}
            {" → "}<span>{formatItemValue(value)}</span>
          </div>
        );
      })}
    </div>
  );
}

interface FixBatchDialogProps {
  mode: "individual" | "selected" | "group";
  findingIds?: number[];
  filter?: CurationFindingGroupFilter;
  title: string;
  description: string;
  /** Acción concreta elegida desde la tarjeta; sin ella, el backend usa la recomendada. */
  actionKey?: string;
  /** Solo en individual: valor escrito a mano cuando la acción lo admite. */
  valueEditor?: { initial: string; current: string; fieldLabel: string };
  onDone: () => void;
  onClose: () => void;
}

export function FixBatchDialog({ mode, findingIds, filter, title, description, actionKey, valueEditor, onDone, onClose }: FixBatchDialogProps) {
  const { notify } = useToast();
  const [batch, setBatch] = useState<FixBatch | null>(null);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [value, setValue] = useState(valueEditor?.initial ?? "");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string>();
  const [applied, setApplied] = useState(false);
  const [undoBatch, setUndoBatch] = useState<FixBatch | null>(null);
  const [recommended, setRecommended] = useState<string | null>(null);
  const [actionOptions, setActionOptions] = useState<Record<number, FindingAction[]>>({});
  const [byFinding, setByFinding] = useState<Record<string, { actionKey?: string; params?: Record<string, unknown> }>>({});
  const [previewDirty, setPreviewDirty] = useState(false);

  const body = useCallback((): CurationFixesPreviewRequest => ({
    mode,
    ...(findingIds ? { findingIds } : {}),
    ...(filter ? { filter } : {}),
    ...(actionKey ? { actionKey } : {}),
    ...((valueEditor || Object.keys(byFinding).length) ? {
      overrides: {
        ...(valueEditor ? { params: { value: value.trim() } } : {}),
        ...(Object.keys(byFinding).length ? { byFinding } : {}),
      },
    } : {}),
  }), [mode, findingIds, filter, actionKey, valueEditor, value, byFinding]);

  const loadPreview = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    setStale(false);
    setBatch(null);
    setExcluded(new Set());
    try {
      const next = await curationApi.fixesPreview(body());
      setBatch(next);
      setPreviewDirty(false);
      const ids = [...new Set(next.items.flatMap((item) => item.findingId === null ? [] : [item.findingId]))];
      const resolved = await Promise.all(ids.map(async (id) => {
        try {
          return [id, (await curationApi.findingsActions(id)).actions] as const;
        } catch {
          return [id, []] as const;
        }
      }));
      setActionOptions(Object.fromEntries(resolved));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo calcular la vista previa.");
    } finally {
      setLoading(false);
    }
  }, [body]);

  useEffect(() => {
    // Individual con editor de valor espera a «Ver corrección»: la vista
    // previa usa el valor escrito, no el sugerido de partida.
    if (valueEditor && mode === "individual") return;
    void loadPreview();
    // Solo al montar: las siguientes vistas previas son explícitas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleExcluded(itemId: number) {
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId); else next.add(itemId);
      return next;
    });
  }

  useEffect(() => {
    // La acción recomendada del hallazgo se muestra al escribir el valor (E4):
    // es informativa; la vista previa sigue siendo la que manda.
    const findingId = findingIds?.[0];
    if (mode !== "individual" || findingId === undefined) return;
    let active = true;
    curationApi.findingsActions(findingId)
      .then((result) => {
        if (!active) return;
        const action = (actionKey ? result.actions.find((item) => item.key === actionKey) : undefined)
          ?? result.actions.find((item) => item.recommended) ?? result.actions[0];
        setRecommended(action ? `${action.label} · nivel ${action.level}` : null);
      })
      .catch(() => { /* sin acciones: la vista previa lo dirá */ });
    return () => { active = false; };
  }, [mode, findingIds, actionKey]);

  if (valueEditor && mode === "individual" && !batch && !loading) {
    const unchanged = value.trim() === valueEditor.current.trim();
    return (
      <Modal title={title} onClose={onClose}>
        <p className="dialog-lead">{description}</p>
        <p className="hint" style={{ marginBottom: 8 }}>
          Campo: {valueEditor.fieldLabel}{recommended ? ` · Acción: ${recommended}` : ""}
        </p>
        <div className="field">
          <label htmlFor="fixbatch-value">Valor corregido *</label>
          <input id="fixbatch-value" type="text" value={value} onChange={(event) => setValue(event.target.value)} autoFocus />
        </div>
        {error ? <p className="form-error-banner" role="alert">{error}</p> : null}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button type="button" className="btn btn--primary" onClick={() => {
            if (!value.trim()) { setError("El valor no puede quedar vacío."); return; }
            if (unchanged) { setError("El valor debe ser distinto al actual."); return; }
            void loadPreview();
          }}>Ver corrección</button>
        </div>
      </Modal>
    );
  }

  async function apply() {
    if (!batch) return;
    if (!note.trim()) { setError("La nota es obligatoria (queda en la auditoría)."); return; }
    setApplying(true);
    setError(undefined);
    try {
      const result = await curationApi.fixApply(batch.id, {
        previewHash: batch.previewHash,
        ...(excluded.size ? { excludeItemIds: [...excluded] } : {}),
        note: note.trim(),
      });
      setBatch(result);
      setApplied(true);
      onDone();
      if (mode === "individual" && Number(result.counts["applied"] ?? 0) > 0) {
        notify("success", "Corrección aplicada. Puedes deshacerla durante 30 s.", {
          durationMs: 30_000,
          actionLabel: "Deshacer",
          onAction: async () => {
            try {
              const reversed = await curationApi.fixUndo(result.id, `Deshacer inmediato desde Curaduría: ${note.trim()}`);
              setUndoBatch(reversed);
              notify("success", "Corrección deshecha.");
              onDone();
            } catch (undoError) {
              notify("error", undoError instanceof ApiError ? undoError.message : "No se pudo deshacer la corrección.");
            }
          },
        });
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === "stale_preview") {
        setStale(true);
      } else {
        setError(err instanceof ApiError ? err.message : "No se pudo aplicar el lote.");
      }
    } finally {
      setApplying(false);
    }
  }

  async function undo() {
    if (!batch) return;
    if (!note.trim()) { setError("La nota para deshacer es obligatoria."); return; }
    setUndoing(true);
    setError(undefined);
    try {
      const result = await curationApi.fixUndo(batch.id, note.trim());
      setUndoBatch(result);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo deshacer el lote.");
    } finally {
      setUndoing(false);
    }
  }

  const pendingCount = batch ? batch.items.filter((item) => item.status === "pending" && !excluded.has(item.id)).length : 0;
  const finishedCount = batch
    ? Number(batch.counts["applied"] ?? 0) + Number(batch.counts["skippedStale"] ?? 0) + Number(batch.counts["failed"] ?? 0)
    : 0;
  const totalWork = batch ? Math.max(finishedCount + Number(batch.counts["pending"] ?? 0), 1) : 1;

  return (
    <Modal title={batch?.status === "done" || batch?.status === "partial" ? "Lote aplicado" : title} onClose={onClose} wide>
      <p className="dialog-lead">{description}</p>

      {stale ? (
        <p className="form-error-banner" role="alert" style={{ marginBottom: 12 }}>
          La ficha cambió desde la vista previa; nada se escribió. Vuelve a previsualizar para ver el estado actual.
        </p>
      ) : null}
      {error ? <p className="form-error-banner" role="alert">{error}</p> : null}

      {loading ? <p className="hint" role="status">Calculando la vista previa…</p> : null}

      {batch ? (
        <>
          {applied ? (
            <div className="batch-progress">
              <progress max={totalWork} value={finishedCount} aria-label="Progreso del lote" />
              <span>{finishedCount} / {totalWork}</span>
            </div>
          ) : null}
          <div className="cfind-count" style={{ marginBottom: 8 }}>
            <p aria-live="polite">
              {countEntries(batch.counts).map(([key, countOf]) => (
                <span key={key} className="badge badge--outline" style={{ marginRight: 6 }}>
                  {COUNT_LABELS[key] ?? key}: {formatCount(countOf)}
                </span>
              ))}
            </p>
          </div>

          {batch.items.length === 0 ? (
            <p style={{ color: "var(--text-faint)", fontSize: 13.5 }}>No hay nada que corregir con esta selección.</p>
          ) : (
            <div className="table-wrap table-wrap--scroll" style={{ maxHeight: 340, overflowY: "auto" }}>
              <table>
                <caption className="visually-hidden">Ítems del lote, con su acción y su antes → después</caption>
                <thead>
                  <tr>
                    {!applied ? <th scope="col"><span className="visually-hidden">Incluir</span></th> : null}
                    <th scope="col">Hallazgo</th>
                    <th scope="col">Acción</th>
                    <th scope="col">Antes → después</th>
                    {applied ? <th scope="col">Estado</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {batch.items.map((item) => {
                    const options = item.findingId === null ? [] : actionOptions[item.findingId] ?? [];
                    return (
                      <tr key={item.id} style={excluded.has(item.id) ? { opacity: 0.45 } : undefined}>
                        {!applied ? (
                          <td>
                            <input
                              type="checkbox"
                              checked={!excluded.has(item.id)}
                              onChange={() => toggleExcluded(item.id)}
                              aria-label={`Incluir «${item.finding?.title ?? `#${item.findingId}`}»`}
                              disabled={item.status !== "pending" && item.status !== "blocked"}
                            />
                          </td>
                        ) : null}
                        <td style={{ maxWidth: 260, wordBreak: "break-word" }}>
                          {item.finding?.title ?? `#${item.findingId ?? item.id}`}
                          {item.blocked ? <div className="hint">{item.blocked.message}</div> : null}
                          {item.noop ? <div className="hint">Sin cambio: ya estaba corregido{item.noop.coveredBy ? ` (por el ítem #${item.noop.coveredBy})` : ""}.</div> : null}
                          {item.touched.length ? (
                            <div className="hint">Toca: {item.touched.map((ref) => `${ref.kind} #${ref.id}`).join(" · ")}</div>
                          ) : null}
                          {item.collisions.length ? <div className="hint">Colisión con «{item.collisions[0]!.label}».</div> : null}
                        </td>
                        <td>
                          {!applied && item.findingId !== null && options.length > 1 ? (
                            <select
                              className="filter-input"
                              value={byFinding[String(item.findingId)]?.actionKey ?? item.actionKey ?? ""}
                              onChange={(event) => {
                                setByFinding((current) => ({
                                  ...current,
                                  [String(item.findingId!)]: { ...(current[String(item.findingId!)] ?? {}), actionKey: event.target.value },
                                }));
                                setPreviewDirty(true);
                              }}
                              aria-label={`Acción para «${item.finding?.title ?? item.findingId}»`}
                            >
                              {options.filter((option) => option.available && option.level <= 2).map((option) => (
                                <option key={option.key} value={option.key}>{option.label} · nivel {option.level}</option>
                              ))}
                            </select>
                          ) : (
                            <>{item.actionLabel ?? item.actionKey ?? "—"}{item.level !== null ? <span className="hint"> · nivel {item.level}</span> : null}</>
                          )}
                        </td>
                        <td style={{ maxWidth: 340, wordBreak: "break-word" }}><BeforeAfter item={item} /></td>
                        {applied ? (
                          <td><span className={ITEM_STATUS_BADGE[item.status]}>{ITEM_STATUS_LABEL[item.status]}</span>{item.error ? <div className="hint">{item.error}</div> : null}</td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {previewDirty && !applied ? (
            <p className="form-error-banner" role="status">Cambiaste una acción. Pulsa «Actualizar vista previa» antes de aplicar.</p>
          ) : null}

          {!applied && batch.pagination.total > batch.items.length ? (
            <p className="hint" style={{ marginTop: 6 }}>Se muestran {batch.items.length} de {formatCount(batch.pagination.total)} ítems; al aplicar se procesan todos.</p>
          ) : null}

          {!applied ? (
            <>
              <div className="field" style={{ marginTop: 12 }}>
                <label htmlFor="fixbatch-note">Motivo *</label>
                <textarea id="fixbatch-note" rows={2} value={note} onChange={(event) => setNote(event.target.value)}
                  placeholder="Por qué se aplica este lote (queda en la auditoría)" />
              </div>
              <div className="form-actions">
                <button type="button" className="btn" onClick={onClose} disabled={applying}>Cancelar</button>
                <button type="button" className="btn" onClick={() => void loadPreview()} disabled={applying || loading}>Actualizar vista previa</button>
                <button type="button" className="btn btn--primary" onClick={apply} disabled={applying || previewDirty || pendingCount === 0 || !note.trim()}>
                  {applying ? "Aplicando…" : `Aplicar ${formatCount(pendingCount)} correcciones`}
                </button>
              </div>
            </>
          ) : (
            <>
              {undoBatch ? (
                <div className="alert-block" style={{ marginTop: 12 }} role="status">
                  <strong>Lote deshecho.</strong>{" "}
                  {undoBatch.counts["undone"] !== undefined ? <>Se restauraron {formatCount(Number(undoBatch.counts["undone"] ?? 0))} ítems. </> : null}
                  {undoBatch.counts["notUndoable"] ? <>No se pudieron restaurar {formatCount(Number(undoBatch.counts["notUndoable"]))} (la ficha cambió después).</> : null}
                </div>
              ) : batch.status === "running" ? (
                <div className="form-actions">
                  <button type="button" className="btn" onClick={onClose}>Cerrar</button>
                  <button type="button" className="btn btn--primary" onClick={apply} disabled={applying || !note.trim()}>
                    {applying ? "Continuando…" : "Continuar con los pendientes"}
                  </button>
                </div>
              ) : (
                <>
                  <div className="field" style={{ marginTop: 12 }}>
                    <label htmlFor="fixbatch-undo-note">Motivo para deshacer *</label>
                    <textarea id="fixbatch-undo-note" rows={2} value={note} onChange={(event) => setNote(event.target.value)}
                      placeholder="Por qué se revierte lo aplicado (queda en la auditoría)" />
                  </div>
                  <div className="form-actions">
                    <Link className="btn btn--outline" to={`/curaduria/correcciones?batch=${batch.id}`} onClick={onClose}>
                      Ver lote
                    </Link>
                    <button type="button" className="btn btn--danger" onClick={undo} disabled={undoing || !note.trim()}>
                      {undoing ? "Deshaciendo…" : "Deshacer este lote"}
                    </button>
                    <button type="button" className="btn btn--primary" onClick={onClose}>Cerrar</button>
                  </div>
                </>
              )}
            </>
          )}
        </>
      ) : null}

      {!batch && !loading && !valueEditor ? (
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>{error ? "Cerrar" : "Cancelar"}</button>
          <button type="button" className="btn btn--outline" onClick={() => void loadPreview()}>Reintentar vista previa</button>
        </div>
      ) : null}
    </Modal>
  );
}
