import { useState } from "react";
import { albumsApi, albumWrites } from "../lib/api";
import { useEntityList } from "../lib/useEntityList";
import { useOperator } from "../lib/OperatorContext";
import { useToast } from "../lib/ToastContext";
import { LoadingState, ErrorState, EmptyState } from "../components/StateViews";
import { EntityCard, initialOf } from "../components/EntityCard";
import { Pagination } from "../components/Pagination";
import { EntityFormModal } from "../components/EntityFormModal";
import { EntityPicker } from "../components/EntityPicker";
import { ALBUM_FIELDS } from "../lib/entityFields";
import { albumTypeLabel } from "../lib/labels";

export function AlbumsListPage() {
  const { data, loading, error, reload, q, offset, limit, setQuery, setOffset } = useEntityList(albumsApi.list);
  const { isConfigured } = useOperator();
  const { notify } = useToast();
  const [creating, setCreating] = useState(false);
  const [artistId, setArtistId] = useState<number | null>(null);
  const [artistLabel, setArtistLabel] = useState<string | null>(null);

  return (
    <>
      <div className="page-header">
        <div>
          <p className="page-kicker">Catálogo</p>
          <h1>Discos</h1>
        </div>
        {isConfigured ? <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>+ Nuevo disco</button> : null}
      </div>

      <div className="list-toolbar">
        <input className="filter-input" defaultValue={q} onChange={(event) => setQuery(event.target.value)} placeholder="Filtrar por título…" />
      </div>

      {loading ? <LoadingState /> : error ? <ErrorState message={error} onRetry={reload} /> : !data || data.data.length === 0 ? (
        <EmptyState title="No hay discos para mostrar" hint={q ? "Prueba con otro filtro." : undefined} />
      ) : (
        <>
          <div className="grid-cards">
            {data.data.map((album) => (
              <EntityCard
                key={album.id}
                to={`/discos/${album.id}`}
                title={album.title}
                subtitle={[album.artistName, album.releaseYear, albumTypeLabel(album.albumType)].filter(Boolean).join(" · ")}
                imageUrl={album.coverUrl}
                placeholder={initialOf(album.title)}
              />
            ))}
          </div>
          <Pagination limit={limit} offset={offset} total={data.pagination.total} onOffsetChange={setOffset} />
        </>
      )}

      {creating ? (
        <EntityFormModal
          title="Nuevo disco"
          fields={ALBUM_FIELDS}
          initialValues={{ albumType: "studio_album" }}
          extraFields={
            <EntityPicker kind="artist" label="Artista *" value={artistId} valueLabel={artistLabel}
              onSelect={(id, label) => { setArtistId(id); setArtistLabel(label); }} />
          }
          onSubmit={(values, note) => {
            if (artistId === null) return Promise.reject(new Error("Selecciona un artista."));
            return albumWrites.create({ ...values, artistId, note });
          }}
          onSuccess={() => { setCreating(false); setArtistId(null); setArtistLabel(null); reload(); notify("success", "Disco creado."); }}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </>
  );
}
