import { Link, useNavigate, useParams } from "react-router-dom";
import { reviewApi } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useOperator } from "../lib/OperatorContext";
import { ErrorState } from "../components/StateViews";
import { HeaderSkeleton, RowsSkeleton } from "../components/Skeletons";
import { entityHref } from "../lib/routes";
import { reviewKindLabel, reviewStatusLabel } from "../lib/labels";
import { ReviewDecisionActions, ReviewEvidenceList, ReviewValueComparison } from "../components/ReviewDecision";

const ENTITY_LINKS: ReadonlyArray<{ key: keyof ReturnType<typeof entityRefs>; type: "artist" | "person" | "organization" | "album" | "track"; label: string }> = [
  { key: "artistAId", type: "artist", label: "Artista A" },
  { key: "artistBId", type: "artist", label: "Artista B" },
  { key: "personAId", type: "person", label: "Persona A" },
  { key: "personBId", type: "person", label: "Persona B" },
  { key: "organizationAId", type: "organization", label: "Organización A" },
  { key: "organizationBId", type: "organization", label: "Organización B" },
  { key: "albumId", type: "album", label: "Disco" },
  { key: "trackId", type: "track", label: "Pista" },
];

function entityRefs(detail: NonNullable<ReturnType<typeof useReviewDetail>["data"]>) {
  return {
    artistAId: detail.artistAId, artistBId: detail.artistBId, personAId: detail.personAId, personBId: detail.personBId,
    organizationAId: detail.organizationAId, organizationBId: detail.organizationBId, albumId: detail.albumId, trackId: detail.trackId,
  };
}

function useReviewDetail(id: number) {
  return useAsync(() => reviewApi.get(id), [id]);
}

function displayValue(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "Sin valor";
}

export function ReviewQueueDetailPage() {
  const { id } = useParams();
  const reviewId = Number(id);
  const navigate = useNavigate();
  const { isAdmin } = useOperator();
  const { data: review, loading, error, reload } = useReviewDetail(reviewId);

  if (loading) return (
    <div role="status" aria-label="Cargando la revisión…">
      <HeaderSkeleton />
      <RowsSkeleton rows={3} height={96} />
    </div>
  );
  if (error || !review) return <ErrorState message={error ?? "Revisión no encontrada."} onRetry={reload} />;

  const refs = entityRefs(review);

  return (
    <>
      <Link to="/curaduria" className="back-link">← Conflictos</Link>

      <div className="page-header">
        <div>
          <p className="page-kicker">Revisión #{review.id}</p>
          <h1>{reviewKindLabel(review.kind)}</h1>
          <p className="page-lead">Prioridad {review.priority} · creada el {new Date(review.createdAt).toLocaleString("es-VE")}</p>
        </div>
        <span className="badge">{reviewStatusLabel(review.status)}</span>
      </div>

      {review.notes ? <p style={{ color: "var(--text-muted)" }}>{review.notes}</p> : null}

      <ReviewValueComparison payload={review.payload} />

      {(refs.artistAId || refs.artistBId || refs.personAId || refs.personBId || refs.organizationAId || refs.organizationBId || refs.albumId || refs.trackId) ? (
        <div className="section">
          <h2>Entidades relacionadas</h2>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {ENTITY_LINKS.filter((link) => refs[link.key] !== null).map((link) => (
              <Link key={link.key} to={entityHref(link.type, refs[link.key] as number, refs.albumId ?? undefined)} className="badge badge--outline">
                {link.label}: #{refs[link.key]}
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      <div className="section">
        <h2>Evidencia de origen</h2>
        <ReviewEvidenceList claims={review.claims} />
        <h3 className="payload-title">Payload completo</h3>
        <div className="evidence-block">{displayValue(review.payload)}</div>
      </div>

      {review.resolvedAt ? (
        <div className="section">
          <h2>Resolución</h2>
          <p style={{ color: "var(--text-muted)", fontSize: 13.5 }}>
            {review.resolvedBy} · {new Date(review.resolvedAt).toLocaleString("es-VE")}
            {review.resolutionNote ? ` — ${review.resolutionNote}` : ""}
          </p>
        </div>
      ) : null}

      <ReviewDecisionActions review={review} isAdmin={isAdmin} onDone={() => navigate("/curaduria")} />
    </>
  );
}
