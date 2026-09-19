// CRV · Vínculos persona ↔ organización (alta, edición y retiro).
//
// La misma tabla puente se gestiona desde las dos fichas: en la persona
// («en qué organizaciones estuvo») y en la organización («qué personas pasaron
// por aquí»). La edición permite corregir el rol, el periodo o el OTRO extremo
// (la persona u organización equivocada), que la API sustituye con auditoría.
import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { PencilSimple, Trash } from "@phosphor-icons/react";
import { personOrganizationWrites, ApiError } from "../lib/api";
import { useToast } from "../lib/ToastContext";
import { ConfirmDialog } from "./ConfirmDialog";
import { EntityPicker } from "./EntityPicker";
import { Modal } from "./Modal";

export interface PersonOrgRow {
  id: number;
  role: string;
  fromYear: number | null;
  toYear: number | null;
  /** El otro extremo: la organización (si la ficha es de persona) o la persona. */
  otherId: number;
  otherName: string;
}

interface PersonOrgManagerProps {
  /** Extremo fijo de esta ficha. */
  fixedKind: "person" | "organization";
  fixedId: number;
  rows: PersonOrgRow[];
  onChanged: () => void;
  emptyText: string;
}

export function PersonOrgManager({ fixedKind, fixedId, rows, onChanged, emptyText }: PersonOrgManagerProps) {
  const { notify } = useToast();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<PersonOrgRow | null>(null);
  const [removing, setRemoving] = useState<PersonOrgRow | null>(null);

  return (
    <div>
      {rows.length === 0 ? (
        <p style={{ color: "var(--text-faint)", fontSize: 13.5 }}>{emptyText}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">{fixedKind === "person" ? "Organización" : "Persona"}</th>
                <th scope="col">Rol</th>
                <th scope="col">Periodo</th>
                <th scope="col"><span className="visually-hidden">Acciones</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    {fixedKind === "person"
                      ? <Link to={`/organizaciones/${row.otherId}`}>{row.otherName}</Link>
                      : <Link to={`/personas/${row.otherId}`}>{row.otherName}</Link>}
                  </td>
                  <td>{row.role}</td>
                  <td className="mono">{row.fromYear ?? "—"}{row.toYear ? `–${row.toYear}` : ""}</td>
                  <td className="row-actions">
                    <button type="button" className="btn btn--sm" onClick={() => setEditing(row)} title="Corregir rol, periodo o el vínculo">
                      <PencilSimple size={14} weight="bold" aria-hidden="true" />Editar
                    </button>
                    <button type="button" className="btn btn--sm btn--danger" onClick={() => setRemoving(row)}>
                      <Trash size={14} weight="bold" aria-hidden="true" />Quitar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <button type="button" className="btn btn--sm btn--ghost" style={{ marginTop: 10 }} onClick={() => setAdding(true)}>
        {fixedKind === "person" ? "+ Añadir organización" : "+ Añadir persona"}
      </button>

      {adding ? (
        <PersonOrgFormModal fixedKind={fixedKind} fixedId={fixedId} onClose={() => setAdding(false)}
          onDone={() => { setAdding(false); onChanged(); }} />
      ) : null}

      {editing ? (
        <PersonOrgFormModal fixedKind={fixedKind} fixedId={fixedId} row={editing} onClose={() => setEditing(null)}
          onDone={() => { setEditing(null); onChanged(); }} />
      ) : null}

      {removing ? (
        <ConfirmDialog
          title={`Quitar el vínculo con ${removing.otherName}`}
          description={`Se retira «${removing.role}»; no borra ni a la persona ni a la organización.`}
          confirmLabel="Quitar"
          danger
          onConfirm={async (note) => {
            await personOrganizationWrites.remove(removing.id, note);
            notify("success", "Vínculo retirado.");
            setRemoving(null);
            onChanged();
          }}
          onClose={() => setRemoving(null)}
        />
      ) : null}
    </div>
  );
}

function PersonOrgFormModal({ fixedKind, fixedId, row, onDone, onClose }: {
  fixedKind: "person" | "organization"; fixedId: number; row?: PersonOrgRow; onDone: () => void; onClose: () => void;
}) {
  const editing = row !== undefined;
  const otherKind = fixedKind === "person" ? "organization" : "person";
  const [otherId, setOtherId] = useState<number | null>(row?.otherId ?? null);
  const [otherLabel, setOtherLabel] = useState<string | null>(row?.otherName ?? null);
  const [role, setRole] = useState(row?.role ?? "");
  const [fromYear, setFromYear] = useState(row?.fromYear === null || row?.fromYear === undefined ? "" : String(row.fromYear));
  const [toYear, setToYear] = useState(row?.toYear === null || row?.toYear === undefined ? "" : String(row.toYear));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const noteId = useId();
  const roleId = useId();
  const fromId = useId();
  const toId = useId();
  const { notify } = useToast();

  function parseYear(value: string): number | null {
    const text = value.trim();
    return text ? Number(text) : null;
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (otherId === null || !role.trim()) { setError(`Elige la ${otherKind === "person" ? "persona" : "organización"} y el rol.`); return; }
    const nextFrom = parseYear(fromYear);
    const nextTo = parseYear(toYear);
    if ((nextFrom !== null && (!Number.isInteger(nextFrom) || nextFrom < 1000 || nextFrom > 9999))
      || (nextTo !== null && (!Number.isInteger(nextTo) || nextTo < 1000 || nextTo > 9999))) {
      setError("Los años van de 1000 a 9999."); return;
    }
    if (nextFrom !== null && nextTo !== null && nextTo < nextFrom) { setError("El año final no puede ser anterior al inicial."); return; }
    if (!note.trim()) { setError("El motivo es obligatorio (queda en la auditoría)."); return; }
    setBusy(true);
    setError(undefined);
    try {
      if (!row) {
        await personOrganizationWrites.create({
          ...(fixedKind === "person" ? { personId: fixedId, organizationId: otherId } : { organizationId: fixedId, personId: otherId }),
          role: role.trim(),
          ...(nextFrom === null ? {} : { fromYear: nextFrom }),
          ...(nextTo === null ? {} : { toYear: nextTo }),
          note: note.trim(),
        });
        notify("success", "Vínculo registrado.");
      } else {
        const changes: Record<string, unknown> = {};
        if (otherId !== row.otherId) changes[otherKind === "person" ? "personId" : "organizationId"] = otherId;
        if (role.trim() !== row.role) changes["role"] = role.trim();
        if (nextFrom !== row.fromYear) changes["fromYear"] = nextFrom;
        if (nextTo !== row.toYear) changes["toYear"] = nextTo;
        if (Object.keys(changes).length === 0) { setError("No hay cambios que guardar."); setBusy(false); return; }
        await personOrganizationWrites.update(row.id, { ...changes, note: note.trim() });
        notify("success", "Vínculo actualizado.");
      }
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo guardar.");
      setBusy(false);
    }
  }

  return (
    <Modal
      title={editing
        ? `Corregir vínculo con ${row.otherName}`
        : fixedKind === "person" ? "Añadir organización" : "Añadir persona"}
      onClose={onClose}
    >
      <form onSubmit={handleSubmit}>
        {error ? <p className="form-error-banner" role="alert">{error}</p> : null}
        <EntityPicker kind={otherKind} label={otherKind === "person" ? "Persona *" : "Organización *"}
          value={otherId} valueLabel={otherLabel}
          onSelect={(id, label) => { setOtherId(id); setOtherLabel(label); }} />
        <div className="form-grid" style={{ marginTop: 12 }}>
          <div className="field"><label htmlFor={roleId}>Rol *</label><input id={roleId} value={role} onChange={(event) => setRole(event.target.value)} placeholder="Ingeniero de mezcla, presidente…" /></div>
          <div className="field"><label htmlFor={fromId}>Desde (año)</label><input id={fromId} type="number" value={fromYear} onChange={(event) => setFromYear(event.target.value)} /></div>
          <div className="field"><label htmlFor={toId}>Hasta (año)</label><input id={toId} type="number" value={toYear} onChange={(event) => setToYear(event.target.value)} /></div>
          <div className="field span-2">
            <label htmlFor={noteId}>Motivo *</label>
            <textarea id={noteId} rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
          </div>
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancelar</button>
          <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? "Guardando…" : editing ? "Guardar corrección" : "Añadir"}</button>
        </div>
      </form>
    </Modal>
  );
}
