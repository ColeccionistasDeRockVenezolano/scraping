// CRV · E7: decidir conflictos/revisiones sin salir de la tarjeta de Curaduría.
import { useState } from "react";
import { Link } from "react-router-dom";
import { Check, GitMerge, X } from "@phosphor-icons/react";
import { ApiError, curationApi, reviewApi } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useToast } from "../lib/ToastContext";
import { Modal } from "./Modal";
import type { ConflictDecisionDetail, CurationFinding, ReviewDetail } from "../lib/types";

const CLI_ONLY = new Set(["possible_duplicate", "youtube_match"]);

function valueText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function dateText(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("es-VE");
}

interface EvidenceSide {
  sourceName: string;
  sourceTrustLevel: string;
  claimCreatedAt: string;
  evidenceUrl: string | null;
  sourceUrl: string | null;
}

function ClaimEvidence({ value, claim, label }: { value: unknown; claim: EvidenceSide; label: string }) {
  const url = claim.evidenceUrl ?? claim.sourceUrl;
  return (
    <div className="decision-side">
      <span className="decision-side__label">{label}</span>
      <strong className="decision-side__value">{valueText(value)}</strong>
      <span>{claim.sourceName}</span>
      <span className="badge badge--outline">fuente {claim.sourceTrustLevel}</span>
      <span>{dateText(claim.claimCreatedAt)}</span>
      {url ? <a className="text-link" href={url} target="_blank" rel="noopener noreferrer">Ver evidencia</a> : null}
    </div>
  );
}

type Decision =
  | { mode: "review-accept"; review: ReviewDetail }
  | { mode: "review-reject"; review: ReviewDetail }
  | { mode: "review-conflict"; review: ReviewDetail; side?: "a" | "b"; custom?: boolean }
  | { mode: "conflict"; conflict: ConflictDecisionDetail; side?: "a" | "b"; custom?: boolean };

export function CurationDecisionPanel({ finding, onDone }: { finding: CurationFinding; onDone: () => void }) {
  const { notify } = useToast();
  const [decision, setDecision] = useState<Decision | null>(null);
  const [note, setNote] = useState("");
  const [custom, setCustom] = useState("");
  const [saving, setSaving] = useState(false);

  const reviewId = finding.entity.kind === "review" ? finding.entity.id : null;
  const conflictId = finding.entity.kind === "conflict"
    ? finding.entity.id
    : typeof finding.evidence["conflictId"] === "number" ? finding.evidence["conflictId"] : null;

  const review = useAsync(
    () => reviewId === null ? Promise.resolve(undefined) : reviewApi.get(reviewId),
    [reviewId],
  );
  const conflict = useAsync(
    () => finding.detector !== "conflictos_abiertos" || conflictId === null
      ? Promise.resolve(undefined)
      : curationApi.conflict(conflictId),
    [finding.detector, conflictId],
  );

  const currentReview = review.data;
  const currentConflict = conflict.data;

  async function submit() {
    if (!decision || !note.trim()) return;
    setSaving(true);
    try {
      if (decision.mode === "review-accept") {
        await reviewApi.accept(decision.review.id, note.trim());
      } else if (decision.mode === "review-reject") {
        await reviewApi.reject(decision.review.id, note.trim());
      } else if (decision.mode === "review-conflict") {
        if (decision.custom) await reviewApi.resolveConflict(decision.review.id, note.trim(), undefined, custom);
        else await reviewApi.resolveConflict(decision.review.id, note.trim(), decision.side);
      } else if (decision.custom) {
        await curationApi.resolveConflict(decision.conflict.id, { value: custom, note: note.trim() });
      } else {
        await curationApi.resolveConflict(decision.conflict.id, { side: decision.side!, note: note.trim() });
      }
      notify("success", "Decisión guardada con auditoría.");
      setDecision(null);
      setNote("");
      setCustom("");
      onDone();
    } catch (error) {
      notify("error", error instanceof ApiError ? error.message : "No se pudo guardar la decisión.");
    } finally {
      setSaving(false);
    }
  }

  if (review.loading || conflict.loading) return <p className="hint" role="status">Cargando evidencia…</p>;
  if (review.error || conflict.error) return <p className="form-error-banner">{review.error ?? conflict.error}</p>;

  if (currentReview) {
    if (currentReview.kind === "person_duplicate") {
      const query = new URLSearchParams({ reviewId: String(currentReview.id) });
      if (currentReview.personAId) query.set("a", String(currentReview.personAId));
      if (currentReview.personBId) query.set("b", String(currentReview.personBId));
      return (
        <div className="cfind__decision">
          <Link className="btn btn--sm btn--primary" to={`/curaduria/duplicados?${query.toString()}`}>
            <GitMerge size={14} weight="bold" aria-hidden="true" /> Comparar este par
          </Link>
        </div>
      );
    }

    if (currentReview.kind === "field_conflict" && currentReview.claims.length >= 2) {
      const [a, b] = currentReview.claims;
      return (
        <div className="cfind__decision">
          <div className="decision-grid">
            <ClaimEvidence label="A" value={a!.normalizedValue ?? a!.rawValue} claim={a!} />
            <ClaimEvidence label="B" value={b!.normalizedValue ?? b!.rawValue} claim={b!} />
          </div>
          <div className="cfind__actions">
            <button className="btn btn--sm btn--primary" type="button" onClick={() => setDecision({ mode: "review-conflict", review: currentReview, side: "a" })}>Elegir A</button>
            <button className="btn btn--sm btn--primary" type="button" onClick={() => setDecision({ mode: "review-conflict", review: currentReview, side: "b" })}>Elegir B</button>
            <button className="btn btn--sm btn--outline" type="button" onClick={() => setDecision({ mode: "review-conflict", review: currentReview, custom: true })}>Otro valor</button>
          </div>
          {decision ? <DecisionModal decision={decision} note={note} custom={custom} saving={saving} setNote={setNote} setCustom={setCustom} onSubmit={() => void submit()} onClose={() => setDecision(null)} /> : null}
        </div>
      );
    }

    if (CLI_ONLY.has(currentReview.kind)) {
      return <Link className="text-link" to={`/curaduria/revision/${currentReview.id}`}>Abrir revisión especializada</Link>;
    }

    return (
      <div className="cfind__decision">
        <div className="cfind__actions">
          <button className="btn btn--sm btn--primary" type="button" onClick={() => setDecision({ mode: "review-accept", review: currentReview })}>
            <Check size={14} aria-hidden="true" /> Aceptar
          </button>
          <button className="btn btn--sm btn--outline" type="button" onClick={() => setDecision({ mode: "review-reject", review: currentReview })}>
            <X size={14} aria-hidden="true" /> Rechazar
          </button>
        </div>
        {decision ? <DecisionModal decision={decision} note={note} custom={custom} saving={saving} setNote={setNote} setCustom={setCustom} onSubmit={() => void submit()} onClose={() => setDecision(null)} /> : null}
      </div>
    );
  }

  if (currentConflict) {
    return (
      <div className="cfind__decision">
        <div className="decision-grid">
          <ClaimEvidence label="A" value={currentConflict.valueA} claim={currentConflict.claimA} />
          <ClaimEvidence label="B" value={currentConflict.valueB} claim={currentConflict.claimB} />
        </div>
        <div className="cfind__actions">
          <button className="btn btn--sm btn--primary" type="button" onClick={() => setDecision({ mode: "conflict", conflict: currentConflict, side: "a" })}>Elegir A</button>
          <button className="btn btn--sm btn--primary" type="button" onClick={() => setDecision({ mode: "conflict", conflict: currentConflict, side: "b" })}>Elegir B</button>
          <button className="btn btn--sm btn--outline" type="button" onClick={() => setDecision({ mode: "conflict", conflict: currentConflict, custom: true })}>Otro valor</button>
        </div>
        {decision ? <DecisionModal decision={decision} note={note} custom={custom} saving={saving} setNote={setNote} setCustom={setCustom} onSubmit={() => void submit()} onClose={() => setDecision(null)} /> : null}
      </div>
    );
  }

  return null;
}

function DecisionModal({ decision, note, custom, saving, setNote, setCustom, onSubmit, onClose }: {
  decision: Decision;
  note: string;
  custom: string;
  saving: boolean;
  setNote: (value: string) => void;
  setCustom: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const isCustom = (decision.mode === "review-conflict" || decision.mode === "conflict") && decision.custom === true;
  return (
    <Modal title="Confirmar decisión" onClose={onClose}>
      {isCustom ? (
        <div className="field">
          <label htmlFor="curation-decision-value">Valor correcto</label>
          <input id="curation-decision-value" value={custom} onChange={(event) => setCustom(event.target.value)} autoFocus />
        </div>
      ) : null}
      <div className="field">
        <label htmlFor="curation-decision-note">Motivo *</label>
        <textarea
          id="curation-decision-note" rows={3} value={note} onChange={(event) => setNote(event.target.value)}
          placeholder="Por qué esta es la decisión correcta (queda firmada en la auditoría)" autoFocus={!isCustom}
        />
      </div>
      <div className="form-actions">
        <button className="btn" type="button" onClick={onClose} disabled={saving}>Cancelar</button>
        <button className="btn btn--primary" type="button" onClick={onSubmit} disabled={saving || !note.trim() || (isCustom && !custom.trim())}>
          {saving ? "Guardando…" : "Guardar decisión"}
        </button>
      </div>
    </Modal>
  );
}
