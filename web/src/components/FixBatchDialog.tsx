// CRV · Diálogo de un lote de correcciones (E4/E8.2/E8.4): todo nace de una
// vista previa y nada se escribe sin revisarla. Fases: previsualización (por
// ítem: acción —cambiable—, antes → después con el tramo que cambia resaltado,
// fichas tocadas, colisiones y casillas para excluir), aplicación (con el hash
// de esa vista previa y motivo obligatorio), resultado con barra de progreso,
// enlace al lote y deshacer.
//
// Los lotes grandes se continúan con otra llamada igual mientras queden
// pendientes; un 409 `stale_preview` pide volver a previsualizar sin escribir.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, curationApi, type CurationFindingGroupFilter, type CurationFixesPreviewRequest } from "../lib/api";
import { ENTITY_KIND_LABEL, actionConsequence, fieldLabel, formatCount, plural } from "../lib/curation";
import { Modal } from "./Modal";
import { CurationValue } from "./CurationValue";
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
  applied: "badge badge--teal", skipped_stale: "badge badge--amber", failed: "badge badge--red",
  undone: "badge", not_undoable: "badge badge--outline",
};

function countOf(counts: Record<string, unknown>, key: string): number {
  const value = counts[key];
  return typeof value === "number" ? value : 0;
}

/** Recuentos que no se muestran: son del cálculo del lote, no de su resultado. */
const HIDDEN_COUNTS = new Set(["items", "matched", "notApplicable", "truncated"]);

/**
 * Los recuentos que dicen algo: un lote limpio tenía nueve insignias en cero
 * («fallidos: 0», «deshechos: 0»…) que solo servían para esconder la única que
 * importa. «Pendientes» se muestra siempre: es lo que se va a aplicar.
 */
function countEntries(counts: Record<string, unknown>): Array<[string, number]> {
  return Object.entries(counts)
    .filter(([key, value]) => typeof value === "number" && !HIDDEN_COUNTS.has(key))
    .filter(([key, value]) => (value as number) > 0 || key === "pending")
    .map(([key, value]) => [key, value as number]);
}


function formatItemValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Sí" : "No";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Tramo que cambia entre dos textos: prefijo y sufijo comunes fuera, el resto
 * dentro. Es lo que `CurationValue` resalta, así que el antes → después señala
 * exactamente lo que se toca en vez de obligar a comparar dos cadenas enteras.
 */
function changedSpan(before: string, after: string): { before: [number, number]; after: [number, number] } {
  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before[start] === after[start]) start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) { endBefore -= 1; endAfter -= 1; }
  return { before: [start, endBefore], after: [start, endAfter] };
}

/** Las claves que de verdad cambian entre `before` y `after`. */
function changedKeys(item: FixItem): string[] {
  if (!item.after) return [];
  const before = item.before ?? {};
  return Object.entries(item.after)
    .filter(([key, value]) => JSON.stringify(before[key]) !== JSON.stringify(value))
    .map(([key]) => key);
}

/** Antes → después de un ítem, con el tramo cambiado resaltado cuando son textos. */
function ItemChange({ item }: { item: FixItem }) {
  const keys = changedKeys(item);
  if (!keys.length) return <span className="hint">—</span>;
  const before = item.before ?? {};
  const after = item.after ?? {};
  return (
    <div className="cdiff">
      {keys.map((key) => {
        const from = before[key];
        const to = after[key];
        const text = typeof from === "string" && typeof to === "string";
        const span = text ? changedSpan(from as string, to as string) : null;
        return (
          <div key={key} className="cdiff__row">
            <span className="cdiff__field">{fieldLabel(key)}</span>
            <span className="cdiff__pair">
              <span className="cdiff__side cdiff__side--before">
                {span ? <CurationValue value={from as string} evidence={{ span: span.before }} /> : formatItemValue(from)}
              </span>
              <span className="cdiff__arrow" aria-hidden="true">→</span>
              <span className="cdiff__side cdiff__side--after">
                {span ? <CurationValue value={to as string} evidence={{ span: span.after }} /> : formatItemValue(to)}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Fichas que la acción escribe: el alcance real del ítem, más allá de la del hallazgo. */
function TouchedList({ item }: { item: FixItem }) {
  if (item.touched.length <= 1) return null;
  return (
    <div className="hint">
      Toca {formatCount(item.touched.length)} fichas:{" "}
      {item.touched.slice(0, 4).map((ref) => `${ENTITY_KIND_LABEL[ref.kind] ?? ref.kind} #${ref.id}`).join(", ")}
      {item.touched.length > 4 ? ` y ${item.touched.length - 4} más` : ""}
    </div>
  );
}

/**
 * Cambiar la acción de una fila (E8.2). Las alternativas se piden solo cuando
 * alguien abre el selector: en un lote de 500 ítems, pedirlas de entrada serían
 * 500 llamadas para algo que casi nunca se cambia.
 */
function ActionPicker({ item, value, onChange }: { item: FixItem; value: string | null; onChange: (key: string) => void }) {
  const [options, setOptions] = useState<FindingAction[] | null>(null);
  const [loading, setLoading] = useState(false);
  const findingId = item.findingId;

  if (findingId === null) return <span>{item.actionLabel ?? item.actionKey ?? "—"}</span>;

  if (!options) {
    return (
      <div className="cdiff__action">
        <span>{item.actionLabel ?? item.actionKey ?? "—"}{item.level !== null ? <span className="hint"> · nivel {item.level}</span> : null}</span>
        <button
          type="button" className="btn-link" disabled={loading}
          onClick={() => {
            setLoading(true);
            curationApi.findingsActions(findingId)
              .then((result) => setOptions(result.actions.filter((action) => action.available)))
              .catch(() => setOptions([]))
              .finally(() => setLoading(false));
          }}
        >
          {loading ? "Buscando…" : "Cambiar"}
        </button>
      </div>
    );
  }

  if (options.length <= 1) return <span>{item.actionLabel ?? item.actionKey ?? "—"} <span className="hint">· sin alternativas</span></span>;

  return (
    <>
      <label className="visually-hidden" htmlFor={`fixitem-action-${item.id}`}>Acción para «{item.finding?.title ?? `#${findingId}`}»</label>
      <select
        id={`fixitem-action-${item.id}`} className="filter-input" value={value ?? item.actionKey ?? ""}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((action) => (
          <option key={action.key} value={action.key}>{action.label} · nivel {action.level}</option>
        ))}
      </select>
      <span className="hint">{actionConsequence(options.find((action) => action.key === (value ?? item.actionKey)) ?? options[0]!)}</span>
    </>
  );
}

interface FixBatchDialogProps {
  mode: "individual" | "selected" | "group";
  findingIds?: number[];
  filter?: CurationFindingGroupFilter;
  title: string;
  description: string;
  /** Acción pedida a mano («Otras correcciones» de la tarjeta, E8.1); si falta, la recomendada de cada hallazgo. */
  actionKey?: string;
  /** Solo en individual: valor escrito a mano (si falta, la acción recomendada). */
  valueEditor?: { initial: string; current: string; fieldLabel: string };
  onDone: () => void;
  /** El lote quedó aplicado: quien abre el diálogo decide si ofrece «Deshacer» en un aviso (E8.4). */
  onApplied?: (batch: FixBatch) => void;
  onClose: () => void;
}

export function FixBatchDialog({
  mode, findingIds, filter, title, description, actionKey, valueEditor, onDone, onApplied, onClose,
}: FixBatchDialogProps) {
  const [batch, setBatch] = useState<FixBatch | null>(null);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [rowActions, setRowActions] = useState<Record<number, string>>({});
  const [value, setValue] = useState(valueEditor?.initial ?? "");
  const [note, setNote] = useState("");
  // Motivo aparte para deshacer: reutilizar el de aplicar dejaba la reversa
  // firmada con la razón del cambio que revierte, que en la auditoría miente.
  const [undoNote, setUndoNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string>();
  const [applied, setApplied] = useState(false);
  const [undoBatch, setUndoBatch] = useState<FixBatch | null>(null);
  const [recommended, setRecommended] = useState<string | null>(null);

  const body = useCallback((overrideActions: Record<number, string>): CurationFixesPreviewRequest => {
    const byFinding = Object.fromEntries(Object.entries(overrideActions).map(([id, key]) => [id, { actionKey: key }]));
    // En individual con editor, el valor escrito corrige el texto del campo:
    // esa es la acción. En lotes, el motor decide la recomendada por hallazgo.
    const explicit = actionKey ?? (valueEditor && mode === "individual" ? "limpiar_texto" : undefined);
    const params = valueEditor && mode === "individual" ? { value: value.trim() } : undefined;
    const overrides = {
      ...(params ? { params } : {}),
      ...(Object.keys(byFinding).length ? { byFinding } : {}),
    };
    return {
      mode,
      ...(findingIds ? { findingIds } : {}),
      ...(filter ? { filter } : {}),
      ...(explicit ? { actionKey: explicit } : {}),
      ...(Object.keys(overrides).length ? { overrides } : {}),
    };
  }, [mode, findingIds, filter, actionKey, valueEditor, value]);

  const loadPreview = useCallback(async (overrideActions: Record<number, string> = {}) => {
    setLoading(true);
    setError(undefined);
    setStale(false);
    setBatch(null);
    setExcluded(new Set());
    try {
      setBatch(await curationApi.fixesPreview(body(overrideActions)));
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

  function changeRowAction(findingId: number, key: string) {
    const next = { ...rowActions, [findingId]: key };
    setRowActions(next);
    void loadPreview(next);
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
        const action = result.actions.find((item) => item.recommended) ?? result.actions[0];
        setRecommended(action ? actionConsequence(action) : null);
      })
      .catch(() => { /* sin acciones: la vista previa lo dirá */ });
    return () => { active = false; };
  }, [mode, findingIds]);

  if (valueEditor && mode === "individual" && !batch && !loading) {
    const unchanged = value.trim() === valueEditor.current.trim();
    return (
      <Modal title={title} onClose={onClose}>
        <p className="dialog-lead">{description}</p>
        <p className="hint" style={{ marginBottom: 8 }}>
          Campo: {valueEditor.fieldLabel}{recommended ? ` · ${recommended}` : ""}
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
      if (countOf(result.counts, "applied") > 0) onApplied?.(result);
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
    if (!undoNote.trim()) { setError("La nota para deshacer es obligatoria."); return; }
    setUndoing(true);
    setError(undefined);
    try {
      const result = await curationApi.fixUndo(batch.id, undoNote.trim());
      setUndoBatch(result);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo deshacer el lote.");
    } finally {
      setUndoing(false);
    }
  }

  const pendingCount = batch ? batch.items.filter((item) => item.status === "pending" && !excluded.has(item.id)).length : 0;

  return (
    <Modal title={batch?.status === "done" || batch?.status === "partial" ? "Lote aplicado" : title} onClose={onClose} wide>
      <p className="dialog-lead">
        {applied
          ? "Ya está escrito en el catálogo, con un run por corrección. Puedes deshacerlo aquí mismo o abrir el lote para ver el detalle."
          : description}
      </p>

      {stale ? (
        <p className="form-error-banner" role="alert" style={{ marginBottom: 12 }}>
          La ficha cambió desde la vista previa; nada se escribió. Vuelve a previsualizar para ver el estado actual.
        </p>
      ) : null}
      {error ? <p className="form-error-banner" role="alert">{error}</p> : null}

      {loading ? <p className="hint" role="status">Calculando la vista previa…</p> : null}

      {batch ? (
        <>
          {applied ? <BatchProgress batch={batch} /> : (
            <div className="cfind-count" style={{ marginBottom: 8 }}>
              <p aria-live="polite">
                {countEntries(batch.counts).map(([key, total]) => (
                  <span key={key} className="badge badge--outline" style={{ marginRight: 6 }}>
                    {COUNT_LABELS[key] ?? key}: {formatCount(total)}
                  </span>
                ))}
              </p>
            </div>
          )}

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
                  {batch.items.map((item) => (
                    <tr key={item.id} className={excluded.has(item.id) ? "is-excluded" : undefined}>
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
                      <td className="cdiff__finding">
                        {item.finding?.title ?? `#${item.findingId ?? item.id}`}
                        {item.blocked ? <div className="hint">{item.blocked.message}</div> : null}
                        {item.noop ? <div className="hint">Sin cambio: ya estaba corregido{item.noop.coveredBy ? ` (por el ítem #${item.noop.coveredBy})` : ""}.</div> : null}
                        {item.collisions.length ? (
                          <div className="cdiff__collision">
                            Choca con «{item.collisions[0]!.label}» (#{item.collisions[0]!.id})
                            {item.collisions[0]!.exact ? ", con el mismo nombre exacto" : ", con un nombre equivalente"}
                            {item.proposal ? `. Se propone ${item.proposal.actionKey.replace(/_/gu, " ")}: ${item.proposal.reason}` : "."}
                          </div>
                        ) : null}
                        {item.warnings.map((warning) => <div key={warning} className="hint">{warning}</div>)}
                        <TouchedList item={item} />
                      </td>
                      <td className="cdiff__action-cell">
                        {applied
                          ? <>{item.actionLabel ?? item.actionKey ?? "—"}{item.level !== null ? <span className="hint"> · nivel {item.level}</span> : null}</>
                          : <ActionPicker item={item} value={item.findingId === null ? null : rowActions[item.findingId] ?? null}
                            onChange={(key) => item.findingId !== null && changeRowAction(item.findingId, key)} />}
                      </td>
                      <td><ItemChange item={item} /></td>
                      {applied ? (
                        <td><span className={ITEM_STATUS_BADGE[item.status]}>{ITEM_STATUS_LABEL[item.status]}</span>{item.error ? <div className="hint">{item.error}</div> : null}</td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

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
                <button type="button" className="btn" onClick={() => void loadPreview(rowActions)} disabled={applying || loading}>Actualizar vista previa</button>
                <button type="button" className="btn btn--primary" onClick={apply} disabled={applying || pendingCount === 0 || !note.trim()}>
                  {applying ? "Aplicando…" : `Aplicar ${plural(pendingCount, "corrección", "correcciones")}`}
                </button>
              </div>
            </>
          ) : (
            <>
              {undoBatch ? (
                <div className="alert-block" style={{ marginTop: 12 }} role="status">
                  <strong>Lote deshecho.</strong>{" "}
                  {undoBatch.counts["undone"] !== undefined ? <>Se restauraron {plural(countOf(undoBatch.counts, "undone"), "ítem", "ítems")}. </> : null}
                  {undoBatch.counts["notUndoable"] ? <>No se pudieron restaurar {formatCount(countOf(undoBatch.counts, "notUndoable"))} (la ficha cambió después).</> : null}
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
                    <textarea id="fixbatch-undo-note" rows={2} value={undoNote} onChange={(event) => setUndoNote(event.target.value)}
                      placeholder="Por qué se revierte lo aplicado (queda en la auditoría)" />
                  </div>
                  <div className="form-actions">
                    <Link className="btn" to={`/curaduria/correcciones/${batch.id}`} onClick={onClose}>Ver lote</Link>
                    <button type="button" className="btn btn--danger" onClick={undo} disabled={undoing || !undoNote.trim()}>
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
          <button type="button" className="btn btn--outline" onClick={() => void loadPreview(rowActions)}>Reintentar vista previa</button>
        </div>
      ) : null}
    </Modal>
  );
}

/**
 * Resultado del lote como barra (E8.4): aplicados, obsoletos y fallidos sobre
 * el total, más el texto que lee un lector de pantalla — una barra sola no
 * dice nada a quien no la ve.
 */
export function BatchProgress({ batch }: { batch: FixBatch }) {
  const applied = countOf(batch.counts, "applied");
  const stale = countOf(batch.counts, "skippedStale");
  const failed = countOf(batch.counts, "failed");
  const pending = countOf(batch.counts, "pending");
  const total = Math.max(applied + stale + failed + pending, 1);
  const parts: Array<[string, number, string]> = [
    ["applied", applied, "var(--teal)"],
    ["stale", stale, "var(--amber)"],
    ["failed", failed, "var(--red)"],
  ];
  return (
    <div className="cprogress">
      <div className="cprogress__bar" role="img"
        aria-label={`${formatCount(applied)} aplicados, ${formatCount(stale)} obsoletos, ${formatCount(failed)} fallidos de ${formatCount(total)}`}>
        {parts.map(([key, value, color]) => (
          value > 0 ? <span key={key} className="cprogress__part" style={{ width: `${(value / total) * 100}%`, background: color }} /> : null
        ))}
      </div>
      <p className="cprogress__text" aria-live="polite">
        {plural(applied, "aplicado", "aplicados")} · {plural(stale, "obsoleto", "obsoletos")} · {plural(failed, "fallido", "fallidos")}
        {pending > 0 ? ` · ${plural(pending, "pendiente", "pendientes")}` : ""}
      </p>
    </div>
  );
}
