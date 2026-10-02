import type { ReactNode } from "react";

export interface InfoItem {
  label: string;
  /** null/undefined/"" = sin dato: la fila se omite salvo que traiga `fallback`. */
  value: ReactNode;
  /** Texto atenuado cuando no hay dato; sirve para campos que siempre deben verse (p. ej. «Estado»). */
  fallback?: string;
}

export interface InfoGroup {
  title: string;
  items: readonly InfoItem[];
}

/**
 * Datos de la ficha en dos columnas etiqueta/valor (al estilo de las fichas de
 * Metal Archives). Las filas se reparten en dos columnas llenando la izquierda
 * primero; en pantallas estrechas pasan a una sola. `wide` añade una fila de
 * ancho completo debajo (los alias, con su editor).
 */
export function EntityInfo({ items, groups, wide }: { items: readonly InfoItem[]; groups?: readonly InfoGroup[]; wide?: { label: string; content: ReactNode } }) {
  const visible = (items: readonly InfoItem[]) => items
    .map((item) => ({ ...item, empty: item.value === null || item.value === undefined || item.value === "" || item.value === false }))
    .filter((item) => !item.empty || item.fallback);
  const rows = visible(items);
  const visibleGroups = groups?.map((group) => ({ ...group, rows: visible(group.items) })).filter((group) => group.rows.length > 0);
  if (rows.length === 0 && !visibleGroups?.length && !wide) return null;
  const half = Math.ceil(rows.length / 2);
  const columns = visibleGroups ?? [rows.slice(0, half), rows.slice(half)]
    .filter((column) => column.length > 0)
    .map((column) => ({ title: null, rows: column }));
  return (
    <div className={`entity-info${visibleGroups ? " entity-info--grouped" : ""}`}>
      {columns.map((column, index) => (
        <div className="entity-info__group" key={column.title ?? index}>
          {column.title ? <h2 className="entity-info__heading">{column.title}</h2> : null}
          <dl className="entity-info__col">
          {column.rows.map((item) => (
            <div className="entity-info__row" key={item.label}>
              <dt>{item.label}</dt>
              <dd className={item.empty ? "is-empty" : undefined}>{item.empty ? item.fallback : item.value}</dd>
            </div>
          ))}
          </dl>
        </div>
      ))}
      {wide ? (
        <div className="entity-info__wide">
          <span className="entity-info__wide-label">{wide.label}</span>
          <div>{wide.content}</div>
        </div>
      ) : null}
    </div>
  );
}
