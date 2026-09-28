// CRV · Lista de cambios del catálogo con su botón de deshacer o rehacer:
// la usan la página Historial y la sección «Cambios» de cada ficha.
import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowArcLeft, ArrowArcRight } from "@phosphor-icons/react";
import { changeTitle, countsSummary, entityHref, ENTITY_OP_LABEL, kindLabel } from "../lib/changes";
import { relativeTime } from "../lib/curation";
import type { ChangeSummary } from "../lib/types";
import { UndoDialog } from "./UndoDialog";

export function ChangeList({ rows }: { rows: ChangeSummary[] }) {
  const [dialogFor, setDialogFor] = useState<number | null>(null);
  return (
    <>
      <ul className="change-list">
        {rows.map((change) => {
          // Un deshacer se rehace; un rehacer (deshacer de un deshacer) se vuelve a deshacer.
          const isUndo = change.undoOf !== null && change.redoOf === null;
          return (
            <li key={change.runId} className={`change-row${change.undoneBy ? " change-row--undone" : ""}`}>
              <div className="change-row__main">
                <div className="change-row__title">
                  <strong>{changeTitle(change)}</strong>
                  <span className="mono hint">#{change.runId}</span>
                  {change.undoneBy ? <span className="badge badge--amber">Deshecho por #{change.undoneBy}</span> : null}
                  {change.redoOf !== null ? <span className="badge badge--teal">Rehace #{change.redoOf}</span>
                    : isUndo ? <span className="badge badge--violet">Deshace #{change.undoOf}</span> : null}
                  {change.status === "failed" ? <span className="badge badge--red">Falló</span> : null}
                  {!change.journaled ? <span className="badge" title="Anterior al diario de cambios o sin cambios en el catálogo">Sin diario</span> : null}
                </div>
                <div className="change-row__meta hint">
                  <span title={new Date(change.startedAt).toLocaleString("es-VE")}>{relativeTime(change.startedAt)}</span>
                  {change.operator ? <> · {change.operator}</> : null}
                  {change.total ? <> · {countsSummary(change)}</> : null}
                </div>
                {change.note ? <div className="change-row__note">«{change.note}»</div> : null}
                {change.entities.length ? (
                  <div className="change-row__entities">
                    {change.entities.map((entity) => {
                      const href = entity.op === "removed" ? null : entityHref(entity.kind, entity.id);
                      const name = entity.label ?? `${kindLabel(entity.kind)} ${entity.id}`;
                      return (
                        <span key={`${entity.kind}:${entity.id}`} className="change-chip" title={`${kindLabel(entity.kind)} ${ENTITY_OP_LABEL[entity.op]}`}>
                          <span className={`change-chip__op change-chip__op--${entity.op}`}>{ENTITY_OP_LABEL[entity.op]}</span>
                          {href ? <Link to={href}>{name}</Link> : <span>{name}</span>}
                        </span>
                      );
                    })}
                    {change.entityTotal > change.entities.length ? <span className="hint">y {change.entityTotal - change.entities.length} más</span> : null}
                  </div>
                ) : null}
              </div>
              <div className="change-row__actions">
                {change.undoneBy ? (
                  <button type="button" className="btn btn--sm" onClick={() => setDialogFor(change.undoneBy)}>
                    <ArrowArcRight aria-hidden="true" weight="bold" /> Rehacer
                  </button>
                ) : (
                  <button type="button" className={`btn btn--sm ${isUndo ? "" : "btn--danger"}`} onClick={() => setDialogFor(change.runId)}>
                    {isUndo ? <ArrowArcRight aria-hidden="true" weight="bold" /> : <ArrowArcLeft aria-hidden="true" weight="bold" />}
                    {isUndo ? " Rehacer" : " Deshacer"}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {dialogFor !== null ? <UndoDialog runId={dialogFor} onClose={() => setDialogFor(null)} /> : null}
    </>
  );
}
