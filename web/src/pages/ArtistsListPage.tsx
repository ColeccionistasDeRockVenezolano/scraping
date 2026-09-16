import { useState } from "react";
import { artistsApi, artistWrites } from "../lib/api";
import { useEntityList } from "../lib/useEntityList";
import { useOperator } from "../lib/OperatorContext";
import { useToast } from "../lib/ToastContext";
import { LoadingState, ErrorState, EmptyState } from "../components/StateViews";
import { EntityCard, initialOf } from "../components/EntityCard";
import { Pagination } from "../components/Pagination";
import { EntityFormModal } from "../components/EntityFormModal";
import { ARTIST_FIELDS } from "../lib/entityFields";
import { artistTypeLabel } from "../lib/labels";

export function ArtistsListPage() {
  const { data, loading, error, reload, q, offset, limit, setQuery, setOffset } = useEntityList(artistsApi.list);
  const { isAdmin } = useOperator();
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
        <input className="filter-input" defaultValue={q} onChange={(event) => setQuery(event.target.value)} placeholder="Filtrar por nombre…" />
      </div>

      {loading ? <LoadingState /> : error ? <ErrorState message={error} onRetry={reload} /> : !data || data.data.length === 0 ? (
        <EmptyState title="No hay artistas para mostrar" hint={q ? "Prueba con otro filtro." : undefined} />
      ) : (
        <>
          <div className="grid-cards">
            {data.data.map((artist) => (
              <EntityCard
                key={artist.id}
                to={`/artistas/${artist.id}`}
                title={artist.name}
                subtitle={[artistTypeLabel(artist.artistType), artist.originCity].filter(Boolean).join(" · ")}
                imageUrl={artist.pictureUrl}
                placeholder={initialOf(artist.name)}
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
