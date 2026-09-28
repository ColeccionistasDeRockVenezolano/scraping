// CRV · Historial de cambios de una ficha (GET /audit): quién cambió qué,
// cuándo y con qué motivo. Es la lectura del rastro que deja toda escritura
// (merge_audit vía merge engine u operador); no hay lógica propia aquí.
import { useState } from "react";
import { auditApi, changesApi } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useOperator } from "../lib/OperatorContext";
import { fieldLabel, relativeTime } from "../lib/curation";
import { Pagination } from "./Pagination";
import { ChangeList } from "./ChangeList";
import { AuditUndoDialog } from "./AuditUndoDialog";
import type { ChangeEntityKind } from "../lib/types";

/** Entidades con historial propio en la API (ver AUDIT_COLUMN en el backend). */
export type HistoryEntity =
  | "artist" | "person" | "organization" | "album" | "track"
  | "artist_membership" | "person_organization" | "album_credit" | "track_credit" | "album_format";

const LIMIT = 15;
const CHANGE_LIMIT = 10;
const CHANGE_KINDS = new Set<HistoryEntity>(["artist", "person", "organization", "album", "track"]);
/**
 * Decisiones que se deshacen por separado, aunque su proceso sea de antes del
 * diario: una fusión y una conversión de persona a artista u organización.
 */
const UNDOABLE_FIELDS = new Set(["merged_duplicate", "absorbed_person"]);

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Sí" : "No";
  if (typeof value === "object") {
    const json = JSON.stringify(value);
    return json.length > 140 ? `${json.slice(0, 140)}…` : json;
  }
  return String(value);
}

/**
 * Solo administradores: el historial queda oculto para cuentas de solo lectura
 * y para visitantes (la API también rechaza /audit sin cuenta admin). Se
 * separa en dos componentes para no alterar el orden de los hooks cuando
 * alguien inicia o cierra sesión con la ficha abierta.
 */
export function EntityHistory({ entity, id }: { entity: HistoryEntity; id: number }) {
  const { isAdmin } = useOperator();
  if (!isAdmin) return null;
  return (
    <>
      {CHANGE_KINDS.has(entity) ? <EntityChanges entity={entity as ChangeEntityKind} id={id} /> : null}
      <EntityHistoryContent entity={entity} id={id} />
    </>
  );
}

/** Los cambios (runs) que tocaron la ficha, cada uno con su «Deshacer» o «Rehacer». */
function EntityChanges({ entity, id }: { entity: ChangeEntityKind; id: number }) {
  const [offset, setOffset] = useState(0);
  const { data, loading, error } = useAsync(
    () => changesApi.list({ entity, id, limit: CHANGE_LIMIT, offset }),
    [entity, id, offset],
  );
  return (
    <div className="section">
      <h2>Cambios de esta ficha</h2>
      {loading && !data ? (
        <p style={{ color: "var(--text-faint)", fontSize: 13.5 }}>Cargando cambios…</p>
      ) : error ? (
        <p className="form-error-banner" role="alert">{error}</p>
      ) : !data || data.data.length === 0 ? (
        <p style={{ color: "var(--text-faint)", fontSize: 13.5 }}>Sin cambios registrados todavía.</p>
      ) : (
        <>
          <ChangeList rows={data.data} />
          {data.pagination.total > CHANGE_LIMIT ? (
            <Pagination limit={CHANGE_LIMIT} offset={offset} total={data.pagination.total} onOffsetChange={setOffset} />
          ) : null}
        </>
      )}
    </div>
  );
}

function EntityHistoryContent({ entity, id }: { entity: HistoryEntity; id: number }) {
  const [offset, setOffset] = useState(0);
  const [undoing, setUndoing] = useState<number>();
  const { data, loading, error } = useAsync(
    () => auditApi.forEntity(entity, id, { limit: LIMIT, offset }),
    [entity, id, offset],
  );

  return (
    <div className="section">
      <h2>Historial de campos</h2>
      {loading && !data ? (
        <p style={{ color: "var(--text-faint)", fontSize: 13.5 }}>Cargando historial…</p>
      ) : error ? (
        <p className="form-error-banner" role="alert">{error}</p>
      ) : !data || data.data.length === 0 ? (
        <p style={{ color: "var(--text-faint)", fontSize: 13.5 }}>Sin cambios registrados todavía.</p>
      ) : (
        <>
          <div className="table-wrap table-wrap--scroll">
            <table>
              <caption className="visually-hidden">Cambios registrados de esta ficha, del más reciente al más antiguo</caption>
              <thead>
                <tr><th scope="col">Cuándo</th><th scope="col">Quién</th><th scope="col">Campo</th><th scope="col">Antes</th><th scope="col">Después</th><th scope="col">Motivo</th><th scope="col">Deshacer</th></tr>
              </thead>
              <tbody>
                {data.data.map((row) => (
                  <tr key={row.id}>
                    <td className="mono" title={new Date(row.at).toLocaleString("es-VE")}>{relativeTime(row.at)}</td>
                    <td>{row.performedBy === "human" ? "Persona" : row.performedBy === "ai" ? "IA" : "Sistema"}</td>
                    <td>{fieldLabel(row.field)}</td>
                    <td style={{ maxWidth: 220, wordBreak: "break-word" }}>{formatValue(row.oldValue)}</td>
                    <td style={{ maxWidth: 220, wordBreak: "break-word" }}>{formatValue(row.newValue)}</td>
                    <td style={{ maxWidth: 320, wordBreak: "break-word" }}>{row.reason}</td>
                    <td>
                      {UNDOABLE_FIELDS.has(row.field) ? (
                        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setUndoing(row.id)}>
                          Deshacer
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.pagination.total > LIMIT ? (
            <Pagination limit={LIMIT} offset={offset} total={data.pagination.total} onOffsetChange={setOffset} />
          ) : null}
          {undoing !== undefined ? <AuditUndoDialog auditId={undoing} onClose={() => setUndoing(undefined)} /> : null}
        </>
      )}
    </div>
  );
}
