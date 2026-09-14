import { useState } from "react";
import { personsApi, personWrites } from "../lib/api";
import { useEntityList } from "../lib/useEntityList";
import { useOperator } from "../lib/OperatorContext";
import { useToast } from "../lib/ToastContext";
import { LoadingState, ErrorState, EmptyState } from "../components/StateViews";
import { EntityCard, initialOf } from "../components/EntityCard";
import { Pagination } from "../components/Pagination";
import { EntityFormModal } from "../components/EntityFormModal";
import { PERSON_FIELDS } from "../lib/entityFields";

export function PersonsListPage() {
  const { data, loading, error, reload, q, offset, limit, setQuery, setOffset } = useEntityList(personsApi.list);
  const { isConfigured } = useOperator();
  const { notify } = useToast();
  const [creating, setCreating] = useState(false);

  return (
    <>
      <div className="page-header">
        <div>
          <p className="page-kicker">Catálogo</p>
          <h1>Personas</h1>
        </div>
        {isConfigured ? <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>+ Nueva persona</button> : null}
      </div>

      <div className="list-toolbar">
        <input className="filter-input" defaultValue={q} onChange={(event) => setQuery(event.target.value)} placeholder="Filtrar por nombre…" />
      </div>

      {loading ? <LoadingState /> : error ? <ErrorState message={error} onRetry={reload} /> : !data || data.data.length === 0 ? (
        <EmptyState title="No hay personas para mostrar" hint={q ? "Prueba con otro filtro." : undefined} />
      ) : (
        <>
          <div className="grid-cards">
            {data.data.map((person) => (
              <EntityCard
                key={person.id}
                to={`/personas/${person.id}`}
                title={person.name}
                subtitle={person.nationality}
                imageUrl={person.pictureUrl}
                placeholder={initialOf(person.name)}
              />
            ))}
          </div>
          <Pagination limit={limit} offset={offset} total={data.pagination.total} onOffsetChange={setOffset} />
        </>
      )}

      {creating ? (
        <EntityFormModal
          title="Nueva persona"
          fields={PERSON_FIELDS}
          initialValues={{ isVenezuelan: true }}
          onSubmit={(values, note) => personWrites.create({ ...values, note })}
          onSuccess={() => { setCreating(false); reload(); notify("success", "Persona creada."); }}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </>
  );
}
