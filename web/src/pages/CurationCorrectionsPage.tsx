// CRV · E8: historial de correcciones de Curaduría.
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ArrowCounterClockwise } from "@phosphor-icons/react";
import { ApiError, curationApi } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useToast } from "../lib/ToastContext";
import { ErrorState, EmptyState } from "../components/StateViews";
import { Pagination } from "../components/Pagination";
import { Modal } from "../components/Modal";
import type { FixBatchStatus, FixBatchSummary } from "../lib/types";

const LIMIT = 25;

function when(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("es-VE");
}

function count(batch: Pick<FixBatchSummary, "counts">, key: string): number {
  const value = batch.counts[key];
  return typeof value === "number" ? value : 0;
}

export function CurationCorrectionsPage() {
  const [params, setParams] = useSearchParams();
  const requestedBatch = Number(params.get("batch") ?? "") || null;
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState<FixBatchStatus | "">("");
  const [detailId, setDetailId] = useState<number | null>(requestedBatch);

  function closeDetail() {
    setDetailId(null);
    if (params.has("batch")) {
      const next = new URLSearchParams(params);
      next.delete("batch");
      setParams(next, { replace: true });
    }
  }
  const { data, loading, error, reload } = useAsync(
    () => curationApi.fixBatches({ limit: LIMIT, offset, ...(status ? { status } : {}) }),
    [offset, status],
  );

  return (
    <>
      <div className="cfind-head">
        <h2>Correcciones</h2>
        <p className="curation-lead">
          Historial de vistas previas, lotes aplicados y deshechos. Cada fila conserva quién, cuándo, filtro, resultado y verificación.
        </p>
      </div>

      <div className="list-toolbar">
        <label>
          <span className="visually-hidden">Estado del lote</span>
          <select className="filter-input" value={status} onChange={(event) => {
            setStatus(event.target.value as FixBatchStatus | "");
            setOffset(0);
          }}>
            <option value="">Todos los estados</option>
            <option value="previewed">Previsualizado</option>
            <option value="running">En curso</option>
            <option value="done">Aplicado</option>
            <option value="partial">Parcial</option>
            <option value="failed">Fallido</option>
            <option value="undone">Deshecho</option>
          </select>
        </label>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : !data && loading ? (
        <p role="status">Cargando lotes…</p>
      ) : !data || data.data.length === 0 ? (
        <EmptyState title="No hay lotes con este filtro" hint="Las correcciones previsualizadas y aplicadas aparecerán aquí." />
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Lote</th><th>Modo</th><th>Estado</th><th>Quién</th><th>Fecha</th><th>Resultado</th><th /></tr></thead>
              <tbody>
                {data.data.map((batch) => (
                  <tr key={batch.id}>
                    <td>
                      <span className="mono">#{batch.id}</span>
                      {batch.undoOfBatchId ? <span className="hint"> · deshace #{batch.undoOfBatchId}</span> : null}
                    </td>
                    <td>{batch.mode}</td>
                    <td><span className="badge badge--outline">{batch.status}</span></td>
                    <td>{batch.appliedBy ?? batch.requestedBy}</td>
                    <td>{when(batch.finishedAt ?? batch.createdAt)}</td>
                    <td>
                      {count(batch, "applied")} aplicados · {count(batch, "skippedStale")} obsoletos · {count(batch, "failed")} fallidos
                    </td>
                    <td><button type="button" className="btn btn--sm btn--outline" onClick={() => setDetailId(batch.id)}>Ver lote</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination limit={LIMIT} offset={offset} total={data.pagination.total} onOffsetChange={setOffset} />
        </>
      )}

      {detailId !== null ? (
        <CorrectionDetail batchId={detailId} onChanged={reload} onClose={closeDetail} />
      ) : null}
    </>
  );
}

function CorrectionDetail({ batchId, onChanged, onClose }: {
  batchId: number;
  onChanged: () => void;
  onClose: () => void;
}) {
  const { notify } = useToast();
  const [note, setNote] = useState("");
  const [undoing, setUndoing] = useState(false);
  const { data: batch, loading, error, reload } = useAsync(
    () => curationApi.fixBatch(batchId, { limit: 200 }),
    [batchId],
  );

  async function undo() {
    if (!batch || !note.trim()) return;
    setUndoing(true);
    try {
      const reversed = await curationApi.fixUndo(batch.id, note.trim());
      notify("success", `Lote #${batch.id} deshecho por el lote #${reversed.id}.`);
      reload();
      onChanged();
    } catch (err) {
      notify("error", err instanceof ApiError ? err.message : "No se pudo deshacer el lote.");
    } finally {
      setUndoing(false);
    }
  }

  return (
    <Modal title={`Lote #${batchId}`} onClose={onClose} wide>
      {loading && !batch ? (
        <p role="status">Cargando…</p>
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : batch ? (
        <>
          <div className="correction-summary">
            <span className="badge badge--outline">{batch.mode}</span>
            <span className="badge badge--outline">{batch.status}</span>
            <span>Solicitado por {batch.requestedBy}</span>
            <span>Aplicado por {batch.appliedBy ?? "—"}</span>
            <span>{when(batch.finishedAt ?? batch.createdAt)}</span>
          </div>
          {batch.note ? <p><strong>Motivo:</strong> {batch.note}</p> : null}
          <details>
            <summary>Filtro del lote</summary>
            <pre className="evidence-block">{JSON.stringify(batch.filter, null, 2)}</pre>
          </details>
          {batch.verification ? (
            <details open>
              <summary>Verificación posterior</summary>
              <pre className="evidence-block">{JSON.stringify(batch.verification, null, 2)}</pre>
            </details>
          ) : null}
          <div className="table-wrap">
            <table>
              <thead><tr><th>#</th><th>Hallazgo</th><th>Acción</th><th>Antes → después</th><th>Estado</th><th>Run</th></tr></thead>
              <tbody>
                {batch.items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.position + 1}</td>
                    <td>{item.finding?.title ?? `Hallazgo #${item.findingId ?? "—"}`}</td>
                    <td>{item.actionLabel ?? item.actionKey ?? "—"}</td>
                    <td className="mono">{item.before || item.after ? `${JSON.stringify(item.before)} → ${JSON.stringify(item.after)}` : "—"}</td>
                    <td>{item.status}{item.error ? <div className="hint">{item.error}</div> : null}</td>
                    <td>{item.runId ? <span className="mono">#{item.runId}</span> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {batch.status === "done" || batch.status === "partial" ? (
            <div className="field">
              <label htmlFor="history-undo-note">Motivo para deshacer</label>
              <textarea id="history-undo-note" rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
              <button type="button" className="btn btn--danger" onClick={() => void undo()} disabled={undoing || !note.trim()}>
                <ArrowCounterClockwise size={15} weight="bold" aria-hidden="true" /> {undoing ? "Deshaciendo…" : "Deshacer lote"}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </Modal>
  );
}
