import { useState } from "react";
import { artistsApi, artistWrites, genresApi } from "../lib/api";
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
import { ARTIST_FIELDS } from "../lib/entityFields";
import { artistTypeLabel } from "../lib/labels";

export function ArtistsListPage() {
  const { isAdmin, user } = useOperator();
  const genre = useGenreFilter({ allowRelated: false });
  const facets = useAsync(() => genresApi.facets("artist"), []);
  const { data, loading, error, reload, q, offset, limit, setQuery, setOffset } = useEntityList(artistsApi.list, [user?.name], genre.apiParams);
  const genreLabel = genreSelectionLabel(facets.data, genre.selection);
  const filtered = Boolean(q.trim()) || genreLabel !== null;
  const { notify } = useToast();
  const [creating, setCreating] = useState(false);

  return (
    <>
      <div className="page-header">
        <div>
          <p className="page-kicker">Catálogo</p>
          <h1>Artistas y bandas</h1>
        </div>
        {isAdmin ? <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>+ Nuevo artista</button> : null}
      </div>

      <div className="list-toolbar">
        <input className="filter-input" type="search" value={q} onChange={(event) => setQuery(event.target.value)}
          placeholder="Filtrar por nombre…" aria-label="Filtrar artistas por nombre" />
      </div>

      <GenreFilter kind="artist" facets={facets.data} facetsError={facets.error} onRetryFacets={facets.reload}
        selection={genre.selection} onFamily={genre.selectFamily} onSub={genre.selectSub} onStyle={genre.selectStyle} onRelated={genre.setRelated}
        onFamilyRelated={genre.selectFamilyRelated} />

      <ListSummary total={data?.pagination.total} noun={{ one: "artista", many: "artistas" }} loading={loading}
        query={q} genreLabel={genreLabel} onClearQuery={() => setQuery("")} onClearGenre={genre.clear} />

      {loading && !data ? <CardGridSkeleton count={12} label="Cargando artistas…" /> : error ? <ErrorState message={error} onRetry={reload} /> : !data || data.data.length === 0 ? (
        <EmptyState title={filtered ? "Ningún artista coincide con estos filtros" : "No hay artistas para mostrar"}
          hint={filtered ? "Prueba con otro género o quita alguno de los filtros." : undefined}
          action={filtered ? <button type="button" className="btn btn--sm" onClick={() => { setQuery(""); genre.clear(); }}>Quitar filtros</button> : null} />
      ) : (
        <>
          <div className={`grid-cards${loading ? " is-refreshing" : ""}`}>
            {data.data.map((artist) => (
              <EntityCard
                key={artist.id}
                to={`/artistas/${artist.id}`}
                title={artist.name}
                deceased={artist.isDeceased}
                subtitle={[artistTypeLabel(artist.artistType), artist.originCity].filter(Boolean).join(" · ")}
                imageUrl={artist.pictureUrl}
                placeholder={initialOf(artist.name)}
                genre={artist.primaryGenre?.name}
                tag={artist.genreByLaya ? "Género por Laya" : null}
                tagTitle="Género principal elegido por Laya (último recurso), directo o por sus discos. Solo visible con sesión iniciada."
              />
            ))}
          </div>
          <Pagination limit={limit} offset={offset} total={data.pagination.total} onOffsetChange={setOffset} />
        </>
      )}

      {creating ? (
        <EntityFormModal
          title="Nuevo artista"
          fields={ARTIST_FIELDS}
          initialValues={{ artistType: "band", originCountry: "Venezuela" }}
          onSubmit={(values, note) => artistWrites.create({ ...values, note })}
          onSuccess={() => { setCreating(false); reload(); notify("success", "Artista creado."); }}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </>
  );
}
