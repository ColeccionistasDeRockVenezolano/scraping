import type { ReactNode } from "react";

export interface InfoItem {
  label: string;
  /** null/undefined/"" = sin dato: la fila se omite salvo que traiga `fallback`. */
  value: ReactNode;
  /** Texto atenuado cuando no hay dato; sirve para campos que siempre deben verse (p. ej. «Estado»). */
  fallback?: string;
}

/**
 * Datos de la ficha en dos columnas etiqueta/valor (al estilo de las fichas de
 * Metal Archives). Las filas se reparten en dos columnas llenando la izquierda
 * primero; en pantallas estrechas pasan a una sola. `wide` añade una fila de
 * ancho completo debajo (los alias, con su editor).
 */
export function EntityInfo({ items, wide }: { items: readonly InfoItem[]; wide?: { label: string; content: ReactNode } }) {
  const rows = items
    .map((item) => ({ ...item, empty: item.value === null || item.value === undefined || item.value === "" || item.value === false }))
    .filter((item) => !item.empty || item.fallback);
  if (rows.length === 0 && !wide) return null;
  const half = Math.ceil(rows.length / 2);
  const columns = [rows.slice(0, half), rows.slice(half)].filter((column) => column.length > 0);
  return (
    <div className="entity-info">
      {columns.map((column, index) => (
        <dl className="entity-info__col" key={index}>
          {column.map((item) => (
            <div className="entity-info__row" key={item.label}>
              <dt>{item.label}</dt>
              <dd className={item.empty ? "is-empty" : undefined}>{item.empty ? item.fallback : item.value}</dd>
            </div>
          ))}
        </dl>
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
