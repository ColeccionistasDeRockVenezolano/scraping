import { useId, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { GitMerge, PencilSimple, Trash } from "@phosphor-icons/react";
import { artistsApi, artistMemberWrites, artistWrites } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useMovedToRedirect } from "../lib/useMovedTo";
import { useOperator } from "../lib/OperatorContext";
import { useToast } from "../lib/ToastContext";
import { ErrorState } from "../components/StateViews";
import { DetailSkeleton } from "../components/Skeletons";
import { EntityCard, initialOf } from "../components/EntityCard";
import { AliasEditor } from "../components/AliasEditor";
import { EntityFormModal } from "../components/EntityFormModal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { MergeEntityModal } from "../components/MergeEntityModal";
import { EntityHistory } from "../components/EntityHistory";
import { EntityPicker } from "../components/EntityPicker";
import { Modal } from "../components/Modal";
import { ARTIST_FIELDS } from "../lib/entityFields";
import { artistTypeLabel } from "../lib/labels";
import type { ArtistMember } from "../lib/types";

export function ArtistDetailPage() {
  const { id } = useParams();
  const artistId = Number(id);
  const navigate = useNavigate();
  const { isAdmin } = useOperator();
  const { notify } = useToast();
  const { data: artist, loading, error, errorValue, reload } = useAsync(() => artistsApi.get(artistId), [artistId]);
  useMovedToRedirect(errorValue);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [addingMember, setAddingMember] = useState(false);
  const [editingMember, setEditingMember] = useState<ArtistMember | null>(null);
  const [merging, setMerging] = useState(false);

  if (loading) return <DetailSkeleton />;
  if (error || !artist) return <ErrorState message={error ?? "Artista no encontrado."} onRetry={reload} />;

  const meta = [artistTypeLabel(artist.artistType), artist.originCity ?? artist.originCountry,
    artist.formedYear ? `${artist.formedYear}${artist.disbandedYear ? `–${artist.disbandedYear}` : "–presente"}` : null]
    .filter(Boolean);

  return (
    <>
      <Link to="/artistas" className="back-link">← Artistas</Link>

      <div className="entity-hero">
        <span className="entity-hero__art">
          {artist.pictureUrl ? <img src={artist.pictureUrl} alt="" loading="lazy" decoding="async" /> : <span className="placeholder">{initialOf(artist.name)}</span>}
        </span>
        <div>
          <h1 className="entity-hero__title">{artist.name}</h1>
          <div className="entity-hero__meta">
            {meta.map((item) => <span className="badge" key={String(item)}>{item}</span>)}
          </div>
          {artist.biography ? <p className="entity-hero__desc">{artist.biography}</p> : null}
        </div>
      </div>

      {isAdmin ? (
        <div className="page-actions" style={{ marginTop: 14 }}>
          <button type="button" className="btn btn--sm" onClick={() => setEditing(true)}>
            <PencilSimple size={14} weight="bold" aria-hidden="true" />Editar
          </button>
          <button type="button" className="btn btn--sm" onClick={() => setMerging(true)}>
            <GitMerge size={14} weight="bold" aria-hidden="true" />Fusionar con…
          </button>
          <button type="button" className="btn btn--sm btn--danger" onClick={() => setDeleting(true)}>
            <Trash size={14} weight="bold" aria-hidden="true" />Retirar
          </button>
        </div>
      ) : null}

      <div className="section">
        <h2>Alias</h2>
        <AliasEditor path="artists" entityId={artist.id} aliases={artist.aliases} onChanged={reload} />
      </div>

      <div className="section">
        <h2>
          Miembros
          {isAdmin ? <button type="button" className="btn btn--sm btn--ghost" onClick={() => setAddingMember(true)}>+ Añadir miembro</button> : null}
        </h2>
        {artist.members.length === 0 ? <p style={{ color: "var(--text-faint)", fontSize: 13.5 }}>Sin miembros registrados.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Persona</th><th>Rol</th><th>Periodo</th><th></th></tr></thead>
              <tbody>
                {artist.members.map((member) => (
                  <MemberRow key={member.id} member={member} canEdit={isAdmin} onEdit={() => setEditingMember(member)} onChanged={reload} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="section">
        <h2>Discografía <span className="mono" style={{ color: "var(--text-faint)", fontWeight: 400 }}>({artist.discography.length})</span></h2>
        {artist.discography.length === 0 ? <p style={{ color: "var(--text-faint)", fontSize: 13.5 }}>Sin discos registrados.</p> : (
          <div className="grid-cards">
            {artist.discography.map((album) => (
              <EntityCard key={album.albumId} to={`/discos/${album.albumId}`} title={album.title}
                subtitle={album.releaseYear ? String(album.releaseYear) : undefined} imageUrl={album.coverUrl} placeholder={initialOf(album.title)} />
            ))}
          </div>
        )}
      </div>

      <EntityHistory entity="artist" id={artist.id} />

      {editing ? (
        <EntityFormModal
          title={`Editar «${artist.name}»`}
          fields={ARTIST_FIELDS}
          initialValues={{
            name: artist.name, artistType: artist.artistType, originCountry: artist.originCountry, originCity: artist.originCity,
            formedYear: artist.formedYear, disbandedYear: artist.disbandedYear, pictureUrl: artist.pictureUrl,
            biography: artist.biography, notes: artist.notes,
          }}
          onSubmit={(values, note) => artistWrites.update(artist.id, { ...values, note })}
          onSuccess={() => { setEditing(false); reload(); notify("success", "Artista actualizado."); }}
          onClose={() => setEditing(false)}
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title={`Retirar «${artist.name}»`}
          description="Se retira del catálogo. Si tiene discos u otras dependencias, la API lo rechazará."
          confirmLabel="Retirar"
          danger
          onConfirm={async (note) => {
            await artistWrites.remove(artist.id, note);
            notify("success", "Artista retirado.");
            navigate("/artistas");
          }}
          onClose={() => setDeleting(false)}
        />
      ) : null}

      {addingMember ? (
        <MemberFormModal artistId={artist.id} onClose={() => setAddingMember(false)} onDone={() => { setAddingMember(false); reload(); }} />
      ) : null}

      {editingMember ? (
        <MemberFormModal artistId={artist.id} member={editingMember} onClose={() => setEditingMember(null)}
          onDone={() => { setEditingMember(null); reload(); }} />
      ) : null}

      {merging ? (
        <MergeEntityModal
          kind="artist"
          entityId={artist.id}
          entityName={artist.name}
          onMerged={(keepId) => { setMerging(false); navigate(`/artistas/${keepId}`, { replace: true }); }}
          onClose={() => setMerging(false)}
        />
      ) : null}
    </>
  );
}

function MemberRow({ member, canEdit, onEdit, onChanged }: { canEdit: boolean; onEdit: () => void; onChanged: () => void; member: ArtistMember }) {
  const { notify } = useToast();
  const [removing, setRemoving] = useState(false);

  return (
    <tr>
      <td><Link to={`/personas/${member.personId}`}>{member.personName}</Link></td>
      <td>{member.role}</td>
      <td className="mono">{member.fromYear ?? "—"}{member.isCurrent ? "–presente" : member.toYear ? `–${member.toYear}` : ""}</td>
      <td className="row-actions">
        {canEdit ? (
          <>
            <button type="button" className="btn btn--sm" onClick={onEdit} title="Corregir rol, periodo o persona">
              <PencilSimple size={14} weight="bold" aria-hidden="true" />Editar
            </button>
            <button type="button" className="btn btn--sm btn--danger" onClick={() => setRemoving(true)}>
              <Trash size={14} weight="bold" aria-hidden="true" />Quitar
            </button>
          </>
        ) : null}
      </td>
      {removing ? (
        <ConfirmDialog
          title={`Quitar a ${member.personName}`}
          description="Se retira la membresía; no borra a la persona ni sus créditos."
          confirmLabel="Quitar"
          danger
          onConfirm={async (note) => {
            await artistMemberWrites.remove(member.id, note);
            notify("success", "Miembro retirado.");
            setRemoving(false);
            onChanged();
          }}
          onClose={() => setRemoving(false)}
        />
      ) : null}
    </tr>
  );
}

/**
 * Alta y edición de una membresía. En edición solo viaja lo que cambió; la
 * persona se corrige con su extremo (la API la sustituye con auditoría).
 */
function MemberFormModal({ artistId, member, onDone, onClose }: {
  artistId: number; member?: ArtistMember; onDone: () => void; onClose: () => void;
}) {
  const editing = member !== undefined;
  const [personId, setPersonId] = useState<number | null>(member?.personId ?? null);
  const [personLabel, setPersonLabel] = useState<string | null>(member?.personName ?? null);
  const [role, setRole] = useState(member?.role ?? "");
  const [fromYear, setFromYear] = useState(member?.fromYear === null || member?.fromYear === undefined ? "" : String(member.fromYear));
  const [toYear, setToYear] = useState(member?.toYear === null || member?.toYear === undefined ? "" : String(member.toYear));
  const [isCurrent, setIsCurrent] = useState(member?.isCurrent ?? false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const currentId = useId();
  const roleId = useId();
  const fromId = useId();
  const toId = useId();
  const noteId = useId();
  const { notify } = useToast();

  function parseYear(value: string): number | null {
    const text = value.trim();
    if (!text) return null;
    return Number(text);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (personId === null || !role.trim()) { setError("Persona y rol son obligatorios."); return; }
    const nextFrom = parseYear(fromYear);
    const nextTo = isCurrent ? null : parseYear(toYear);
    if ((nextFrom !== null && (!Number.isInteger(nextFrom) || nextFrom < 1000 || nextFrom > 9999))
      || (nextTo !== null && (!Number.isInteger(nextTo) || nextTo < 1000 || nextTo > 9999))) {
      setError("Los años van de 1000 a 9999."); return;
    }
    if (nextFrom !== null && nextTo !== null && nextTo < nextFrom) { setError("El año final no puede ser anterior al inicial."); return; }
    if (!note.trim()) { setError("El motivo es obligatorio."); return; }
    setBusy(true);
    setError(undefined);
    try {
      if (!member) {
        await artistMemberWrites.create({
          artistId, personId, role: role.trim(), isCurrent,
          ...(nextFrom === null ? {} : { fromYear: nextFrom }),
          ...(nextTo === null ? {} : { toYear: nextTo }),
          note: note.trim(),
        });
        notify("success", "Miembro añadido.");
      } else {
        const changes: Record<string, unknown> = {};
        if (personId !== member.personId) changes["personId"] = personId;
        if (role.trim() !== member.role) changes["role"] = role.trim();
        if (nextFrom !== member.fromYear) changes["fromYear"] = nextFrom;
        if (nextTo !== member.toYear) changes["toYear"] = nextTo;
        if (isCurrent !== member.isCurrent) changes["isCurrent"] = isCurrent;
        if (Object.keys(changes).length === 0) { setError("No hay cambios que guardar."); setBusy(false); return; }
        await artistMemberWrites.update(member.id, { ...changes, note: note.trim() });
        notify("success", "Miembro actualizado.");
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar.");
      setBusy(false);
    }
  }

  return (
    <Modal title={editing ? `Corregir membresía de ${member.personName}` : "Añadir miembro"} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        {error ? <p className="form-error-banner" role="alert">{error}</p> : null}
        <EntityPicker kind="person" label="Persona *" value={personId} valueLabel={personLabel}
          onSelect={(id, label) => { setPersonId(id); setPersonLabel(label); }} />
        <div className="form-grid" style={{ marginTop: 12 }}>
          <div className="field"><label htmlFor={roleId}>Rol *</label><input id={roleId} value={role} onChange={(event) => setRole(event.target.value)} placeholder="Guitarra, voz…" /></div>
          <div className="field"><label htmlFor={fromId}>Desde (año)</label><input id={fromId} type="number" value={fromYear} onChange={(event) => setFromYear(event.target.value)} /></div>
          <div className="field"><label htmlFor={toId}>Hasta (año)</label><input id={toId} type="number" value={isCurrent ? "" : toYear} disabled={isCurrent} onChange={(event) => setToYear(event.target.value)} /></div>
          <div className="checkbox-field field">
            <input id={currentId} type="checkbox" checked={isCurrent} onChange={(event) => setIsCurrent(event.target.checked)} />
            <label htmlFor={currentId}>Miembro actual</label>
          </div>
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
