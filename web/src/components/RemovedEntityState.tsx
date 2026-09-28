// CRV · Error de carga de una ficha. Si la API dice que un cambio la retiró
// (`removedByRun` en el 404), ofrece deshacer ese retiro ahí mismo: tras
// retirar una ficha por error no hay que ir a buscar el cambio al Historial.
import { useState } from "react";
import { ArrowArcLeft } from "@phosphor-icons/react";
import { ApiError } from "../lib/api";
import { useOperator } from "../lib/OperatorContext";
import { ErrorState } from "./StateViews";
import { UndoDialog } from "./UndoDialog";

export function removedByRunFrom(errorValue: unknown): number | undefined {
  if (!(errorValue instanceof ApiError) || errorValue.status !== 404) return undefined;
  // Una ficha fusionada también se retira, pero la lleva useMovedToRedirect.
  if (errorValue.details?.["movedTo"]) return undefined;
  const runId = errorValue.details?.["removedByRun"];
  return typeof runId === "number" && Number.isSafeInteger(runId) && runId > 0 ? runId : undefined;
}

export function EntityLoadError({ message, errorValue, onRetry }: { message: string; errorValue: unknown; onRetry: () => void }) {
  const { isAdmin } = useOperator();
  const [undoing, setUndoing] = useState(false);
  const runId = removedByRunFrom(errorValue);
  if (!runId || !isAdmin) return <ErrorState message={message} onRetry={onRetry} />;
  return (
    <div className="state-block removed-entity">
      <h3>Esta ficha fue retirada del catálogo</h3>
      <p>La retiró el cambio #{runId}. Deshacerlo la devuelve con sus relaciones, alias y evidencia.</p>
      <button type="button" className="btn btn--danger" onClick={() => setUndoing(true)}>
        <ArrowArcLeft aria-hidden="true" weight="bold" /> Deshacer retiro (#{runId})
      </button>
      {undoing ? <UndoDialog runId={runId} onClose={() => setUndoing(false)} /> : null}
    </div>
  );
}
