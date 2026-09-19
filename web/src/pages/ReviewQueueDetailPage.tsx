import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError, reviewApi } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useOperator } from "../lib/OperatorContext";
import { useToast } from "../lib/ToastContext";
import { ErrorState } from "../components/StateViews";
import { HeaderSkeleton, RowsSkeleton } from "../components/Skeletons";
import { entityHref } from "../lib/routes";
import { reviewKindLabel, reviewStatusLabel } from "../lib/labels";

const CLI_ONLY: Record<string, string> = {
  youtube_match: "Se decide con `crv ambiguity:resolve` y se aplica con `crv ambiguity:apply --confirm` desde la CLI (ver reports/ambiguity-resolution.md).",
  possible_duplicate: "Se decide con `crv ambiguity:resolve` y se aplica con `crv ambiguity:apply --confirm` desde la CLI (ver reports/ambiguity-resolution.md).",
};

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

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function displayValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? "Sin valor";
}

export function ReviewQueueDetailPage() {
  const { id } = useParams();
  const reviewId = Number(id);
  const navigate = useNavigate();
  const { isAdmin } = useOperator();
  const { notify } = useToast();
  const { data: review, loading, error, reload } = useReviewDetail(reviewId);
  const [note, setNote] = useState("");
  const [choice, setChoice] = useState("canonical");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  if (loading) return (
    <div role="status" aria-label="Cargando la revisión…">
      <HeaderSkeleton />
      <RowsSkeleton rows={3} height={96} />
    </div>
  );
  if (error || !review) return <ErrorState message={error ?? "Revisión no encontrada."} onRetry={reload} />;

  const isOpen = review.status === "open" || review.status === "in_progress";
  const cliHint = CLI_ONLY[review.kind];
  const refs = entityRefs(review);
  const payload = objectValue(review.payload) ?? {};
  const currentValue = payload["canonicalValue"] ?? payload["currentValue"] ?? payload["stored"];
  const proposedValue = payload["proposedValue"] ?? payload["incoming"];
  const confidence = payload["confidence"] ?? payload["category"];
  const field = payload["field"];
  const proposals = Array.isArray(payload["proposals"]) ? payload["proposals"] : [];

  async function runAction(fn: () => Promise<{ detail: string }>) {
    if (!note.trim()) { notify("error", "El motivo es obligatorio."); return; }
    setBusy(true);
    try {
      const result = await fn();
      notify("success", result.detail || "Listo.");
      navigate("/curaduria");
    } catch (err) {
      notify("error", err instanceof ApiError ? err.message : "No se pudo completar la acción.");
    } finally {
      setBusy(false);
    }
  }

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

      {(field !== undefined || confidence !== undefined || proposals.length > 0) ? (
        <dl className="review-facts">
          {field !== undefined ? <div><dt>Campo</dt><dd>{displayValue(field)}</dd></div> : null}
          {confidence !== undefined ? <div><dt>Confianza</dt><dd>{displayValue(confidence)}</dd></div> : null}
          {proposals.length > 0 ? <div><dt>Entidad candidata</dt><dd>{proposals.map((proposal) => displayValue(objectValue(proposal)?.["label"] ?? proposal)).join(" · ")}</dd></div> : null}
        </dl>
      ) : null}

      {(currentValue !== undefined || proposedValue !== undefined) ? (
        <div className="compare-grid section">
          <div className="compare-side"><h4>Valor actual</h4><pre>{displayValue(currentValue)}</pre></div>
          <div className="compare-side"><h4>Valor propuesto</h4><pre>{displayValue(proposedValue)}</pre></div>
        </div>
      ) : null}

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
        {review.claims.length > 0 ? (
          <div className="evidence-claims">
            {review.claims.map((claim) => (
              <article className="evidence-card" key={claim.id}>
                <div className="evidence-card__header"><strong>{claim.sourceName}</strong><span className="badge">{claim.confidence}</span></div>
                <p><span>Campo</span>{claim.field}</p>
                <pre>{displayValue(claim.rawValue)}</pre>
                {(claim.evidenceUrl ?? claim.sourceUrl) ? <a href={claim.evidenceUrl ?? claim.sourceUrl ?? "#"} target="_blank" rel="noreferrer">Abrir fuente original</a> : null}
              </article>
            ))}
          </div>
        ) : null}
        <h3 className="payload-title">Payload completo</h3>
        <div className="evidence-block">{JSON.stringify(review.payload, null, 2)}</div>
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

      {!isOpen ? null : !isAdmin ? (
        <p className="form-note">Solo una cuenta administradora puede decidir esta revisión.</p>
      ) : cliHint ? (
        <p className="form-error-banner">{cliHint}</p>
      ) : (
        <div className="section">
          <h2>Decisión</h2>
          <div className="field span-2">
            <label htmlFor="review-note">Motivo *</label>
            <textarea id="review-note" rows={2} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Por qué se decide así" />
          </div>

          {review.kind === "field_conflict" ? (
            <>
              <div className="field" style={{ maxWidth: 260, marginTop: 10 }}>
                <label htmlFor="review-choice">Elegir</label>
                <select id="review-choice" value={choice} onChange={(event) => setChoice(event.target.value)}>
                  <option value="canonical">Valor actual</option>
                  <option value="proposed">Valor propuesto</option>
                  <option value="a">Lado A</option>
                  <option value="b">Lado B</option>
                  <option value="both">Conservar ambos</option>
                  <option value="dismiss">Descartar</option>
                  <option value="value">Afirmar un valor distinto…</option>
                </select>
              </div>
              {choice === "value" ? (
                <div className="field span-2" style={{ marginTop: 10 }}>
                  <label htmlFor="review-value">Valor correcto</label>
                  <input id="review-value" value={value} onChange={(event) => setValue(event.target.value)} />
                </div>
              ) : null}
              <div className="form-actions">
                <button type="button" className="btn btn--primary" disabled={busy}
                  onClick={() => runAction(() => reviewApi.resolveConflict(review.id, note, choice === "value" ? undefined : choice, choice === "value" ? value : undefined))}>
                  {busy ? "Guardando…" : "Resolver conflicto"}
                </button>
              </div>
            </>
          ) : (
            <div className="form-actions">
              <button type="button" className="btn btn--danger" disabled={busy} onClick={() => runAction(() => reviewApi.reject(review.id, note))}>
                Rechazar
              </button>
              <button type="button" className="btn btn--primary" disabled={busy} onClick={() => runAction(() => reviewApi.accept(review.id, note))}>
                Aceptar
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
