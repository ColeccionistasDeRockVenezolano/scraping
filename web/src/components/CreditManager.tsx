import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { PencilSimple, Trash } from "@phosphor-icons/react";
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

type CreditedKind = "person" | "artist" | "organization";

function creditedKind(credit: Credit): CreditedKind {
  if (credit.artistId !== null) return "artist";
  if (credit.organizationId !== null) return "organization";
  return "person";
}

function creditedId(credit: Credit, kind: CreditedKind): number | null {
  if (kind === "artist") return credit.artistId;
  if (kind === "organization") return credit.organizationId;
  return credit.personId;
}

export function CreditManager({ target, credits, onChanged, compact }: CreditManagerProps) {
  const { isAdmin } = useOperator();
  const { notify } = useToast();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Credit | null>(null);
  const [removing, setRemoving] = useState<Credit | null>(null);
  const writes = target.kind === "album" ? albumCreditWrites : trackCreditWrites;

  async function handleRemove(note: string) {
    if (!removing) return;
    await writes.remove(removing.id, note);
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
                <span className="role" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  {credit.role}
                  {isAdmin ? (
                    <>
                      <button
                        type="button" className="btn btn--sm btn--ghost" style={{ marginLeft: 8, padding: "2px 6px" }}
                        onClick={() => setEditing(credit)}
                        aria-label={`Editar crédito de ${creditedName(credit)}`}
                        title="Corregir este crédito (rol, tipo o a quién acredita)"
                      >
                        <PencilSimple size={14} weight="bold" aria-hidden="true" />
                      </button>
                      <button
                        type="button" className="btn btn--sm btn--ghost" style={{ padding: "2px 6px" }}
                        aria-label={`Retirar crédito de ${creditedName(credit)}`}
                        title={`Retirar crédito de ${creditedName(credit)}`}
                        onClick={() => setRemoving(credit)}
                      >
                        <Trash size={14} weight="bold" aria-hidden="true" />
                      </button>
                    </>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {isAdmin ? (
        <button type="button" className="btn btn--sm btn--ghost" style={{ marginTop: 10 }} onClick={() => setAdding(true)}>+ Añadir crédito</button>
      ) : null}
      {adding ? <AddCreditModal target={target} onClose={() => setAdding(false)} onDone={() => { setAdding(false); onChanged(); }} /> : null}
      {editing ? (
        <EditCreditModal target={target} credit={editing} onClose={() => setEditing(null)}
          onDone={() => { setEditing(null); onChanged(); }} />
      ) : null}
      {removing ? (
        <ConfirmDialog
          title={`Retirar crédito de ${creditedName(removing)}`}
          description={`«${removing.role}» — no borra a la persona, artista u organización.`}
          confirmLabel="Retirar"
          danger
          onConfirm={handleRemove}
          onClose={() => setRemoving(null)}
        />
      ) : null}
    </div>
  );
}

function AddCreditModal({ target, onClose, onDone }: { target: CreditTarget; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<CreditedKind>("person");
  const [entityId, setEntityId] = useState<number | null>(null);
  const [entityLabel, setEntityLabel] = useState<string | null>(null);
  const [role, setRole] = useState("");
  const [creditType, setCreditType] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const kindId = useId();
  const roleId = useId();
  const typeId = useId();
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
          <label htmlFor={kindId}>Se acredita a</label>
          <select id={kindId} value={kind} onChange={(event) => { setKind(event.target.value as CreditedKind); setEntityId(null); setEntityLabel(null); }}>
            <option value="person">Persona</option>
            <option value="artist">Artista/banda</option>
            <option value="organization">Organización</option>
          </select>
        </div>
        <EntityPicker kind={kind} label="Acreditado *" value={entityId} valueLabel={entityLabel}
          onSelect={(id, label) => { setEntityId(id); setEntityLabel(label); }} />
        <div className="form-grid" style={{ marginTop: 12 }}>
          <div className="field"><label htmlFor={roleId}>Rol (texto de la fuente) *</label><input id={roleId} value={role} onChange={(event) => setRole(event.target.value)} placeholder="Guitar & Backing Vocals, Recorded by…" /></div>
          <div className="field">
            <label htmlFor={typeId}>Tipo de crédito</label>
            <select id={typeId} value={creditType} onChange={(event) => setCreditType(event.target.value)}>
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

/**
 * Edición completa de un crédito ya registrado: el rol, su tipo y a quién
 * acredita. Solo viaja lo que cambió; a quién acredita viaja como el extremo
 * del nuevo tipo (persona, artista u organización), que la API sustituye con
 * auditoría —soltando el anterior— y rechaza si dejara un crédito duplicado.
 */
function EditCreditModal({ target, credit, onDone, onClose }: {
  target: CreditTarget; credit: Credit; onDone: () => void; onClose: () => void;
}) {
  const [kind, setKind] = useState<CreditedKind>(creditedKind(credit));
  const [entityId, setEntityId] = useState<number | null>(creditedId(credit, creditedKind(credit)));
  const [entityLabel, setEntityLabel] = useState<string | null>(creditedName(credit));
  const [role, setRole] = useState(credit.role);
  const [creditType, setCreditType] = useState(credit.creditType);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const kindId = useId();
  const noteId = useId();
  const roleId = useId();
  const typeId = useId();
  const writes = target.kind === "album" ? albumCreditWrites : trackCreditWrites;

  const originalKind = creditedKind(credit);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!role.trim()) { setError("El rol es obligatorio."); return; }
    if (entityId === null) { setError("Elige a quién acredita."); return; }
    if (!note.trim()) { setError("La nota es obligatoria (queda en la auditoría)."); return; }
    const changes: Record<string, unknown> = {};
    if (role.trim() !== credit.role) changes["role"] = role.trim();
    if (creditType !== credit.creditType) changes["creditType"] = creditType;
    if (kind !== originalKind || entityId !== creditedId(credit, originalKind)) {
      changes[`${kind}Id`] = entityId;
    }
    if (Object.keys(changes).length === 0) { setError("No hay cambios que guardar."); return; }
    setBusy(true);
    setError(undefined);
    try {
      await writes.update(credit.id, { ...changes, note: note.trim() });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo corregir el crédito.");
      setBusy(false);
    }
  }

  return (
    <Modal title="Corregir crédito" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        {error ? <p className="form-error-banner" role="alert">{error}</p> : null}
        <div className="field">
          <label htmlFor={kindId}>Se acredita a</label>
          <select id={kindId} value={kind} onChange={(event) => {
            const next = event.target.value as CreditedKind;
            setKind(next);
            // Al cambiar de tipo, el extremo anterior ya no aplica: se elige de nuevo.
            setEntityId(null); setEntityLabel(null);
          }}>
            <option value="person">Persona</option>
            <option value="artist">Artista/banda</option>
            <option value="organization">Organización</option>
          </select>
        </div>
        <EntityPicker kind={kind} label="Acreditado *" value={entityId} valueLabel={entityLabel}
          onSelect={(id, label) => { setEntityId(id); setEntityLabel(label); }} />
        <div className="form-grid" style={{ marginTop: 12 }}>
          <div className="field"><label htmlFor={roleId}>Rol (texto de la fuente) *</label><input id={roleId} value={role} onChange={(event) => setRole(event.target.value)} /></div>
          <div className="field">
            <label htmlFor={typeId}>Tipo de crédito</label>
            <select id={typeId} value={creditType} onChange={(event) => setCreditType(event.target.value)}>
              {CREDIT_TYPES.map((type) => <option key={type} value={type}>{creditTypeLabel(type)}</option>)}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor={noteId}>Motivo *</label>
          <textarea id={noteId} rows={2} value={note} onChange={(event) => setNote(event.target.value)}
            placeholder="Qué estaba mal y por qué se corrige (queda en la auditoría)" />
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancelar</button>
          <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? "Guardando…" : "Guardar corrección"}</button>
        </div>
      </form>
    </Modal>
  );
}
