import { useState } from "react";
import { Link } from "react-router-dom";
import { albumCreditWrites, trackCreditWrites, ApiError } from "../lib/api";
import { CREDIT_TYPES, creditTypeLabel } from "../lib/labels";
import { useOperator } from "../lib/OperatorContext";
import { useToast } from "../lib/ToastContext";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { EntityPicker } from "./EntityPicker";
import { Modal } from "./Modal";
import type { Credit } from "../lib/types";

type CreditTarget = { kind: "album"; albumId: number } | { kind: "track"; trackId: number };

interface CreditManagerProps {
  target: CreditTarget;
  credits: Credit[];
  onChanged: () => void;
  compact?: boolean;
}

function creditedHref(credit: Credit): string | undefined {
  if (credit.personId !== null) return `/personas/${credit.personId}`;
  if (credit.artistId !== null) return `/artistas/${credit.artistId}`;
  if (credit.organizationId !== null) return `/organizaciones/${credit.organizationId}`;
  return undefined;
}

function creditedName(credit: Credit): string {
  return credit.personName ?? credit.artistName ?? credit.organizationName ?? "—";
}

export function CreditManager({ target, credits, onChanged, compact }: CreditManagerProps) {
  const { isConfigured } = useOperator();
  const { notify } = useToast();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Credit | null>(null);
  const writes = target.kind === "album" ? albumCreditWrites : trackCreditWrites;

  async function handleRemove(note: string) {
    if (!removing) return;
    await writes.remove(removing.id, note || "crédito retirado desde la interfaz");
    notify("success", "Crédito retirado.");
    setRemoving(null);
    onChanged();
  }

  return (
    <div>
      {credits.length === 0 ? (
        <p style={{ color: "var(--text-faint)", fontSize: compact ? 12.5 : 13.5 }}>Sin créditos registrados.</p>
      ) : (
        <ul style={{ display: "grid", gap: 6 }}>
          {credits.map((credit) => {
            const href = creditedHref(credit);
            return (
              <li key={credit.id} className="credit-row">
                <span>
                  <span className="who">{href ? <Link to={href}>{creditedName(credit)}</Link> : creditedName(credit)}</span>
                  {!compact ? <span style={{ color: "var(--text-faint)", fontSize: 11, marginLeft: 8 }}>{creditTypeLabel(credit.creditType)}</span> : null}
                </span>
                <span className="role">
                  {credit.role}
                  {isConfigured ? (
                    <button type="button" className="btn btn--sm btn--ghost" style={{ marginLeft: 8, padding: "2px 6px" }} onClick={() => setRemoving(credit)}>×</button>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {isConfigured ? (
        <button type="button" className="btn btn--sm btn--ghost" style={{ marginTop: 10 }} onClick={() => setAdding(true)}>+ Añadir crédito</button>
      ) : null}
      {adding ? <AddCreditModal target={target} onClose={() => setAdding(false)} onDone={() => { setAdding(false); onChanged(); }} /> : null}
      {removing ? (
        <ConfirmDialog
          title={`Retirar crédito de ${creditedName(removing)}`}
          description={`«${removing.role}» — no borra a la persona, artista u organización.`}
          confirmLabel="Retirar"
          danger
          requireNote={false}
          onConfirm={handleRemove}
          onClose={() => setRemoving(null)}
        />
      ) : null}
    </div>
  );
}

type CreditedKind = "person" | "artist" | "organization";

function AddCreditModal({ target, onClose, onDone }: { target: CreditTarget; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<CreditedKind>("person");
  const [entityId, setEntityId] = useState<number | null>(null);
  const [entityLabel, setEntityLabel] = useState<string | null>(null);
  const [role, setRole] = useState("");
  const [creditType, setCreditType] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const writes = target.kind === "album" ? albumCreditWrites : trackCreditWrites;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (entityId === null || !role.trim()) { setError("Elige a quién acreditar y el rol."); return; }
    setBusy(true);
    setError(undefined);
    try {
      await writes.create({
        ...(target.kind === "album" ? { albumId: target.albumId } : { trackId: target.trackId }),
        [`${kind}Id`]: entityId,
        role: role.trim(),
        ...(creditType ? { creditType } : {}),
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo añadir el crédito.");
      setBusy(false);
    }
  }

  return (
    <Modal title="Añadir crédito" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        {error ? <p className="form-error-banner">{error}</p> : null}
        <div className="field">
          <label>Se acredita a</label>
          <select value={kind} onChange={(event) => { setKind(event.target.value as CreditedKind); setEntityId(null); setEntityLabel(null); }}>
            <option value="person">Persona</option>
            <option value="artist">Artista/banda</option>
            <option value="organization">Organización</option>
          </select>
        </div>
        <EntityPicker kind={kind} label="Acreditado *" value={entityId} valueLabel={entityLabel}
          onSelect={(id, label) => { setEntityId(id); setEntityLabel(label); }} />
        <div className="form-grid" style={{ marginTop: 12 }}>
          <div className="field"><label>Rol (texto de la fuente) *</label><input value={role} onChange={(event) => setRole(event.target.value)} placeholder="Guitar & Backing Vocals, Recorded by…" /></div>
          <div className="field">
            <label>Tipo de crédito</label>
            <select value={creditType} onChange={(event) => setCreditType(event.target.value)}>
              <option value="">Clasificar automáticamente</option>
              {CREDIT_TYPES.map((type) => <option key={type} value={type}>{creditTypeLabel(type)}</option>)}
            </select>
          </div>
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancelar</button>
          <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? "Guardando…" : "Añadir"}</button>
        </div>
      </form>
    </Modal>
  );
}
