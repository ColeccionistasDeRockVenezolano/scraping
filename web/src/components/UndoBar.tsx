// CRV · Barra de «Deshacer» siempre a la vista tras un cambio del catálogo.
//
// Toda escritura con run (edición, alta, retiro, fusión, división, conversión,
// corrección) la anuncia `request()` con el evento `crv-change`. La barra
// muestra el último cambio con su botón hasta que se cierra o llega otro; no
// caduca como un aviso. Tras deshacer, el cambio nuevo es el deshacer, y su
// botón es «Rehacer».
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowArcLeft, ArrowArcRight, ClockCounterClockwise, X } from "@phosphor-icons/react";
import { CATALOG_CHANGE_EVENT, CATALOG_DATA_CHANGED_EVENT, changesApi, type CatalogChangeEvent } from "../lib/api";
import { changeTitle, entityHref, ENTITY_OP_LABEL, kindLabel } from "../lib/changes";
import { useOperator } from "../lib/OperatorContext";
import type { ChangeSummary } from "../lib/types";
import { UndoDialog } from "./UndoDialog";

export function UndoBar() {
  const { isAdmin } = useOperator();
  if (!isAdmin) return null;
  return <UndoBarContent />;
}

function UndoBarContent() {
  const [runId, setRunId] = useState<number | null>(null);
  const [change, setChange] = useState<ChangeSummary | null>(null);
  const [dialogFor, setDialogFor] = useState<number | null>(null);
  // Solo cuenta la respuesta del último cambio anunciado.
  const latest = useRef<number | null>(null);

  const load = useCallback((id: number) => {
    changesApi.get(id).then(
      (detail) => { if (latest.current === id) setChange(detail); },
      () => { if (latest.current === id) setChange(null); },
    );
  }, []);

  useEffect(() => {
    const onChange = (event: Event) => {
      const { runId: id } = (event as CustomEvent<CatalogChangeEvent>).detail;
      latest.current = id;
      setRunId(id);
      setChange(null);
      load(id);
    };
    // Un deshacer hecho desde otro lugar (Historial, ficha) puede cambiar el
    // estado del cambio que muestra la barra.
    const onData = () => { if (latest.current !== null) load(latest.current); };
    window.addEventListener(CATALOG_CHANGE_EVENT, onChange);
    window.addEventListener(CATALOG_DATA_CHANGED_EVENT, onData);
    return () => {
      window.removeEventListener(CATALOG_CHANGE_EVENT, onChange);
      window.removeEventListener(CATALOG_DATA_CHANGED_EVENT, onData);
    };
  }, [load]);

  if (runId === null) return null;
  const shown = change?.runId === runId ? change : null;
  // Un deshacer se rehace; un rehacer (deshacer de un deshacer) se vuelve a deshacer.
  const isUndo = shown !== null && shown.undoOf !== null && shown.redoOf === null;
  const undone = shown?.undoneBy ?? null;
  const first = shown?.entities[0];
  const firstHref = first && first.op !== "removed" ? entityHref(first.kind, first.id) : null;

  return (
    <>
      <div className="undo-bar" role="status" aria-live="polite">
        <div className="undo-bar__text">
          {shown ? (
            <>
              <strong>{undone ? `${changeTitle(shown)} — deshecho` : shown.redoOf !== null ? `Rehiciste #${shown.redoOf}` : isUndo ? `Deshiciste #${shown.undoOf}` : changeTitle(shown)}</strong>
              <span className="undo-bar__detail">
                #{shown.runId}
                {first ? (
                  <>
                    {" · "}{kindLabel(first.kind)}{" "}
                    {firstHref ? <Link to={firstHref}>{first.label ?? first.id}</Link> : <span>{first.label ?? first.id}</span>}
                    {" "}{ENTITY_OP_LABEL[first.op]}
                    {shown.entityTotal > 1 ? ` y ${shown.entityTotal - 1} más` : ""}
                  </>
                ) : null}
              </span>
            </>
          ) : (
            <strong>Cambio #{runId} guardado</strong>
          )}
        </div>
        <div className="undo-bar__actions">
          {undone ? (
            <button type="button" className="btn btn--sm" onClick={() => setDialogFor(undone)}>
              <ArrowArcRight aria-hidden="true" weight="bold" /> Rehacer
            </button>
          ) : isUndo ? (
            <button type="button" className="btn btn--sm btn--primary" onClick={() => setDialogFor(runId)}>
              <ArrowArcRight aria-hidden="true" weight="bold" /> Rehacer
            </button>
          ) : (
            <button type="button" className="btn btn--sm btn--danger" onClick={() => setDialogFor(runId)}>
              <ArrowArcLeft aria-hidden="true" weight="bold" /> Deshacer
            </button>
          )}
          <Link to="/historial" className="btn btn--sm btn--ghost">
            <ClockCounterClockwise aria-hidden="true" weight="bold" /> <span className="undo-bar__history">Historial</span>
          </Link>
          <button type="button" className="undo-bar__close" onClick={() => { latest.current = null; setRunId(null); setChange(null); }} aria-label="Cerrar este aviso">
            <X aria-hidden="true" weight="bold" />
          </button>
        </div>
      </div>
      {dialogFor !== null ? <UndoDialog runId={dialogFor} onClose={() => setDialogFor(null)} /> : null}
    </>
  );
}
