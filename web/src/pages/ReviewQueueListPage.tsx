import { Link, useSearchParams } from "react-router-dom";
import { reviewApi } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { LoadingState, ErrorState, EmptyState } from "../components/StateViews";
import { Pagination } from "../components/Pagination";
import { reviewKindLabel, reviewStatusLabel } from "../lib/labels";

const STATUSES = ["open", "in_progress", "accepted", "rejected", "resolved"];
const LIMIT = 30;

export function ReviewQueueListPage() {
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "open";
  const offset = Number(params.get("offset") ?? "0") || 0;

  const { data, loading, error, reload } = useAsync(
    () => reviewApi.list({ ...(status ? { status } : {}), limit: LIMIT, offset }),
    [status, offset],
  );

  function setStatus(next: string) {
    const nextParams = new URLSearchParams(params);
    if (next) nextParams.set("status", next); else nextParams.delete("status");
    nextParams.delete("offset");
    setParams(nextParams);
  }

  function setOffset(next: number) {
    const nextParams = new URLSearchParams(params);
    nextParams.set("offset", String(next));
    setParams(nextParams);
  }

  return (
    <>
      <div className="page-header">
        <div>
          <p className="page-kicker">Curaduría</p>
          <h1>Cola de revisión</h1>
          <p className="page-lead">Candidatos, conflictos y coincidencias que el sistema no pudo decidir solo.</p>
        </div>
      </div>

      <div className="list-toolbar">
        <label className="visually-hidden" htmlFor="review-status">Filtrar por estado</label>
        <select id="review-status" className="filter-input" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">Todos los estados</option>
          {STATUSES.map((value) => <option key={value} value={value}>{reviewStatusLabel(value)}</option>)}
        </select>
      </div>

      {loading ? <LoadingState /> : error ? <ErrorState message={error} onRetry={reload} /> : !data || data.data.length === 0 ? (
        <EmptyState title="No hay revisiones para mostrar" hint="La cola está al día." />
      ) : (
        <>
          {data.data.map((item) => (
            <Link to={`/revision/${item.id}`} key={item.id} className="review-row" style={{ display: "flex" }}>
              <div className="review-row__main">
                <div className="review-row__title">{reviewKindLabel(item.kind)}</div>
                <div className="review-row__meta">
                  <span>Prioridad {item.priority}</span>
                  <span>{new Date(item.createdAt).toLocaleDateString("es-VE")}</span>
                  {item.notes ? <span>{item.notes}</span> : null}
                </div>
              </div>
              <span className="badge">{reviewStatusLabel(item.status)}</span>
            </Link>
          ))}
          <Pagination limit={LIMIT} offset={offset} total={data.pagination.total} onOffsetChange={setOffset} />
        </>
      )}
    </>
  );
}
