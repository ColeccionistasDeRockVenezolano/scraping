// CRV · Decisión de una revisión viva de la cola: comparación de valores,
// evidencia de origen y los botones de aceptar/rechazar/resolver conflicto
// según el tipo (PLAN_CURADURIA E7.3). Un solo sitio de verdad para la página
// de detalle (/curaduria/revision/:id) y la tarjeta de un hallazgo
// `cola_de_revision` en Curaduría, que antes solo enlazaba a la página.
import { useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, reviewApi } from "../lib/api";
import { useToast } from "../lib/ToastContext";
import { trustLevelLabel } from "../lib/labels";
import type { ReviewActionResult, ReviewDetail } from "../lib/types";

/** Tipos que la API no decide: hace falta la CLI (ambigüedad con Mesa de careo). */
const CLI_ONLY: Readonly<Record<string, string>> = {
  youtube_match: "Se decide con `crv ambiguity:resolve` y se aplica con `crv ambiguity:apply --confirm` desde la CLI (ver reports/ambiguity-resolution.md).",
  possible_duplicate: "Se decide con `crv ambiguity:resolve` y se aplica con `crv ambiguity:apply --confirm` desde la CLI (ver reports/ambiguity-resolution.md).",
};

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function displayValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? "Sin valor";
}

export function ReviewValueComparison({ payload }: { payload: unknown }) {
  const data = objectValue(payload) ?? {};
  const currentValue = data["canonicalValue"] ?? data["currentValue"] ?? data["stored"];
  const proposedValue = data["proposedValue"] ?? data["incoming"];
  const confidence = data["confidence"] ?? data["category"];
  const field = data["field"];
  const proposals = Array.isArray(data["proposals"]) ? data["proposals"] : [];
  if (currentValue === undefined && proposedValue === undefined && field === undefined && confidence === undefined && proposals.length === 0) return null;
  return (
    <>
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
    </>
  );
}

export function ReviewEvidenceList({ claims }: { claims: ReviewDetail["claims"] }) {
  if (claims.length === 0) return null;
  return (
    <div className="evidence-claims">
      {claims.map((claim) => (
        <article className="evidence-card" key={claim.id}>
          <div className="evidence-card__header">
            <strong>{claim.sourceName}</strong>
            <span className="badge" title="Confianza declarada de la fuente">{trustLevelLabel(claim.sourceTrustLevel)}</span>
          </div>
          <p><span>Campo</span>{claim.field}</p>
          <pre>{displayValue(claim.rawValue)}</pre>
          {(claim.evidenceUrl ?? claim.sourceUrl) ? <a href={claim.evidenceUrl ?? claim.sourceUrl ?? "#"} target="_blank" rel="noreferrer">Abrir fuente original</a> : null}
        </article>
      ))}
    </div>
  );
}

/** Aceptar/rechazar/resolver conflicto, según `review.kind`; CLI-only muestra el porqué en vez de botones inútiles. */
export function ReviewDecisionActions({ review, isAdmin, onDone }: {
  review: ReviewDetail; isAdmin: boolean; onDone: (result: ReviewActionResult) => void;
}) {
  const { notify } = useToast();
  const [note, setNote] = useState("");
  const [choice, setChoice] = useState("canonical");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const isOpen = review.status === "open" || review.status === "in_progress";
  const cliHint = CLI_ONLY[review.kind];

  async function runAction(fn: () => Promise<ReviewActionResult>) {
    if (!note.trim()) { notify("error", "El motivo es obligatorio."); return; }
    setBusy(true);
    try {
      const result = await fn();
      notify("success", result.detail || "Listo.");
      onDone(result);
    } catch (err) {
      notify("error", err instanceof ApiError ? err.message : "No se pudo completar la acción.");
    } finally {
      setBusy(false);
    }
  }

  if (!isOpen) return null;
  if (!isAdmin) return <p className="form-note">Solo una cuenta administradora puede decidir esta revisión.</p>;
  if (cliHint) {
    // `possible_duplicate` con dos personas: el par también vive en «Posibles
    // duplicados» (detector nuevo, E11.5), con fusión y «son distintas» ya
    // resueltos ahí en vez de la CLI (PLAN_CURADURIA E7.3).
    if (review.kind === "possible_duplicate" && review.personAId !== null && review.personBId !== null) {
      return (
        <p className="form-note">
          Este par de personas también está en{" "}
          <Link to={`/curaduria/duplicados?a=${review.personAId}&b=${review.personBId}`}>Posibles duplicados</Link>, donde se fusiona o se marca como distinta.
        </p>
      );
    }
    return <p className="form-error-banner">{cliHint}</p>;
  }

  return (
    <div className="section">
      <h2>Decisión</h2>
      <div className="field span-2">
        <label htmlFor={`review-note-${review.id}`}>Motivo *</label>
        <textarea id={`review-note-${review.id}`} rows={2} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Por qué se decide así" />
      </div>

      {review.kind === "field_conflict" ? (
        <>
          <div className="field" style={{ maxWidth: 260, marginTop: 10 }}>
            <label htmlFor={`review-choice-${review.id}`}>Elegir</label>
            <select id={`review-choice-${review.id}`} value={choice} onChange={(event) => setChoice(event.target.value)}>
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
              <label htmlFor={`review-value-${review.id}`}>Valor correcto</label>
              <input id={`review-value-${review.id}`} value={value} onChange={(event) => setValue(event.target.value)} />
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
  );
}
