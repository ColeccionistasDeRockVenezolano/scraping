import { useState } from "react";
import { organizationsApi, organizationWrites } from "../lib/api";
import { useEntityList } from "../lib/useEntityList";
import { useOperator } from "../lib/OperatorContext";
import { useToast } from "../lib/ToastContext";
import { LoadingState, ErrorState, EmptyState } from "../components/StateViews";
import { EntityCard, initialOf } from "../components/EntityCard";
import { Pagination } from "../components/Pagination";
import { EntityFormModal } from "../components/EntityFormModal";
import { ORGANIZATION_FIELDS } from "../lib/entityFields";
import { organizationTypeLabel } from "../lib/labels";

export function OrganizationsListPage() {
  const { data, loading, error, reload, q, offset, limit, setQuery, setOffset } = useEntityList(organizationsApi.list);
  const { isConfigured } = useOperator();
  const { notify } = useToast();
  const [creating, setCreating] = useState(false);

  return (
    <>
      <div className="page-header">
        <div>
          <p className="page-kicker">Catálogo</p>
          <h1>Organizaciones</h1>
        </div>
        {isConfigured ? <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>+ Nueva organización</button> : null}
      </div>

      <div className="list-toolbar">
        <input className="filter-input" defaultValue={q} onChange={(event) => setQuery(event.target.value)} placeholder="Filtrar por nombre…" />
      </div>

      {loading ? <LoadingState /> : error ? <ErrorState message={error} onRetry={reload} /> : !data || data.data.length === 0 ? (
        <EmptyState title="No hay organizaciones para mostrar" hint={q ? "Prueba con otro filtro." : undefined} />
      ) : (
        <>
          <div className="grid-cards">
            {data.data.map((org) => (
              <EntityCard
                key={org.id}
                to={`/organizaciones/${org.id}`}
                title={org.name}
                subtitle={[organizationTypeLabel(org.organizationType), org.country].filter(Boolean).join(" · ")}
                placeholder={initialOf(org.name)}
              />
            ))}
          </div>
          <Pagination limit={limit} offset={offset} total={data.pagination.total} onOffsetChange={setOffset} />
        </>
      )}

      {creating ? (
        <EntityFormModal
          title="Nueva organización"
          fields={ORGANIZATION_FIELDS}
          initialValues={{ organizationType: "record_label" }}
          onSubmit={(values, note) => organizationWrites.create({ ...values, note })}
          onSuccess={() => { setCreating(false); reload(); notify("success", "Organización creada."); }}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </>
  );
}
