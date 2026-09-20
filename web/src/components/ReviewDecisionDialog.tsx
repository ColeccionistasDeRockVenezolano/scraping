// CRV · Decidir una revisión viva desde la tarjeta de un hallazgo
// `cola_de_revision` (PLAN_CURADURIA E7.3): las mismas acciones que la página
// de detalle, sin salir de la lista de Curaduría.
import { Link } from "react-router-dom";
import { ArrowSquareOut } from "@phosphor-icons/react";
import { Modal } from "./Modal";
import { ReviewDecisionActions, ReviewEvidenceList, ReviewValueComparison } from "./ReviewDecision";
import { useAsync } from "../lib/useAsync";
import { useOperator } from "../lib/OperatorContext";
import { reviewApi } from "../lib/api";
import { reviewKindLabel } from "../lib/labels";
import { ErrorState } from "./StateViews";
import { RowsSkeleton } from "./Skeletons";
import type { ReviewActionResult } from "../lib/types";

export function ReviewDecisionDialog({ reviewId, onClose, onDone }: {
  reviewId: number; onClose: () => void; onDone: (result: ReviewActionResult) => void;
}) {
  const { isAdmin } = useOperator();
  const { data: review, loading, error, reload } = useAsync(() => reviewApi.get(reviewId), [reviewId]);

  return (
    <Modal title={review ? `Revisión #${review.id} · ${reviewKindLabel(review.kind)}` : "Cargando la revisión…"} onClose={onClose} wide>
      {loading && !review ? <RowsSkeleton rows={2} height={80} label="Cargando la revisión…" /> : error || !review ? (
        <ErrorState message={error ?? "Revisión no encontrada."} onRetry={reload} />
      ) : (
        <>
          {review.notes ? <p style={{ color: "var(--text-muted)" }}>{review.notes}</p> : null}
          <ReviewValueComparison payload={review.payload} />
          <div className="section">
            <h2>Evidencia de origen</h2>
            <ReviewEvidenceList claims={review.claims} />
          </div>
          <ReviewDecisionActions review={review} isAdmin={isAdmin} onDone={(result) => { onDone(result); onClose(); }} />
          <p className="form-note">
            <Link to={`/curaduria/revision/${review.id}`} target="_blank" rel="noopener">
              Ver la revisión completa <ArrowSquareOut size={13} weight="bold" aria-hidden="true" />
            </Link>
          </p>
        </>
      )}
    </Modal>
  );
}
