// CRV · Deshacer (o rehacer) un cambio del catálogo: muestra antes de
// confirmar qué vuelve, qué se retira y qué se revierte, o por qué no se
// puede (y qué cambio posterior hay que deshacer primero). Rehacer es
// deshacer un deshacer: el mismo diálogo sobre el run del deshacer.
import { useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, CATALOG_DATA_CHANGED_EVENT, changesApi } from "../lib/api";
import { changeTitle, entityHref, isCatalogTable, kindLabel, UNDO_STEP_LABEL } from "../lib/changes";
import { relativeTime } from "../lib/curation";
import { useAsync } from "../lib/useAsync";
import { useToast } from "../lib/ToastContext";
import type { ChangeUndoResult, UndoConflict, UndoStep } from "../lib/types";
import { Modal } from "./Modal";

const ENTITY_LIST_LIMIT = 12;

function tableName(table: string): string {
  return kindLabel(table.replace(/^\w+\./u, ""));
}

function conflictText(conflict: UndoConflict): string {
  const what = conflict.label ? `«${conflict.label}»` : `${tableName(conflict.table)} ${JSON.stringify(conflict.pk)}`;
  const why = conflict.reason === "missing" ? "ya no existe"
    : conflict.reason === "exists" ? "ya existe otra fila con esa clave"
      : `cambió después${conflict.columns.length ? ` (${conflict.columns.join(", ")})` : ""}`;
  return `${what} ${why}`;
}

/** Pasos sobre tablas del catálogo; lo interno se ve en «Detalle por tabla». */
function catalogSteps(byTable: Record<string, Record<UndoStep, number>>): Record<UndoStep, number> {
  const steps: Record<UndoStep, number> = { restore: 0, revert: 0, remove: 0 };
  for (const [table, counts] of Object.entries(byTable)) {
    if (!isCatalogTable(table)) continue;
    steps.restore += counts.restore; steps.revert += counts.revert; steps.remove += counts.remove;
  }
  return steps;
}

function stepsText(steps: Record<UndoStep, number>): string {
  return [
    steps.restore ? `${steps.restore} fila(s) del catálogo vuelven` : "",
    steps.revert ? `${steps.revert} se revierten` : "",
    steps.remove ? `${steps.remove} se retiran` : "",
  ].filter(Boolean).join(" · ");
}

export function UndoDialog({ runId: initialRunId, onClose, onDone }: {
  runId: number;
  onClose: () => void;
  onDone?: (result: ChangeUndoResult) => void;
}) {
  const { notify } = useToast();
  // Un conflicto puede llevar a deshacer primero el cambio posterior: el
  // diálogo sigue abierto sobre ese otro run.
  const [runId, setRunId] = useState(initialRunId);
  const { data, loading, error, reload } = useAsync(() => changesApi.get(runId), [runId]);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();

  // Deshacer un deshacer es rehacer; deshacer un rehacer vuelve a deshacer el original.
  const isRedo = data !== undefined && data.undoOf !== null && data.redoOf === null;
  const verb = isRedo ? "Rehacer" : "Deshacer";
  const target = data ? (data.redoOf ?? data.undoOf ?? runId) : runId;

  async function confirm() {
    if (!data) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      const result = await changesApi.undo(runId, note.trim());
      notify("success", isRedo
        ? `Rehecho: #${target} vuelve a estar aplicado (cambio #${result.runId}).`
        : `Deshecho #${target} (cambio #${result.runId}). Puedes rehacerlo desde la barra o el Historial.`);
      window.dispatchEvent(new Event(CATALOG_DATA_CHANGED_EVENT));
      if (runId !== initialRunId) {
        // Se deshizo el cambio posterior: se vuelve al que se quería deshacer.
        setRunId(initialRunId);
        setNote("");
        reload();
        return;
      }
      onDone?.(result);
      onClose();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "No se pudo deshacer el cambio.");
      reload();
    } finally {
      setSaving(false);
    }
  }

  const plan = data?.undo.plan ?? null;
  const conflicts = plan?.conflicts ?? [];
  const laterRuns = [...new Set(conflicts.map((conflict) => conflict.laterRunId).filter((id): id is number => id !== null))];

  return (
    <Modal title={data ? `${verb} #${target}` : `${verb} cambio`} onClose={onClose} wide sheet>
      {loading && !data ? (
        <p className="hint">Calculando qué haría…</p>
      ) : error || !data ? (
        <p className="form-error-banner" role="alert">{error ?? "No se encontró el cambio."}</p>
      ) : (
        <>
          {runId !== initialRunId ? (
            <p className="hint undo-dialog__detour">
              Para deshacer #{initialRunId} hay que deshacer antes este cambio posterior (#{runId}).{" "}
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setRunId(initialRunId)}>Volver a #{initialRunId}</button>
            </p>
          ) : null}
          <div className="undo-dialog__what">
            <strong>{changeTitle(data)}</strong>
            <span className="hint">
              #{data.runId} · <span title={new Date(data.startedAt).toLocaleString("es-VE")}>{relativeTime(data.startedAt)}</span>
              {data.operator ? ` · ${data.operator}` : ""}
            </span>
            {data.note ? <span className="undo-dialog__note">«{data.note}»</span> : null}
          </div>

          {data.undo.undoable ? (
            plan ? (
              <>
                <p>
                  {isRedo ? "Vuelve a aplicar el cambio: " : "Todo vuelve a como estaba antes de este cambio: "}
                  {stepsText(catalogSteps(plan.byTable)) || (plan.changes ? "solo filas internas (evidencia, revisión)" : "no queda nada que cambiar")}.
                </p>
                {plan.entities.length ? (
                  <ul className="undo-dialog__entities">
                    {plan.entities.slice(0, ENTITY_LIST_LIMIT).map((entity) => {
                      const href = entity.step === "remove" ? null : entityHref(entity.kind, entity.id);
                      const name = entity.label ?? `${kindLabel(entity.kind)} ${entity.id}`;
                      return (
                        <li key={`${entity.kind}:${entity.id}`}>
                          <span className={`badge ${entity.step === "remove" ? "badge--red" : entity.step === "restore" ? "badge--teal" : "badge--amber"}`}>
                            {UNDO_STEP_LABEL[entity.step]}
                          </span>{" "}
                          {kindLabel(entity.kind)}: {href ? <Link to={href} onClick={onClose}>{name}</Link> : name}
                        </li>
                      );
                    })}
                    {plan.entities.length > ENTITY_LIST_LIMIT ? <li className="hint">y {plan.entities.length - ENTITY_LIST_LIMIT} ficha(s) más</li> : null}
                  </ul>
                ) : null}
                {Object.keys(plan.byTable).length ? (
                  <details className="undo-dialog__tables">
                    <summary>Detalle por tabla</summary>
                    <ul>
                      {Object.entries(plan.byTable).map(([table, steps]) => (
                        <li key={table}>
                          <span className="mono">{table}</span>:{" "}
                          {(Object.keys(steps) as Array<keyof typeof steps>).filter((step) => steps[step]).map((step) => `${steps[step]} ${UNDO_STEP_LABEL[step]}`).join(", ")}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
                {plan.skipped.length ? (
                  <p className="hint">
                    {plan.skipped.length} fila(s) de revisión o evidencia cambiaron después y se dejan como están (no afectan al catálogo).
                  </p>
                ) : null}
                {plan.claimsToSupersede ? (
                  <p className="hint">La evidencia que aportó este cambio ({plan.claimsToSupersede}) queda como reemplazada, no se borra.</p>
                ) : null}
              </>
            ) : (
              <p className="hint">{data.undo.reason}</p>
            )
          ) : (
            <div className="form-error-banner" role="alert">
              <p style={{ margin: 0 }}>{data.undo.reason ?? "Este cambio no se puede deshacer."}</p>
              {conflicts.length ? (
                <ul className="undo-dialog__conflicts">
                  {conflicts.slice(0, 8).map((conflict, index) => (
                    <li key={index}>
                      {conflictText(conflict)}
                      {conflict.laterRunId ? <> — en el cambio #{conflict.laterRunId}</> : null}
                    </li>
                  ))}
                  {conflicts.length > 8 ? <li>y {conflicts.length - 8} más</li> : null}
                </ul>
              ) : null}
              {laterRuns.length ? (
                <div className="form-actions" style={{ marginTop: 10 }}>
                  {laterRuns.slice(0, 4).map((later) => (
                    <button key={later} type="button" className="btn btn--sm" onClick={() => { setNote(""); setRunId(later); }}>
                      Deshacer primero #{later}
                    </button>
                  ))}
                </div>
              ) : null}
              {data.undoneBy ? (
                <div className="form-actions" style={{ marginTop: 10 }}>
                  <button type="button" className="btn btn--sm" onClick={() => { setNote(""); setRunId(data.undoneBy!); }}>
                    Rehacer (deshacer #{data.undoneBy})
                  </button>
                </div>
              ) : null}
            </div>
          )}

          {data.undo.undoable ? (
            <div className="field" style={{ marginTop: 14 }}>
              <label htmlFor="undo-note">Motivo *</label>
              <textarea
                id="undo-note" rows={2} value={note} onChange={(event) => setNote(event.target.value)}
                placeholder={isRedo ? "Por qué vuelve a aplicarse" : "Por qué se deshace"}
              />
            </div>
          ) : null}
          {saveError ? <p className="form-error-banner" role="alert">{saveError}</p> : null}
          <div className="form-actions">
            <button type="button" className="btn btn--ghost" onClick={onClose}>Cerrar</button>
            {data.undo.undoable ? (
              <button type="button" className={`btn ${isRedo ? "btn--primary" : "btn--danger"}`} onClick={() => void confirm()} disabled={saving || !note.trim()}>
                {saving ? `${verb === "Rehacer" ? "Rehaciendo" : "Deshaciendo"}…` : `${verb} #${target}`}
              </button>
            ) : null}
          </div>
        </>
      )}
    </Modal>
  );
}
