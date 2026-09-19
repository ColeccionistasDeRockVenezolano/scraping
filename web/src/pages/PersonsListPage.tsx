import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { personsApi, personWrites } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useDebouncedQuery } from "../lib/useDebouncedQuery";
import { useOperator } from "../lib/OperatorContext";
import { useToast } from "../lib/ToastContext";
import { ErrorState, EmptyState } from "../components/StateViews";
import { CardGridSkeleton } from "../components/Skeletons";
import { EntityCard, initialOf } from "../components/EntityCard";
import { Pagination } from "../components/Pagination";
import { EntityFormModal } from "../components/EntityFormModal";
import { PERSON_FIELDS } from "../lib/entityFields";
import { nameClassLabel } from "../lib/labels";

const LIMIT = 30;
const SUSPECT_CLASSES = ["organization_like", "duration", "fragment", "multiple_people"] as const;

/** Buscador y filtros de personas (E11.9): la consulta ignora tildes. */
export function PersonsListPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const hasCredits = params.get("hasCredits") === "false" ? false : undefined;
  const suspect = params.get("suspect") ?? "";
  const sort = params.get("sort") === "credits" ? "credits" as const : "name" as const;
  const offset = Number(params.get("offset") ?? "0") || 0;

  const { isAdmin } = useOperator();
  const { notify } = useToast();
  const [creating, setCreating] = useState(false);

  const { data, loading, error, reload } = useAsync(
    () => personsApi.list({
      limit: LIMIT, offset, sort,
      ...(q.trim() ? { q: q.trim() } : {}),
      ...(hasCredits === false ? { hasCredits } : {}),
      ...(suspect ? { suspect } : {}),
    }),
    [q, hasCredits, suspect, sort, offset],
  );

  function update(next: Record<string, string | undefined>) {
    const merged = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined || value === "") merged.delete(key); else merged.set(key, value);
    }
    merged.delete("offset");
    setParams(merged, { replace: true });
  }

  // La consulta se aplica con retardo (patrón compartido con las otras
  // listas): teclear no dispara una petición ni una entrada de historial por
  // letra; el resto de filtros siguen siendo inmediatos.
  const [query, setQuery] = useDebouncedQuery(q, (value) => update({ q: value }));

  return (
    <>
      <div className="page-header">
        <div>
          <p className="page-kicker">Catálogo</p>
          <h1>Personas</h1>
          <p className="page-lead">Busca sin tildes, filtra por fichas sin créditos o por nombres sospechosos.</p>
        </div>
        {isAdmin ? <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>+ Nueva persona</button> : null}
      </div>

      <div className="list-toolbar">
        <input
          className="filter-input" value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder="Buscar por nombre o alias (jose encuentra «José»)…"
          aria-label="Buscar personas"
        />
        <label className="checkbox-field" style={{ fontSize: 13 }}>
          <input
            type="checkbox" checked={hasCredits === false}
            onChange={(event) => update({ hasCredits: event.target.checked ? "false" : undefined })}
          />
          Solo sin créditos
        </label>
        <label className="visually-hidden" htmlFor="person-suspect">Filtrar por nombres sospechosos</label>
        <select id="person-suspect" className="filter-input" value={suspect} onChange={(event) => update({ suspect: event.target.value })}>
          <option value="">Todas las fichas</option>
          {SUSPECT_CLASSES.map((value) => <option key={value} value={value}>Sospechosas: {nameClassLabel(value)}</option>)}
        </select>
        <label className="visually-hidden" htmlFor="person-sort">Ordenar</label>
        <select id="person-sort" className="filter-input" value={sort} onChange={(event) => update({ sort: event.target.value })}>
          <option value="name">Ordenar por nombre</option>
          <option value="credits">Ordenar por más créditos</option>
        </select>
      </div>

      {loading && !data ? <CardGridSkeleton count={12} label="Cargando personas…" /> : error ? <ErrorState message={error} onRetry={reload} /> : !data || data.data.length === 0 ? (
        <EmptyState title="No hay personas para mostrar" hint={q || suspect || hasCredits === false ? "Prueba con otro filtro." : undefined} />
      ) : (
        <>
          <div className={`grid-cards${loading ? " is-refreshing" : ""}`}>
            {data.data.map((person) => (
              <EntityCard
                key={person.id}
                to={`/personas/${person.id}`}
                title={person.name}
                subtitle={person.nameClass === "ok"
                  ? person.nationality
                  : `${nameClassLabel(person.nameClass)}: ${person.nameClassReason}`}
                imageUrl={person.pictureUrl}
                placeholder={initialOf(person.name)}
              />
            ))}
          </div>
          <Pagination
            limit={LIMIT} offset={offset} total={data.pagination.total}
            onOffsetChange={(next) => setParams((current) => {
              const merged = new URLSearchParams(current);
              merged.set("offset", String(next));
              return merged;
            })}
          />
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
