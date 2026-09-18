import { Fragment, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { albumFormatWrites, albumWrites, albumsApi, trackWrites, ApiError } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useMovedToRedirect } from "../lib/useMovedTo";
import { useOperator } from "../lib/OperatorContext";
import { useToast } from "../lib/ToastContext";
import { LoadingState, ErrorState } from "../components/StateViews";
import { AliasEditor } from "../components/AliasEditor";
import { EntityFormModal } from "../components/EntityFormModal";
import { TrackAliasesSection } from "../components/TrackAliasesSection";
import { EntityPicker } from "../components/EntityPicker";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CreditManager } from "../components/CreditManager";
import { AlbumMergeModal } from "../components/AlbumMergeModal";
import { EntityHistory } from "../components/EntityHistory";
import { Modal } from "../components/Modal";
import { initialOf } from "../components/EntityCard";
import { ALBUM_FIELDS, TRACK_FIELDS } from "../lib/entityFields";
import { albumTypeLabel, formatDuration } from "../lib/labels";
import type { AlbumFormat, Track } from "../lib/types";

const CREDIT_SECTIONS: ReadonlyArray<{ title: string; types: readonly string[] }> = [
  { title: "Músicos", types: ["musician"] },
  { title: "Colaboradores / invitados", types: ["guest"] },
  { title: "Producción", types: ["producer", "recording", "mixing", "mastering"] },
  { title: "Composición", types: ["writer", "composer"] },
  { title: "Arte", types: ["artwork", "photography"] },
  { title: "Otros créditos", types: ["other"] },
];

export function AlbumDetailPage() {
  const { id } = useParams();
  const albumId = Number(id);
  const navigate = useNavigate();
  const { isAdmin } = useOperator();
  const { notify } = useToast();
  const { data: album, loading, error, errorValue, reload } = useAsync(() => albumsApi.get(albumId), [albumId]);
  useMovedToRedirect(errorValue);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [mergingAlbum, setMergingAlbum] = useState(false);
  const [addingTrack, setAddingTrack] = useState(false);
  const [editingTrack, setEditingTrack] = useState<Track | null>(null);
  const [trackAlbumId, setTrackAlbumId] = useState<number | null>(null);
  const [trackAlbumLabel, setTrackAlbumLabel] = useState<string | null>(null);
  const [removingTrack, setRemovingTrack] = useState<Track | null>(null);
  const [expandedTrack, setExpandedTrack] = useState<number | null>(null);
  const [addingFormat, setAddingFormat] = useState(false);
  const [editingFormat, setEditingFormat] = useState<AlbumFormat | null>(null);
  const [artistId, setArtistId] = useState<number | null>(null);
  const [artistLabel, setArtistLabel] = useState<string | null>(null);
  const [labelId, setLabelId] = useState<number | null>(null);
  const [labelLabel, setLabelLabel] = useState<string | null>(null);

  if (loading) return <LoadingState />;
  if (error || !album) return <ErrorState message={error ?? "Disco no encontrado."} onRetry={reload} />;

  const meta = [
    album.releaseYear ? String(album.releaseYear) : null,
    albumTypeLabel(album.albumType),
    album.genre,
  ].filter(Boolean);

  return (
    <>
      <Link to="/discos" className="back-link">← Discos</Link>

      <div className="entity-hero">
        <span className="entity-hero__art">
          {album.coverUrl ? <img src={album.coverUrl} alt="" /> : <span className="placeholder">{initialOf(album.title)}</span>}
        </span>
        <div>
          <h1 className="entity-hero__title">{album.title}</h1>
          <p style={{ margin: "6px 0 0" }}>
            <Link to={`/artistas/${album.artist.id}`} style={{ fontWeight: 600, color: "var(--text)" }}>{album.artist.name}</Link>
          </p>
          <div className="entity-hero__meta">
            {meta.map((item) => <span className="badge" key={String(item)}>{item}</span>)}
            {album.label ? <Link to={`/organizaciones/${album.label.id}`} className="badge badge--violet">{album.label.name}</Link> : null}
          </div>
          {album.description ? <p className="entity-hero__desc">{album.description}</p> : null}
        </div>
      </div>

      {isAdmin ? (
        <div className="page-actions" style={{ marginTop: 14 }}>
          <button type="button" className="btn btn--sm" onClick={() => {
            setArtistId(album.artist.id); setArtistLabel(album.artist.name);
            setLabelId(album.label?.id ?? null); setLabelLabel(album.label?.name ?? null); setEditing(true);
          }}>Editar</button>
          <button type="button" className="btn btn--sm" onClick={() => setMergingAlbum(true)}>Fusionar con…</button>
          <button type="button" className="btn btn--sm btn--danger" onClick={() => setDeleting(true)}>Retirar</button>
        </div>
      ) : null}

      <div className="section">
        <h2>Alias</h2>
        <AliasEditor path="albums" entityId={album.id} aliases={album.aliases} onChanged={reload} />
      </div>

      <div className="section">
        <h2>
          Lista de pistas <span className="mono" style={{ color: "var(--text-faint)", fontWeight: 400 }}>({album.tracklist.length})</span>
          {isAdmin ? <button type="button" className="btn btn--sm btn--ghost" onClick={() => setAddingTrack(true)}>+ Añadir pista</button> : null}
        </h2>
        {album.tracklist.length === 0 ? <p style={{ color: "var(--text-faint)", fontSize: 13.5 }}>Sin pistas registradas.</p> : (
          <div className="table-wrap table-wrap--scroll">
            <table>
              <thead><tr><th className="num">#</th><th>Título</th><th className="num">Duración</th><th className="num">Inicio en YouTube</th><th></th></tr></thead>
              <tbody>
                {album.tracklist.map((track) => (
                  <Fragment key={track.id}>
                    <tr>
                      <td className="num">{track.discNumber > 1 ? `${track.discNumber}.` : ""}{track.trackNumber}</td>
                      <td>
                        {track.title}
                        {track.credits.length > 0 ? (
                          <button type="button" className="btn btn--sm btn--ghost" style={{ marginLeft: 8 }}
                            onClick={() => setExpandedTrack(expandedTrack === track.id ? null : track.id)}>
                            {expandedTrack === track.id ? "ocultar créditos" : `créditos (${track.credits.length})`}
                          </button>
                        ) : null}
                      </td>
                      <td className="num">{formatDuration(track.durationSeconds)}</td>
                      <td className="num">{track.youtubeStartSeconds !== null ? formatDuration(track.youtubeStartSeconds) : "—"}</td>
                      <td className="row-actions">
                        {isAdmin ? (
                          <>
                            <button type="button" className="btn btn--sm" onClick={() => {
                              setEditingTrack(track); setTrackAlbumId(album.id); setTrackAlbumLabel(album.title);
                            }}>Editar</button>
                            <button type="button" className="btn btn--sm btn--danger" onClick={() => setRemovingTrack(track)}>Quitar</button>
                          </>
                        ) : null}
                      </td>
                    </tr>
                    {expandedTrack === track.id ? (
                      <tr>
                        <td colSpan={5} style={{ background: "var(--surface-2)" }}>
                          <CreditManager target={{ kind: "track", trackId: track.id }} credits={track.credits} onChanged={reload} compact />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="section">
        <h2>Créditos del disco</h2>
        <div className="credit-groups">
          {CREDIT_SECTIONS.map((section) => {
            const items = section.types.flatMap((type) => album.creditsByType[type] ?? []);
            return (
              <div className="credit-group" key={section.title}>
                <h3>{section.title}</h3>
                <CreditManager target={{ kind: "album", albumId: album.id }} credits={items} onChanged={reload} />
              </div>
            );
          })}
        </div>
      </div>

      <div className="section">
        <h2>
          Formatos
          {isAdmin ? <button type="button" className="btn btn--sm btn--ghost" onClick={() => setAddingFormat(true)}>+ Añadir formato</button> : null}
        </h2>
        {album.formats.length === 0 ? <p style={{ color: "var(--text-faint)", fontSize: 13.5 }}>Sin formatos registrados.</p> : (
          <ul style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {album.formats.map((format) => (
              <li key={format.id} className="chip">
                <span>{format.format}</span>
                {format.quality ? <span style={{ color: "var(--text-faint)", fontSize: 11 }}>{format.quality}</span> : null}
                <span className="badge" style={{ fontSize: 10 }}>{format.archiveStatus}</span>
                {isAdmin ? (
                  <>
                    <button type="button" className="btn btn--sm btn--ghost" style={{ padding: "2px 8px" }} onClick={() => setEditingFormat(format)}>Editar</button>
                    <FormatRemoveButton id={format.id} format={format.format} onDone={reload} />
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="section">
        <h2>YouTube</h2>
        {album.youtubeLinks.length === 0 ? <p style={{ color: "var(--text-faint)", fontSize: 13.5 }}>Sin videos relacionados.</p> : (
          <ul style={{ display: "grid", gap: 8 }}>
            {album.youtubeLinks.map((link) => (
              <li key={link.videoId} className="credit-row">
                <a href={`https://youtu.be/${link.videoId}`} target="_blank" rel="noreferrer">{link.title ?? link.videoId}</a>
                <span className="role">{link.isPrimaryLink ? <span className="badge badge--red">Principal</span> : link.kind}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <EntityHistory entity="album" id={album.id} />

      {editing ? (
        <EntityFormModal
          title={`Editar «${album.title}»`}
          fields={ALBUM_FIELDS}
          wide
          initialValues={{
            title: album.title, albumType: album.albumType, releaseYear: album.releaseYear, genre: album.genre,
            coverUrl: album.coverUrl, youtubeUrl: album.youtubeUrl, youtubeStatus: album.youtubeStatus,
            instagramUrl: album.instagramUrl, instagramStatus: album.instagramStatus,
            wordpressUrl: album.wordpressUrl, wordpressStatus: album.wordpressStatus,
            description: album.description, notes: album.notes,
          }}
          extraFields={
            <>
              <EntityPicker kind="artist" label="Artista (atribución del disco)" value={artistId} valueLabel={artistLabel}
                onSelect={(pickedId, label) => { setArtistId(pickedId); setArtistLabel(label); }} />
              <EntityPicker kind="organization" label="Sello discográfico" value={labelId} valueLabel={labelLabel}
                onSelect={(pickedId, label) => { setLabelId(pickedId); setLabelLabel(label); }} />
            </>
          }
          onSubmit={(values, note) => albumWrites.update(album.id, {
            ...values, labelId,
            ...(artistId !== null && artistId !== album.artist.id ? { artistId } : {}),
            note,
          })}
          onSuccess={() => { setEditing(false); reload(); notify("success", "Disco actualizado."); }}
          onClose={() => setEditing(false)}
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title={`Retirar «${album.title}»`}
          description="Se retira del catálogo. Si tiene pistas u otras dependencias, la API lo rechazará."
          confirmLabel="Retirar"
          danger
          onConfirm={async (note) => {
            await albumWrites.remove(album.id, note);
            notify("success", "Disco retirado.");
            navigate(`/artistas/${album.artist.id}`);
          }}
          onClose={() => setDeleting(false)}
        />
      ) : null}

      {addingTrack ? (
        <EntityFormModal
          title="Nueva pista"
          fields={TRACK_FIELDS}
          initialValues={{ discNumber: 1, trackNumber: album.tracklist.length + 1 }}
          onSubmit={(values, note) => trackWrites.create({ ...values, albumId: album.id, note })}
          onSuccess={() => { setAddingTrack(false); reload(); notify("success", "Pista añadida."); }}
          onClose={() => setAddingTrack(false)}
        />
      ) : null}

      {editingTrack ? (
        <EntityFormModal
          title={`Editar «${editingTrack.title}»`}
          fields={TRACK_FIELDS}
          initialValues={{
            title: editingTrack.title, discNumber: editingTrack.discNumber, trackNumber: editingTrack.trackNumber,
            durationSeconds: editingTrack.durationSeconds, youtubeStartSeconds: editingTrack.youtubeStartSeconds,
          }}
          extraFields={
            <>
              <EntityPicker kind="album" label="Disco al que pertenece" value={trackAlbumId} valueLabel={trackAlbumLabel}
                onSelect={(pickedId, label) => { setTrackAlbumId(pickedId); setTrackAlbumLabel(label); }} />
              <TrackAliasesSection trackId={editingTrack.id} onChanged={reload} />
            </>
          }
          onSubmit={(values, note) => trackWrites.update(editingTrack.id, {
            ...values,
            ...(trackAlbumId !== null && trackAlbumId !== album.id ? { albumId: trackAlbumId } : {}),
            note,
          })}
          onSuccess={() => { setEditingTrack(null); reload(); notify("success", "Pista actualizada."); }}
          onClose={() => setEditingTrack(null)}
        />
      ) : null}

      {removingTrack ? (
        <ConfirmDialog
          title={`Quitar «${removingTrack.title}»`}
          description="Se retira la pista y sus créditos propios; el historial queda en la ficha del disco."
          confirmLabel="Quitar"
          danger
          onConfirm={async (note) => {
            await trackWrites.remove(removingTrack.id, note);
            notify("success", "Pista retirada.");
            setRemovingTrack(null);
            reload();
          }}
          onClose={() => setRemovingTrack(null)}
        />
      ) : null}

      {addingFormat ? (
        <FormatFormModal albumId={album.id} onClose={() => setAddingFormat(false)} onDone={() => { setAddingFormat(false); reload(); }} />
      ) : null}

      {editingFormat ? (
        <FormatFormModal albumId={album.id} format={editingFormat} onClose={() => setEditingFormat(null)}
          onDone={() => { setEditingFormat(null); reload(); }} />
      ) : null}

      {mergingAlbum ? (
        <AlbumMergeModal
          albumId={album.id}
          albumTitle={album.title}
          onMerged={(keepId) => {
            setMergingAlbum(false);
            if (keepId === album.id) reload(); else navigate(`/discos/${keepId}`, { replace: true });
          }}
          onClose={() => setMergingAlbum(false)}
        />
      ) : null}
    </>
  );
}

function FormatRemoveButton({ id, format, onDone }: { id: number; format: string; onDone: () => void }) {
  const { notify } = useToast();
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <button type="button" aria-label={`Retirar formato ${format}`} onClick={() => setConfirming(true)}>×</button>
      {confirming ? (
        <ConfirmDialog
          title={`Retirar formato «${format}»`}
          description="El formato deja de estar disponible; su historia queda en la ficha del disco."
          confirmLabel="Retirar"
          danger
          onConfirm={async (note) => {
            await albumFormatWrites.remove(id, note);
            notify("success", "Formato retirado.");
            setConfirming(false);
            onDone();
          }}
          onClose={() => setConfirming(false)}
        />
      ) : null}
    </>
  );
}

const QUALITY_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "Sin dato" }, { value: "unknown", label: "Desconocida" }, { value: "HQ", label: "Alta" }, { value: "LQ", label: "Baja" },
];
const ARCHIVE_STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "unknown", label: "Desconocido" }, { value: "published", label: "Publicado" }, { value: "unpublished", label: "Sin publicar" },
];

/**
 * Alta y edición de un formato de archivo del disco (MP3, FLAC, vinilo…).
 * La edición viaja solo con lo que cambió y exige motivo, como el resto.
 */
function FormatFormModal({ albumId, format, onDone, onClose }: {
  albumId: number; format?: AlbumFormat; onDone: () => void; onClose: () => void;
}) {
  const editing = format !== undefined;
  const [name, setName] = useState(format?.format ?? "");
  const [quality, setQuality] = useState(format?.quality ?? "");
  const [archiveStatus, setArchiveStatus] = useState(format?.archiveStatus ?? "unknown");
  const [filePath, setFilePath] = useState(format?.filePath ?? "");
  const [notes, setNotes] = useState(format?.notes ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) { setError("El formato es obligatorio (MP3, FLAC, vinilo…)."); return; }
    if (editing && !note.trim()) { setError("El motivo es obligatorio (queda en la auditoría)."); return; }
    setBusy(true);
    setError(undefined);
    try {
      if (!format) {
        await albumFormatWrites.create({
          albumId, format: name.trim(), quality: quality === "" ? null : quality, archiveStatus,
          ...(filePath.trim() ? { filePath: filePath.trim() } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        });
      } else {
        const changes: Record<string, unknown> = {};
        if (name.trim() !== format.format) changes["format"] = name.trim();
        if ((quality === "" ? null : quality) !== format.quality) changes["quality"] = quality === "" ? null : quality;
        if (archiveStatus !== format.archiveStatus) changes["archiveStatus"] = archiveStatus;
        if ((filePath.trim() || null) !== format.filePath) changes["filePath"] = filePath.trim() || null;
        if ((notes.trim() || null) !== format.notes) changes["notes"] = notes.trim() || null;
        if (Object.keys(changes).length === 0) { setError("No hay cambios que guardar."); setBusy(false); return; }
        await albumFormatWrites.update(format.id, { ...changes, note: note.trim() });
      }
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo guardar.");
      setBusy(false);
    }
  }

  return (
    <Modal title={editing ? `Editar formato «${format.format}»` : "Añadir formato"} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        {error ? <p className="form-error-banner" role="alert">{error}</p> : null}
        <div className="form-grid">
          <div className="field">
            <label htmlFor="format-name">Formato *</label>
            <input id="format-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="MP3, FLAC, Vinilo…" />
          </div>
          <div className="field">
            <label htmlFor="format-quality">Calidad</label>
            <select id="format-quality" value={quality} onChange={(event) => setQuality(event.target.value)}>
              {QUALITY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="format-status">Estado del archivo</label>
            <select id="format-status" value={archiveStatus} onChange={(event) => setArchiveStatus(event.target.value)}>
              {ARCHIVE_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="format-path">Ruta del archivo</label>
            <input id="format-path" value={filePath} onChange={(event) => setFilePath(event.target.value)} placeholder="/mnt/datos/… (opcional)" />
          </div>
          <div className="field span-2">
            <label htmlFor="format-notes">Notas internas</label>
            <textarea id="format-notes" rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} />
          </div>
          {editing ? (
            <div className="field span-2">
              <label htmlFor="format-note">Motivo *</label>
              <textarea id="format-note" rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
            </div>
          ) : null}
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancelar</button>
          <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? "Guardando…" : editing ? "Guardar corrección" : "Añadir"}</button>
        </div>
      </form>
    </Modal>
  );
}
