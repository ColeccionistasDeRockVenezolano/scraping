// CRV · Skeletons de carga: la forma de la página mientras llega el contenido,
// en vez del spinner genérico. Reutilizan la clase global `.skeleton` (shimmer)
// y las medidas reales de los layouts del catálogo (.entity-hero, .grid-cards,
// .card, .section) para que no haya salto al llegar los datos.
import type { CSSProperties } from "react";

/** Bloque base: un rectángulo con el shimmer del sistema. */
export function SkeletonBlock({ width, height = 14, radius, className = "", style }: {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={`skeleton${className ? ` ${className}` : ""}`}
      aria-hidden="true"
      style={{ width, height, ...(radius === undefined ? {} : { borderRadius: radius }), ...style }}
    />
  );
}

/** Cabecera de página (kicker + título + lead). Decorativa: la usan los compuestos. */
export function HeaderSkeleton() {
  return (
    <div className="sk-header" aria-hidden="true">
      <SkeletonBlock width={96} height={11} />
      <SkeletonBlock width={280} height={28} />
      <SkeletonBlock width={220} height={13} />
    </div>
  );
}

/** Filas apiladas (listas, hallazgos, pares pendientes). */
export function RowsSkeleton({ rows = 5, height = 52, label }: { rows?: number; height?: number; label?: string | null }) {
  return (
    <div className="sk-rows" {...(label === undefined || label === null ? { "aria-hidden": true } : { role: "status", "aria-label": label })}>
      {Array.from({ length: rows }, (_, index) => <SkeletonBlock key={index} height={height} />)}
    </div>
  );
}

/** Rejilla de tarjetas del catálogo (como .grid-cards + .entity-card). */
export function CardGridSkeleton({ count = 12, label }: { count?: number; label?: string | null }) {
  return (
    <div className="grid-cards" {...(label === undefined || label === null ? { "aria-hidden": true } : { role: "status", "aria-label": label })}>
      {Array.from({ length: count }, (_, index) => (
        <div className="card sk-card" key={index}>
          <SkeletonBlock width={52} height={52} radius="var(--radius-sm)" />
          <div className="sk-card__body">
            <SkeletonBlock width="78%" />
            <SkeletonBlock width="52%" height={12} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Ficha de entidad: héroe (arte + título + badges) y secciones con filas. */
export function DetailSkeleton({ sections = 3 }: { sections?: number }) {
  return (
    <div role="status" aria-label="Cargando la ficha…">
      <div className="sk-hero" aria-hidden="true">
        <SkeletonBlock className="sk-hero__art" />
        <div className="sk-hero__body">
          <SkeletonBlock className="sk-title" />
          <div className="sk-badges">
            <SkeletonBlock width={108} height={22} radius="999px" />
            <SkeletonBlock width={86} height={22} radius="999px" />
            <SkeletonBlock width={124} height={22} radius="999px" />
          </div>
          <SkeletonBlock width="72%" />
          <SkeletonBlock width="54%" />
        </div>
      </div>
      {Array.from({ length: sections }, (_, index) => (
        <div className="sk-section" key={index} aria-hidden="true">
          <SkeletonBlock width={132} height={12} />
          <RowsSkeleton rows={3} />
        </div>
      ))}
    </div>
  );
}

/** Fallback de ruta diferida (React.lazy) mientras baja el chunk de la página. */
export function RouteFallback() {
  return (
    <div role="status" aria-label="Cargando la página…">
      <HeaderSkeleton />
      <CardGridSkeleton count={9} />
    </div>
  );
}
