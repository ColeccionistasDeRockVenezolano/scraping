import { Fragment, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { albumWrites, albumsApi, trackWrites, albumFormatWrites, ApiError } from "../lib/api";
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
import { Modal } from "../components/Modal";
import { initialOf } from "../components/EntityCard";
import { ALBUM_FIELDS, TRACK_FIELDS } from "../lib/entityFields";
import { albumTypeLabel, formatDuration } from "../lib/labels";
import type { Track } from "../lib/types";

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
  const [addingTrack, setAddingTrack] = useState(false);
  const [editingTrack, setEditingTrack] = useState<Track | null>(null);
  const [removingTrack, setRemovingTrack] = useState<Track | null>(null);
  const [expandedTrack, setExpandedTrack] = useState<number | null>(null);
  const [addingFormat, setAddingFormat] = useState(false);
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
            setLabelId(album.label?.id ?? null); setLabelLabel(album.label?.name ?? null); setEditing(true);
          }}>Editar</button>
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
                            <button type="button" className="btn btn--sm" onClick={() => setEditingTrack(track)}>Editar</button>
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
                  <FormatRemoveButton id={format.id} format={format.format} onDone={reload} />
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
            <EntityPicker kind="organization" label="Sello discográfico" value={labelId} valueLabel={labelLabel}
              onSelect={(pickedId, label) => { setLabelId(pickedId); setLabelLabel(label); }} />
          }
          onSubmit={(values, note) => albumWrites.update(album.id, { ...values, labelId, note })}
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
          extraFields={<TrackAliasesSection trackId={editingTrack.id} onChanged={reload} />}
          onSubmit={(values, note) => trackWrites.update(editingTrack.id, { ...values, note })}
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
        <AddFormatModal albumId={album.id} onClose={() => setAddingFormat(false)} onDone={() => { setAddingFormat(false); reload(); }} />
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

function AddFormatModal({ albumId, onClose, onDone }: { albumId: number; onClose: () => void; onDone: () => void }) {
  const [format, setFormat] = useState("");
  const [quality, setQuality] = useState("unknown");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!format.trim()) { setError("El formato es obligatorio (MP3, FLAC, vinilo…)."); return; }
    setBusy(true);
    try {
      await albumFormatWrites.create({ albumId, format: format.trim(), quality });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo añadir.");
      setBusy(false);
    }
  }

  return (
    <Modal title="Añadir formato" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        {error ? <p className="form-error-banner">{error}</p> : null}
        <div className="form-grid">
          <div className="field"><label>Formato *</label><input value={format} onChange={(event) => setFormat(event.target.value)} placeholder="MP3, FLAC, Vinilo…" /></div>
          <div className="field">
            <label>Calidad</label>
            <select value={quality} onChange={(event) => setQuality(event.target.value)}>
              <option value="unknown">Desconocida</option><option value="HQ">Alta</option><option value="LQ">Baja</option>
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
