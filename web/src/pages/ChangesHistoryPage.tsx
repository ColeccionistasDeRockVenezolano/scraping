// CRV · Historial de cambios del catálogo (migración 0028): cada edición,
// alta, retiro, fusión, división, conversión, corrección de Curaduría o
// proceso de la CLI, del más reciente al más antiguo, con su «Deshacer» o
// «Rehacer». Solo cuentas administradoras.
import { useState } from "react";
import { changesApi } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useOperator } from "../lib/OperatorContext";
import { ChangeList } from "../components/ChangeList";
import { EmptyState, ErrorState, LoadingState } from "../components/StateViews";
import { RowsSkeleton } from "../components/Skeletons";
import { Pagination } from "../components/Pagination";

const LIMIT = 25;

export function ChangesHistoryPage() {
  const { isAdmin, isChecking } = useOperator();
  if (isChecking) return <LoadingState label="Comprobando acceso…" />;
  if (!isAdmin) return <EmptyState title="El historial requiere una cuenta administradora" hint="Inicia sesión con una cuenta administradora para ver y deshacer cambios." />;
  return <ChangesHistoryContent />;
}

function ChangesHistoryContent() {
  const [offset, setOffset] = useState(0);
  const [journaled, setJournaled] = useState(false);
  const { data, loading, error, reload } = useAsync(
    () => changesApi.list({ limit: LIMIT, offset, ...(journaled ? { journaled: true } : {}) }),
    [offset, journaled],
  );

  return (
    <>
      <div className="page-header">
        <div>
          <p className="page-kicker">Catálogo</p>
          <h1>Historial de cambios</h1>
          <p className="hint" style={{ maxWidth: 720 }}>
            Todo cambio es un run: se deshace devolviendo cada fila que tocó a como estaba, y deshacer también es un cambio,
            que se deshace para rehacer. Si algo cambió después, se dice qué cambio hay que deshacer primero.
          </p>
        </div>
      </div>

      <div className="list-toolbar">
        <label className="checkbox-field">
          <input type="checkbox" checked={journaled} onChange={(event) => { setJournaled(event.target.checked); setOffset(0); }} />
          Solo cambios con diario (desde el 22-09-2026)
        </label>
      </div>

      {loading && !data ? <RowsSkeleton rows={8} height={72} label="Cargando historial…" /> : error ? <ErrorState message={error} onRetry={reload} /> : !data || data.data.length === 0 ? (
        <EmptyState title="Sin cambios registrados" />
      ) : (
        <div className={loading ? "is-refreshing" : ""}>
          <ChangeList rows={data.data} />
          {data.pagination.total > LIMIT ? (
            <Pagination limit={LIMIT} offset={offset} total={data.pagination.total} onOffsetChange={setOffset} />
          ) : null}
        </div>
      )}
    </>
  );
}
