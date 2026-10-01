import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";

export interface TabSpec {
  key: string;
  label: string;
  /** Cantidad que se muestra junto al nombre; 0 se ve atenuado, undefined no muestra nada. */
  count?: number | undefined;
  content: ReactNode;
}

/**
 * Pestañas de una ficha. La pestaña activa vive en `?tab=` (se puede compartir
 * el enlace y el botón «atrás» no pierde el sitio) y solo se monta el panel
 * activo. Teclado: flechas, Inicio y Fin, según el patrón ARIA de tabs.
 */
export function EntityTabs({ tabs, defaultKey }: { tabs: readonly TabSpec[]; defaultKey?: string }) {
  const [params, setParams] = useSearchParams();
  const baseId = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const requested = params.get("tab");
  const active = tabs.find((tab) => tab.key === requested)
    ?? tabs.find((tab) => tab.key === defaultKey)
    ?? tabs[0];
  if (!active) return null;

  function select(key: string) {
    const next = new URLSearchParams(params);
    if (key === (defaultKey ?? tabs[0]?.key)) next.delete("tab"); else next.set("tab", key);
    setParams(next, { replace: true });
  }

  function onKeyDown(event: KeyboardEvent, index: number) {
    const last = tabs.length - 1;
    const target = event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last : null;
    if (target === null) return;
    event.preventDefault();
    const tab = tabs[target];
    if (!tab) return;
    select(tab.key);
    refs.current[target]?.focus();
  }

  return (
    <div className="etabs">
      <div className="etabs__list" role="tablist">
        {tabs.map((tab, index) => {
          const selected = tab.key === active.key;
          return (
            <button
              key={tab.key}
              ref={(node) => { refs.current[index] = node; }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${tab.key}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${tab.key}`}
              tabIndex={selected ? 0 : -1}
              className={`etabs__tab${selected ? " is-active" : ""}`}
              onClick={() => select(tab.key)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              {tab.label}
              {tab.count !== undefined ? <span className={`etabs__count${tab.count === 0 ? " is-zero" : ""}`}>{tab.count}</span> : null}
            </button>
          );
        })}
      </div>
      <div className="etabs__panel" role="tabpanel" id={`${baseId}-panel-${active.key}`} aria-labelledby={`${baseId}-tab-${active.key}`}>
        {active.content}
      </div>
    </div>
  );
}

/** Texto de «vacío» común a todos los paneles. */
export function TabEmpty({ children }: { children: ReactNode }) {
  return <p className="etabs__empty">{children}</p>;
}
