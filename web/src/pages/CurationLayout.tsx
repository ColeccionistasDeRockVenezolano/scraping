// CRV · Curaduría: el detector de conflictos y los posibles duplicados bajo un
// solo segmento del menú.
//
// El menú lateral sale del catálogo, no de una lista fija: la API devuelve las
// categorías con sus conteos (src/curation/taxonomy.ts) y cada una es una
// entrada. «Otros» siempre existe: ahí cae lo que ningún detector específico
// explica. El resumen se refresca solo, así una corrección hecha en otra
// pestaña del navegador aparece verificada sin recargar.
//
// Solo para cuentas admin. La API ya rechaza estas lecturas sin rol admin
// (src/api/auth.ts, ADMIN_READS); aquí se explica por qué en vez de mostrar
// «No se pudo cargar».
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useOutletContext } from "react-router-dom";
import { CaretDown, Copy, LockSimple, Pulse, SignIn, type Icon } from "@phosphor-icons/react";
import { useOperator } from "../lib/OperatorContext";
import { ApiError, curationApi } from "../lib/api";
import { categoryIcon, formatCount } from "../lib/curation";
import { LoadingState } from "../components/StateViews";
import { RowsSkeleton } from "../components/Skeletons";
import { OperatorDialog } from "../components/OperatorSettings";
import type { CurationSummary } from "../lib/types";

/** Cada cuánto se refresca el resumen; más a menudo mientras un análisis corre. */
const REFRESH_MS = 20_000;
const REFRESH_RUNNING_MS = 3_000;

export interface CurationOutletContext {
  summary: CurationSummary | undefined;
  summaryError: string | undefined;
  refreshSummary: () => Promise<void>;
}

export function useCurationSummary(): CurationOutletContext {
  return useOutletContext<CurationOutletContext>();
}

function useSummary(enabled: boolean): CurationOutletContext {
  const [summary, setSummary] = useState<CurationSummary>();
  const [summaryError, setSummaryError] = useState<string>();
  const generation = useRef(0);

  const refreshSummary = useCallback(async () => {
    const current = ++generation.current;
    try {
      const next = await curationApi.summary();
      if (current !== generation.current) return;
      setSummary(next);
      setSummaryError(undefined);
    } catch (error) {
      if (current !== generation.current) return;
      setSummaryError(error instanceof ApiError ? error.message : "No se pudo cargar el detector de conflictos.");
    }
  }, []);

  const running = summary?.running ?? false;
  useEffect(() => {
    if (!enabled) return undefined;
    void refreshSummary();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshSummary();
    }, running ? REFRESH_RUNNING_MS : REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [enabled, running, refreshSummary]);

  return { summary, summaryError, refreshSummary };
}

export function CurationLayout() {
  const { user, isAdmin, isChecking } = useOperator();
  const [signingIn, setSigningIn] = useState(false);
  const context = useSummary(isAdmin);
  const { summary } = context;

  return (
    <>
      <div className="page-header">
        <div>
          <p className="page-kicker">Solo administradores</p>
          <h1>Curaduría</h1>
        </div>
      </div>

      {isChecking ? <LoadingState label="Comprobando acceso…" /> : !isAdmin ? (
        <div className="state-block access-block">
          <LockSimple className="icon" aria-hidden="true" weight="bold" />
          <h3>{user ? "Tu cuenta es de solo lectura" : "Esta sección requiere una cuenta administradora"}</h3>
          <p>
            {user
              ? `Has iniciado sesión como ${user.name}. El detector de conflictos y los duplicados solo están disponibles para administradores.`
              : "Inicia sesión con una cuenta administradora para revisar, comparar y corregir fichas."}
          </p>
          {user ? null : (
            <div className="access-block__actions">
              <button type="button" className="btn btn--primary" onClick={() => setSigningIn(true)}>
                <SignIn size={16} weight="bold" aria-hidden="true" />
                Iniciar sesión
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="curation-shell">
          <CurationNav summary={summary} />
          <div className="curation-shell__main">
            <Suspense fallback={<RowsSkeleton rows={4} label="Cargando la sección…" />}>
              <Outlet context={context} />
            </Suspense>
          </div>
        </div>
      )}

      {signingIn ? <OperatorDialog onClose={() => setSigningIn(false)} /> : null}
    </>
  );
}

interface NavEntry {
  to: string;
  label: string;
  icon: Icon;
  end?: boolean;
  count?: number;
  fresh?: boolean;
  title?: string;
}

/** Nombre de la sección abierta, para el botón del menú en pantallas angostas. */
function currentEntry(pathname: string, entries: NavEntry[]): Pick<NavEntry, "label" | "icon" | "count"> {
  const match = entries.find((entry) => (entry.end ? pathname === entry.to || pathname === `${entry.to}/` : pathname.startsWith(entry.to)));
  if (match) return match;
  if (pathname.startsWith("/curaduria/hallazgos")) return { label: "Hallazgos filtrados", icon: Pulse };
  if (pathname.startsWith("/curaduria/revision")) return { label: "Revisión", icon: Pulse };
  return entries[0]!;
}

/**
 * Menú lateral de Curaduría. En escritorio es una columna fija a la izquierda;
 * por debajo de 1024 px se pliega en un botón que muestra la sección abierta y
 * despliega la lista completa.
 */
function CurationNav({ summary }: { summary: CurationSummary | undefined }) {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const overview: NavEntry = { to: "/curaduria", end: true, label: "Conflictos", icon: Pulse, ...(summary ? { count: summary.totals.open } : {}) };
  const categories: NavEntry[] = summary?.categories.map((category) => ({
    to: `/curaduria/categoria/${category.key}`,
    label: category.label,
    icon: categoryIcon(category.key),
    count: category.open,
    fresh: category.newInLastScan > 0,
    title: category.description,
  })) ?? [];
  const tools: NavEntry[] = [{ to: "/curaduria/duplicados", label: "Posibles duplicados", icon: Copy }];
  const current = currentEntry(pathname, [overview, ...categories, ...tools]);
  const CurrentIcon = current.icon;

  return (
    <aside className={`cside${open ? " is-open" : ""}`}>
      <button type="button" className="cside__toggle" aria-expanded={open} aria-controls="cside-nav" onClick={() => setOpen((value) => !value)}>
        <CurrentIcon size={18} weight="bold" aria-hidden="true" />
        <span className="cside__toggle-text">
          <span className="cside__toggle-kicker">Sección</span>
          <span className="cside__toggle-label">{current.label}</span>
        </span>
        {current.count !== undefined ? <NavCount value={current.count} /> : null}
        <CaretDown className="cside__caret" size={16} weight="bold" aria-hidden="true" />
      </button>

      <div className="cside__panel">
        <nav id="cside-nav" className="cside__nav" aria-label="Herramientas de curaduría">
          <div className="cside__sheet">
            <NavGroup id="cside-overview" label="Panorama" entries={[overview]} />
            {summary ? (
              <NavGroup id="cside-categories" label="Categorías" entries={categories} />
            ) : (
              <div className="cside__group">
                <p className="cside__heading">Categorías</p>
                {[0, 1, 2, 3].map((index) => <span key={index} className="skeleton cside__skeleton" aria-hidden="true" />)}
              </div>
            )}
            <NavGroup id="cside-tools" label="Herramientas" entries={tools} />
          </div>
        </nav>
      </div>
    </aside>
  );
}

function NavGroup({ id, label, entries }: { id: string; label: string; entries: NavEntry[] }) {
  return (
    <div className="cside__group">
      <p className="cside__heading" id={id}>{label}</p>
      <ul className="cside__list" aria-labelledby={id}>
        {entries.map((entry) => (
          <li key={entry.to}>
            <NavLink
              to={entry.to}
              {...(entry.end ? { end: true } : {})}
              {...(entry.title ? { title: entry.title } : {})}
              className={({ isActive }) => `cside__link${isActive ? " is-active" : ""}${entry.count === 0 ? " is-empty" : ""}`}
            >
              <entry.icon className="cside__icon" size={17} weight="bold" aria-hidden="true" />
              <span className="cside__label">{entry.label}</span>
              {entry.count !== undefined ? <NavCount value={entry.count} fresh={entry.fresh ?? false} /> : null}
            </NavLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NavCount({ value, fresh = false }: { value: number; fresh?: boolean }) {
  return (
    <span className={`cside__count${value === 0 ? " is-zero" : ""}`}>
      {fresh ? <span className="cside__fresh" aria-hidden="true" /> : null}
      {formatCount(value)}
      {fresh ? <span className="visually-hidden"> (con hallazgos nuevos)</span> : null}
    </span>
  );
}
