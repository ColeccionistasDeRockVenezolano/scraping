import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { searchApi } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { entityHref } from "../lib/routes";
import { searchTypeLabel } from "../lib/labels";
import { LoadingState, ErrorState, EmptyState } from "../components/StateViews";
import type { SearchEntityType } from "../lib/types";

const GROUP_ORDER: SearchEntityType[] = ["artist", "album", "person", "organization", "track"];

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const initialQ = params.get("q") ?? "";
  const [input, setInput] = useState(initialQ);
  const q = params.get("q") ?? "";

  useEffect(() => { setInput(q); }, [q]);

  const { data, loading, error, reload } = useAsync(
    () => (q.trim() ? searchApi.search(q.trim()) : Promise.resolve(null)),
    [q],
  );

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setParams(input.trim() ? { q: input.trim() } : {});
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

      {!q.trim() ? null : loading ? (
        <LoadingState label="Buscando…" />
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
