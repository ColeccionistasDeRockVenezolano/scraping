import { useCallback } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { searchApi } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useDebouncedQuery } from "../lib/useDebouncedQuery";
import { entityHref } from "../lib/routes";
import { searchTypeLabel } from "../lib/labels";
import { ErrorState, EmptyState } from "../components/StateViews";
import { RowsSkeleton } from "../components/Skeletons";
import type { SearchEntityType } from "../lib/types";

const GROUP_ORDER: SearchEntityType[] = ["artist", "album", "person", "organization", "track"];
const MIN_QUERY_LENGTH = 3;

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const urlQuery = params.get("q") ?? "";
  const applyQuery = useCallback((next: string) => {
    const query = next.trim();
    setParams(query.length >= MIN_QUERY_LENGTH ? { q: query } : {}, { replace: true });
  }, [setParams]);
  const [input, setInput] = useDebouncedQuery(urlQuery, applyQuery);
  const q = urlQuery.trim();
  const inputQuery = input.trim();
  const hasMinimumQuery = q.length >= MIN_QUERY_LENGTH;
  const needsMoreCharacters = inputQuery.length > 0 && inputQuery.length < MIN_QUERY_LENGTH;
  const isSearchPending = inputQuery.length >= MIN_QUERY_LENGTH && inputQuery !== q;

  const { data, loading, error, reload } = useAsync(
    (signal) => (hasMinimumQuery ? searchApi.search(q, undefined, 20, signal) : Promise.resolve(null)),
    [q, hasMinimumQuery],
  );

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    applyQuery(input);
  }

  const hasAnyResult = data ? GROUP_ORDER.some((type) => data[type].length > 0) : false;

  return (
    <div className="search-shell">
      <h1>Coleccionistas De Rock Venezolano</h1>
      <p>Busca una banda, un disco, una persona o una organización del catálogo.</p>
      <form className="search-input-wrap" onSubmit={handleSubmit}>
        <label className="visually-hidden" htmlFor="catalog-search">Buscar en el catálogo</label>
        <input
          id="catalog-search"
          className="search-input"
          type="search"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Caramelos De Cianuro, Las Paticas De La Abuela, Asier Cazalis…"
          autoFocus
        />
      </form>

      {needsMoreCharacters ? (
        <p className="search-status" role="status">Escribe al menos {MIN_QUERY_LENGTH} caracteres para buscar.</p>
      ) : !inputQuery ? null : isSearchPending || !hasMinimumQuery || loading ? (
        <RowsSkeleton rows={6} label="Buscando…" />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : !hasAnyResult ? (
        <EmptyState title={`Sin resultados para «${q}»`} hint="Prueba con otro nombre o revisa la ortografía." />
      ) : (
        <div className="search-groups">
          {GROUP_ORDER.filter((type) => (data?.[type].length ?? 0) > 0).map((type) => (
            <div className="search-group" key={type}>
              <h2>{searchTypeLabel(type)} <span className="mono" style={{ color: "var(--text-faint)", fontWeight: 400 }}>({data![type].length})</span></h2>
              {data![type].map((hit) => (
                <Link key={`${hit.type}-${hit.id}`} className="search-hit" to={entityHref(hit.type, hit.id, hit.albumId ?? undefined)}>
                  <span className="label">{hit.label}</span>
                  {hit.context ? <span className="context">{hit.context}</span> : null}
                </Link>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
