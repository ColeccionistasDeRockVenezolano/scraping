// CRV · Curaduría › historial de correcciones (PLAN_CURADURIA E8.5, A8).
//
// Cada corrección hecha desde Curaduría —de una ficha, de una selección o de
// un grupo filtrado— es un lote con su vista previa, su nota y sus runs. Antes
// no había dónde verlos: un `fix-group` dejaba hasta 500 runs sueltos sin nada
// que los agrupara y nada se podía deshacer (A8). Aquí está quién lo pidió,
// cuándo, con qué filtro, cómo acabó y el botón de deshacer mientras siga
// siendo reversible.
//
// Las vistas previas que nadie aplicó no salen: no escribieron nada y cada
// diálogo abierto y cerrado deja una (la API las omite salvo que se pidan).
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowCounterClockwise, ClockCounterClockwise } from "@phosphor-icons/react";
import { ApiError, curationApi } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useToast } from "../lib/ToastContext";
import {
  ENTITY_KIND_LABEL, FIX_STATUS_BADGE, fieldLabel, fixModeLabel, fixStatusLabel, formatCount, plural, relativeTime,
} from "../lib/curation";
import { ErrorState, EmptyState } from "../components/StateViews";
import { RowsSkeleton } from "../components/Skeletons";
import { Pagination } from "../components/Pagination";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { BatchProgress } from "../components/FixBatchDialog";
import type { FixBatch, FixBatchSummary, FixItemStatus } from "../lib/types";

const LIMIT = 20;
const ITEM_LIMIT = 50;

const ITEM_STATUS_LABEL: Readonly<Record<FixItemStatus, string>> = {
  pending: "Pendiente", blocked: "Bloqueado", excluded: "Excluido", applied: "Aplicado",
  skipped_stale: "Obsoleto (la ficha cambió)", failed: "Falló", undone: "Deshecho", not_undoable: "No reversible",
};

/** Nombres de los filtros de grupo tal como se ven en la pantalla de hallazgos. */
const FILTER_LABEL: Readonly<Record<string, string>> = {
  category: "Categoría", detector: "Detector", signature: "Subgrupo", severity: "Gravedad",
  entityKind: "Tipo de ficha", q: "Texto", scanId: "Análisis", chained: "Surgidos tras corregir",
  findingIds: "Hallazgos elegidos", undoOfBatchId: "Deshace el lote",
};

function filterText(filter: Record<string, unknown>): string {
  const parts = Object.entries(filter)
    .filter(([, value]) => value !== null && value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0))
    .map(([key, value]) => {
      const label = FILTER_LABEL[key] ?? key;
      if (Array.isArray(value)) return `${label}: ${formatCount(value.length)}`;
      if (typeof value === "boolean") return value ? label : "";
      return `${label}: ${String(value)}`;
    })
    .filter(Boolean);
  return parts.length ? parts.join(" · ") : "Sin filtro";
}

/** Un lote es reversible mientras haya algo aplicado y nadie lo haya deshecho ya. */
function isUndoable(batch: { status: string; counts: Record<string, unknown>; undoneByBatchId: number | null; mode: string }): boolean {
  const applied = typeof batch.counts["applied"] === "number" ? batch.counts["applied"] : 0;
  return batch.mode !== "undo" && batch.undoneByBatchId === null && applied > 0 && batch.status !== "undone";
}

export function CurationFixesPage() {
  const { batchId } = useParams();
  return batchId ? <FixBatchDetail batchId={Number(batchId)} /> : <FixBatchList />;
}

function FixBatchList() {
  const [params, setParams] = useSearchParams();
  const offset = Number(params.get("offset") ?? "0") || 0;
  const mode = params.get("mode") ?? "";
  const { data, loading, error, reload } = useAsync(
    () => curationApi.fixes({ limit: LIMIT, offset, ...(mode ? { mode } : {}) }),
    [offset, mode],
  );

  function update(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params);
    for (const [name, value] of Object.entries(changes)) {
      if (value) next.set(name, value); else next.delete(name);
    }
    if (!("offset" in changes)) next.delete("offset");
    setParams(next);
  }

  return (
    <>
      <div className="cfind-head">
        <h2><ClockCounterClockwise size={20} weight="bold" aria-hidden="true" /> Correcciones</h2>
        <p className="curation-lead">
          Todo lo que Curaduría ha escrito en el catálogo, por lotes: quién lo pidió, con qué filtro, cómo acabó y su deshacer.
          Las vistas previas que nadie aplicó no aparecen porque no cambiaron nada.
        </p>
      </div>

      <div className="list-toolbar">
        <div className="cfind-selects">
          <label className="visually-hidden" htmlFor="cfix-mode">Tipo de lote</label>
          <select id="cfix-mode" className="filter-input" value={mode} onChange={(event) => update({ mode: event.target.value || null })}>
            <option value="">Todos los lotes</option>
            {["individual", "selected", "group", "auto", "undo"].map((value) => (
              <option key={value} value={value}>{fixModeLabel(value)}</option>
            ))}
          </select>
        </div>
      </div>

      {loading && !data ? <RowsSkeleton rows={6} height={54} label="Cargando el historial…" />
        : error ? <ErrorState message={error} onRetry={reload} />
          : !data || data.data.length === 0 ? (
            <EmptyState title="Todavía no hay correcciones" hint="Cuando apliques una corrección desde Curaduría, su lote aparecerá aquí con su deshacer." />
          ) : (
            <>
              <ul className="cfix-list">
                {data.data.map((batch) => <li key={batch.id}><FixBatchRow batch={batch} /></li>)}
              </ul>
              <Pagination limit={LIMIT} offset={offset} total={data.pagination.total} onOffsetChange={(next) => update({ offset: String(next) })} />
            </>
          )}
    </>
  );
}

function FixBatchRow({ batch }: { batch: FixBatchSummary }) {
  const applied = typeof batch.counts["applied"] === "number" ? batch.counts["applied"] : 0;
  return (
    <article className="cfix">
      <div className="cfix__head">
        <span className={FIX_STATUS_BADGE[batch.status] ?? "badge"}>{fixStatusLabel(batch.status)}</span>
        <span className="badge badge--outline">{fixModeLabel(batch.mode)}</span>
        <Link className="text-link" to={`/curaduria/correcciones/${batch.id}`}>Lote #{batch.id}</Link>
        <span className="cfix__when">{relativeTime(batch.createdAt)}</span>
      </div>
      <p className="cfix__filter">{filterText(batch.filter)}</p>
      {batch.note ? <p className="cfind__note">«{batch.note}»</p> : null}
      <p className="cfind__note">
        {batch.appliedBy ?? batch.requestedBy} · {formatCount(applied)} de {formatCount(batch.itemCount)} aplicados
        {batch.undoneByBatchId !== null ? ` · deshecho por el lote #${batch.undoneByBatchId}` : ""}
        {batch.undoOfBatchId !== null ? ` · deshace el lote #${batch.undoOfBatchId}` : ""}
      </p>
    </article>
  );
}

function FixBatchDetail({ batchId }: { batchId: number }) {
  const { notify } = useToast();
  const [params, setParams] = useSearchParams();
  const offset = Number(params.get("offset") ?? "0") || 0;
  const [undoing, setUndoing] = useState(false);
  const { data, loading, error, reload } = useAsync(() => curationApi.fix(batchId, { limit: ITEM_LIMIT, offset }), [batchId, offset]);

  if (loading && !data) return <RowsSkeleton rows={6} height={54} label="Cargando el lote…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return <EmptyState title="Ese lote no existe" hint="Vuelve al historial de correcciones." />;

  return (
    <>
      <div className="cfind-head">
        <Link to="/curaduria/correcciones" className="back-link">← Correcciones</Link>
        <h2>Lote #{data.id}</h2>
        <p className="curation-lead">
          {fixModeLabel(data.mode)} · lo pidió {data.requestedBy}
          {data.appliedBy && data.appliedBy !== data.requestedBy ? `, lo aplicó ${data.appliedBy}` : ""} {relativeTime(data.createdAt)}.
          {data.undoOfBatchId !== null ? <> Deshace el <Link className="text-link" to={`/curaduria/correcciones/${data.undoOfBatchId}`}>lote #{data.undoOfBatchId}</Link>.</> : null}
          {data.undoneByBatchId !== null ? <> Deshecho por el <Link className="text-link" to={`/curaduria/correcciones/${data.undoneByBatchId}`}>lote #{data.undoneByBatchId}</Link>.</> : null}
        </p>
      </div>

      <div className="cfix__meta">
        <span className={FIX_STATUS_BADGE[data.status] ?? "badge"}>{fixStatusLabel(data.status)}</span>
        <span className="cfix__filter">{filterText(data.filter)}</span>
      </div>
      {data.note ? <p className="cfind__note">Motivo: «{data.note}»</p> : null}

      <BatchProgress batch={data} />
      <VerificationNote batch={data} />

      <div className="table-wrap">
        <table>
          <caption className="visually-hidden">Ítems del lote #{data.id}</caption>
          <thead>
            <tr>
              <th scope="col">Hallazgo</th>
              <th scope="col">Acción</th>
              <th scope="col">Antes → después</th>
              <th scope="col">Estado</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((item) => (
              <tr key={item.id}>
                <td className="cdiff__finding">
                  {item.finding?.title ?? `Hallazgo #${item.findingId ?? "—"}`}
                  {item.finding?.entity ? (
                    <div className="hint">{ENTITY_KIND_LABEL[item.finding.entity.kind] ?? item.finding.entity.kind} · {item.finding.entity.label}</div>
                  ) : null}
                </td>
                <td>{item.actionLabel ?? item.actionKey ?? "—"}{item.level !== null ? <span className="hint"> · nivel {item.level}</span> : null}</td>
                <td className="mono">{changeText(item.before, item.after)}</td>
                <td>
                  <span className="badge">{ITEM_STATUS_LABEL[item.status]}</span>
                  {item.error ? <div className="hint">{item.error}</div> : null}
                  {item.runId !== null ? <div className="hint">run #{item.runId}</div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination limit={ITEM_LIMIT} offset={offset} total={data.pagination.total} onOffsetChange={(next) => {
        const query = new URLSearchParams(params);
        query.set("offset", String(next));
        setParams(query);
      }} />

      {isUndoable(data) ? (
        <div className="form-actions">
          <button type="button" className="btn btn--danger" onClick={() => setUndoing(true)}>
            <ArrowCounterClockwise size={14} weight="bold" aria-hidden="true" /> Deshacer este lote
          </button>
        </div>
      ) : null}

      {undoing ? (
        <ConfirmDialog
          title="¿Deshacer este lote?"
          description="Se revierte en orden inverso lo que el lote aplicó, con un run por corrección. Solo se restaura lo que sigue como lo dejó la corrección: si algo cambió después, ese ítem queda «no reversible» y el resto se deshace igual."
          confirmLabel="Deshacer el lote"
          danger
          onConfirm={async (note) => {
            try {
              const result = await curationApi.fixUndo(data.id, note);
              const undone = typeof result.counts["undone"] === "number" ? result.counts["undone"] : 0;
              notify("success", `${formatCount(undone)} correcciones deshechas.`);
              setUndoing(false);
              reload();
            } catch (err) {
              notify("error", err instanceof ApiError ? err.message : "No se pudo deshacer el lote.");
              throw err;
            }
          }}
          onClose={() => setUndoing(false)}
        />
      ) : null}
    </>
  );
}

const VERIFICATION_STATUS: Readonly<Record<string, string>> = {
  running: "en curso", done: "hecha", skipped: "no llegó a correr (otro análisis la adelantó)", failed: "falló",
};

/**
 * Lo que el análisis dirigido a las fichas del lote encontró después (E4.6):
 * qué se resolvió, qué apareció y qué se desencadenó. Sin esto, «aplicado» no
 * dice si la corrección dejó el dato a medias.
 */
function VerificationNote({ batch }: { batch: FixBatch }) {
  const verification = batch.verification;
  if (!verification) return null;
  const count = (key: string) => (typeof verification[key] === "number" ? verification[key] as number : 0);
  const status = typeof verification["status"] === "string" ? verification["status"] : "";
  return (
    <p className="cfind__note">
      Verificación {VERIFICATION_STATUS[status] ?? status}: {plural(count("resolvedCount"), "hallazgo resuelto", "hallazgos resueltos")}
      {count("fixedByCuration") ? ` (${formatCount(count("fixedByCuration"))} por esta corrección)` : ""}
      {" · "}{plural(count("appearedCount"), "aparecido", "aparecidos")}
      {count("triggeredCount") ? ` · ${plural(count("triggeredCount"), "surgido tras corregir", "surgidos tras corregir")}` : ""}
    </p>
  );
}

function changeText(before: Record<string, unknown> | null, after: Record<string, unknown> | null): string {
  if (!after) return "—";
  const parts = Object.entries(after)
    .filter(([key, value]) => JSON.stringify(before?.[key]) !== JSON.stringify(value))
    .map(([key, value]) => `${fieldLabel(key)}: ${format(before?.[key])} → ${format(value)}`);
  return parts.length ? parts.join("; ") : "—";
}

function format(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
