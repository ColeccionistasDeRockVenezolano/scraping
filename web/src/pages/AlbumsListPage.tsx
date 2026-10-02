import { useState } from "react";
import { albumsApi, albumWrites, genresApi } from "../lib/api";
import { useEntityList } from "../lib/useEntityList";
import { useAsync } from "../lib/useAsync";
import { useGenreFilter } from "../lib/useGenreFilter";
import { GenreFilter, ListSummary, genreSelectionLabel } from "../components/GenreFilter";
import { useOperator } from "../lib/OperatorContext";
import { useToast } from "../lib/ToastContext";
import { ErrorState, EmptyState } from "../components/StateViews";
import { CardGridSkeleton } from "../components/Skeletons";
import { EntityCard, initialOf } from "../components/EntityCard";
import { Pagination } from "../components/Pagination";
import { EntityFormModal } from "../components/EntityFormModal";
import { EntityPicker } from "../components/EntityPicker";
import { ALBUM_FIELDS } from "../lib/entityFields";
import { albumTypeLabel } from "../lib/labels";

export function AlbumsListPage() {
  const { isAdmin, user } = useOperator();
  const genre = useGenreFilter({ allowRelated: true });
  const facets = useAsync(() => genresApi.facets("album"), []);
  const { data, loading, error, reload, q, offset, limit, setQuery, setOffset } = useEntityList(albumsApi.list, [user?.name], genre.apiParams);
  const genreLabel = genreSelectionLabel(facets.data, genre.selection);
  const filtered = Boolean(q.trim()) || genreLabel !== null;
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
        {isAdmin ? <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>+ Nuevo disco</button> : null}
      </div>

      <div className="list-toolbar">
        <input className="filter-input" type="search" value={q} onChange={(event) => setQuery(event.target.value)}
          placeholder="Filtrar por título…" aria-label="Filtrar discos por título" />
      </div>

      <GenreFilter kind="album" facets={facets.data} facetsError={facets.error} onRetryFacets={facets.reload}
        selection={genre.selection} onFamily={genre.selectFamily} onSub={genre.selectSub} onRelated={genre.setRelated}
        onFamilyRelated={genre.selectFamilyRelated} />

      <ListSummary total={data?.pagination.total} noun={{ one: "disco", many: "discos" }} loading={loading}
        query={q} genreLabel={genreLabel} onClearQuery={() => setQuery("")} onClearGenre={genre.clear} />

      {loading && !data ? <CardGridSkeleton count={12} label="Cargando discos…" /> : error ? <ErrorState message={error} onRetry={reload} /> : !data || data.data.length === 0 ? (
        <EmptyState title={filtered ? "Ningún disco coincide con estos filtros" : "No hay discos para mostrar"}
          hint={filtered ? "Prueba con otro género o quita alguno de los filtros." : undefined}
          action={filtered ? <button type="button" className="btn btn--sm" onClick={() => { setQuery(""); genre.clear(); }}>Quitar filtros</button> : null} />
      ) : (
        <>
          <div className={`grid-cards${loading ? " is-refreshing" : ""}`}>
            {data.data.map((album) => (
              <EntityCard
                key={album.id}
                to={`/discos/${album.id}`}
                title={album.title}
                subtitle={[album.artistName, album.releaseYear, albumTypeLabel(album.albumType)].filter(Boolean).join(" · ")}
                imageUrl={album.coverUrl}
                placeholder={initialOf(album.title)}
                genre={album.primaryGenre?.name}
                note={genre.selection.related && album.hasOwnGenre === false ? "Por su artista" : null}
                noteTitle="Este disco aún no tiene género propio: aparece por el género de su artista."
                tag={album.genreByLaya ? "Género por Laya" : null}
                tagTitle="Género principal elegido por Laya (último recurso). Solo visible con sesión iniciada."
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
