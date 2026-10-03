import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, MagnifyingGlass, Question, X } from "@phosphor-icons/react";
import type { GenreFacet, GenreFacets, GenreFamilyFacet, GenreGenreFacet } from "../lib/types";
import { WITHOUT_GENRE, type GenreSelection } from "../lib/useGenreFilter";
import { useMediaQuery } from "../lib/useMediaQuery";

export type GenreListKind = "album" | "artist";

/** Textos que cambian entre la lista de discos y la de artistas. */
const COPY: Record<GenreListKind, {
  plural: string;
  related: (count: string, genre: string) => string;
  relatedHint: string;
  withoutNote: string;
  withoutBreakdown: string;
}> = {
  // Artistas: desde 0036 reciben los géneros de sus discos, así que no hay
  // ampliación ni desglose (sus `relatedCount` son 0 y no se muestran).
  album: {
    plural: "discos",
    related: (count, genre) => `Sumar ${count} discos sin género cuyo artista es de ${genre}`,
    relatedHint: "Esos discos aún no tienen género propio; aparecen marcados «Por su artista».",
    withoutNote: "Estos discos todavía no tienen un género confirmado por una fuente.",
    withoutBreakdown: "Encuéntralos por el género de su artista:",
  },
  artist: {
    plural: "artistas",
    related: () => "",
    relatedHint: "",
    withoutNote: "Estos artistas todavía no tienen un género confirmado: ni propio ni de sus discos.",
    withoutBreakdown: "",
  },
};

/** Subgéneros visibles antes de «Ver más»: los más poblados primero. */
const SUB_PREVIEW = 8;

export const formatCount = (value: number) => value.toLocaleString("es-VE");

const normalize = (value: string) => value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();

interface GenreFilterProps {
  kind: GenreListKind;
  facets: GenreFacets | undefined;
  facetsError: string | undefined;
  onRetryFacets: () => void;
  selection: GenreSelection;
  onFamily: (slug: string | null) => void;
  onSub: (family: string, slug: string | null) => void;
  /** Elige un estilo (tercer nivel) del subgénero; `null` deja todo el subgénero. */
  onStyle: (family: string, sub: string, slug: string | null) => void;
  onRelated: (value: boolean) => void;
  /** Elige una familia y suma las fichas por relación de un solo paso (desde «Sin género»). */
  onFamilyRelated: (slug: string) => void;
}

/**
 * Filtro por género y subgénero de las listas de discos y artistas: una fila
 * de géneros (familias) con cuántas fichas tiene cada uno, los subgéneros del
 * elegido, los estilos del subgénero si los tiene (joropo → pasaje, golpe…), un buscador para saltar directo a cualquier estilo y la vía para
 * las fichas sin género (verlas todas o encontrarlas por su relación).
 */
export function GenreFilter({ kind, facets, facetsError, onRetryFacets, selection, onFamily, onSub, onStyle, onRelated, onFamilyRelated }: GenreFilterProps) {
  const copy = COPY[kind];
  const [expanded, setExpanded] = useState(false);
  // En móvil los subgéneros van en una fila que se desliza: caben todos sin «Ver más».
  const isMobile = useMediaQuery("(max-width: 760px)");
  const railRef = useRef<HTMLDivElement>(null);
  const subRailRef = useRef<HTMLDivElement>(null);
  const styleRailRef = useRef<HTMLDivElement>(null);
  const labelId = useId();

  const family = facets?.families.find((entry) => entry.slug === selection.family) ?? null;
  const isWithout = selection.family === WITHOUT_GENRE;
  const effective = (facet: GenreFacet) => facet.count + (selection.related ? facet.relatedCount : 0);

  // Al cambiar de familia, los subgéneros vuelven a la vista corta.
  useEffect(() => { setExpanded(false); }, [selection.family]);

  // Las filas se desplazan en móvil: la opción elegida (p. ej. desde un enlace
  // compartido o el buscador) se trae a la vista sin mover la página.
  useEffect(() => {
    for (const rail of [railRef.current, subRailRef.current, styleRailRef.current]) {
      const pressed = rail?.querySelector<HTMLElement>('[aria-pressed="true"]');
      if (!rail || !pressed || rail.scrollWidth <= rail.clientWidth) continue;
      const left = pressed.offsetLeft - rail.offsetLeft - rail.clientWidth / 2 + pressed.offsetWidth / 2;
      const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      rail.scrollTo({ left: Math.max(0, left), behavior: calm ? "auto" : "smooth" });
    }
  }, [selection.family, selection.sub, selection.style, facets, isMobile]);

  if (facetsError && !facets) {
    return (
      <div className="gfilter gfilter--error" role="alert">
        <span>No se pudieron cargar los géneros.</span>
        <button type="button" className="btn btn--sm" onClick={onRetryFacets}>Reintentar</button>
      </div>
    );
  }

  if (!facets) {
    return (
      <div className="gfilter" aria-busy="true" aria-label="Cargando géneros">
        <div className="gfilter__rail">
          {Array.from({ length: 7 }, (_, index) => <span key={index} className="gchip gchip--skeleton" style={{ width: 70 + (index % 3) * 22 }} />)}
        </div>
      </div>
    );
  }

  const families = facets.families.filter((entry) => effective(entry) > 0 || entry.slug === selection.family);
  const subs = family ? family.genres.filter((entry) => effective(entry) > 0 || entry.slug === selection.sub) : [];
  // En la vista corta, el subgénero elegido siempre queda visible.
  const shortSubs = subs.slice(0, SUB_PREVIEW);
  const selectedSub = subs.find((entry) => entry.slug === selection.sub);
  if (selectedSub && !shortSubs.includes(selectedSub)) shortSubs.push(selectedSub);
  const visibleSubs = expanded || isMobile ? subs : shortSubs;
  const hiddenCount = isMobile ? 0 : subs.length - shortSubs.length;
  // Estilos: el tercer nivel solo aparece bajo un subgénero que los tenga, y son pocos (sin «Ver más»).
  const styles = selectedSub?.subgenres?.filter((entry) => effective(entry) > 0 || entry.slug === selection.style) ?? [];
  const selectedStyle = styles.find((entry) => entry.slug === selection.style);
  const genreName = selectedStyle?.name ?? selectedSub?.name ?? family?.name ?? "";
  const relatedCount = (selectedStyle ?? selectedSub ?? family)?.relatedCount ?? 0;
  const withoutBreakdown = facets.families.filter((entry) => entry.relatedCount > 0)
    .sort((a, b) => b.relatedCount - a.relatedCount);

  return (
    <section className="gfilter" aria-labelledby={labelId}>
      <div className="gfilter__head">
        <h2 id={labelId} className="gfilter__label">Filtrar por género</h2>
        <GenreFinder facets={facets} related={selection.related} onFamily={(slug) => { if (slug !== selection.family || selection.sub) onFamily(slug); }} onSub={onSub} onStyle={onStyle} />
      </div>

      <div className="gfilter__rail" ref={railRef} role="group" aria-label="Géneros">
        <GenreChip label="Todos" count={facets.total} pressed={selection.family === null} onClick={() => { if (selection.family !== null) onFamily(null); }} />
        {families.map((entry) => (
          <GenreChip key={entry.slug} label={entry.name} count={effective(entry)} pressed={selection.family === entry.slug}
            onClick={() => onFamily(entry.slug)} />
        ))}
        <span className="gfilter__divider" aria-hidden="true" />
        <GenreChip label="Sin género" count={facets.withoutGenre} pressed={isWithout} variant="none"
          icon={<Question aria-hidden="true" weight="bold" />} onClick={() => onFamily(WITHOUT_GENRE)} />
      </div>

      {family && subs.length > 0 ? (
        <div className="gfilter__subs">
          <p className="gfilter__sublabel">Subgéneros de <strong>{family.name}</strong></p>
          <div className="gfilter__subchips" ref={subRailRef} role="group" aria-label={`Subgéneros de ${family.name}`}>
            <GenreChip label={`Todo ${family.name}`} count={effective(family)} pressed={selection.sub === null} small
              onClick={() => { if (selection.sub !== null) onSub(family.slug, null); }} />
            {visibleSubs.map((entry, index) => (
              <GenreChip key={entry.slug} label={entry.name} count={effective(entry)} pressed={selection.sub === entry.slug} small
                revealed={expanded && index >= SUB_PREVIEW}
                onClick={() => onSub(family.slug, selection.sub === entry.slug ? null : entry.slug)} />
            ))}
            {hiddenCount > 0 ? (
              <button type="button" className="gchip gchip--more" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
                {expanded ? "Ver menos" : `Ver ${hiddenCount} más`}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {family && selectedSub && styles.length > 0 ? (
        <div className="gfilter__subs">
          <p className="gfilter__sublabel">Estilos de <strong>{selectedSub.name}</strong></p>
          <div className="gfilter__subchips" ref={styleRailRef} role="group" aria-label={`Estilos de ${selectedSub.name}`}>
            <GenreChip label={`Todo ${selectedSub.name}`} count={effective(selectedSub)} pressed={selection.style === null} small
              onClick={() => { if (selection.style !== null) onStyle(family.slug, selectedSub.slug, null); }} />
            {styles.map((entry) => (
              <GenreChip key={entry.slug} label={entry.name} count={effective(entry)} pressed={selection.style === entry.slug} small
                onClick={() => onStyle(family.slug, selectedSub.slug, selection.style === entry.slug ? null : entry.slug)} />
            ))}
          </div>
        </div>
      ) : null}

      {family && relatedCount > 0 ? (
        <label className="gfilter__related">
          <input type="checkbox" checked={selection.related} onChange={(event) => onRelated(event.target.checked)} />
          <span>
            <span className="gfilter__related-text">{copy.related(formatCount(relatedCount), genreName)}</span>
            <span className="gfilter__related-hint">{copy.relatedHint}</span>
          </span>
        </label>
      ) : null}

      {isWithout ? (
        <div className="gfilter__without">
          <p>{copy.withoutNote}</p>
          {withoutBreakdown.length > 0 ? (
            <>
              <p className="gfilter__sublabel">{copy.withoutBreakdown}</p>
              <div className="gfilter__subchips" role="group" aria-label={copy.withoutBreakdown}>
                {withoutBreakdown.map((entry) => (
                  <GenreChip key={entry.slug} label={entry.name} count={entry.relatedCount} pressed={false} small
                    onClick={() => onFamilyRelated(entry.slug)} />
                ))}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

interface GenreChipProps {
  label: string;
  count: number;
  pressed: boolean;
  onClick: () => void;
  small?: boolean;
  revealed?: boolean;
  variant?: "none";
  icon?: React.ReactNode;
}

function GenreChip({ label, count, pressed, onClick, small, revealed, variant, icon }: GenreChipProps) {
  const className = ["gchip", small ? "gchip--sub" : "", variant === "none" ? "gchip--none" : "", revealed ? "is-revealed" : ""]
    .filter(Boolean).join(" ");
  return (
    <button type="button" className={className} aria-pressed={pressed} onClick={onClick}
      aria-label={`${label}: ${formatCount(count)}`}>
      {pressed ? <Check className="gchip__check" aria-hidden="true" weight="bold" /> : icon ?? null}
      <span className="gchip__text">{label}</span>
      <span className="gchip__count" aria-hidden="true">{formatCount(count)}</span>
    </button>
  );
}

interface FinderOption {
  key: string;
  name: string;
  context: string;
  count: number;
  family: GenreFamilyFacet;
  sub: GenreGenreFacet | null;
  style: GenreFacet | null;
}

/** Buscador de estilos: escribe «thrash», «ska» o «pasaje» y salta al subgénero o estilo sin saber su familia. */
function GenreFinder({ facets, related, onFamily, onSub, onStyle }: {
  facets: GenreFacets;
  related: boolean;
  onFamily: (slug: string) => void;
  onSub: (family: string, slug: string | null) => void;
  onStyle: (family: string, sub: string, slug: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const listboxId = `${inputId}-listbox`;

  const options = useMemo<FinderOption[]>(() => {
    const all: FinderOption[] = [];
    const total = (facet: GenreFacet) => facet.count + (related ? facet.relatedCount : 0);
    for (const family of facets.families) {
      all.push({ key: family.slug, name: family.name, context: "Género", count: total(family), family, sub: null, style: null });
      for (const sub of family.genres) {
        all.push({ key: `${family.slug}/${sub.slug}`, name: sub.name, context: `Subgénero de ${family.name}`, count: total(sub), family, sub, style: null });
        for (const style of sub.subgenres ?? []) {
          all.push({ key: `${family.slug}/${sub.slug}/${style.slug}`, name: style.name, context: `Estilo de ${sub.name}`, count: total(style), family, sub, style });
        }
      }
    }
    return all.filter((option) => option.count > 0);
  }, [facets, related]);

  const results = useMemo(() => {
    const needle = normalize(query);
    if (!needle) return [];
    return options
      .map((option) => ({ option, at: normalize(option.name).indexOf(needle) }))
      .filter((entry) => entry.at >= 0)
      // Primero lo que empieza por lo escrito; luego lo más poblado.
      .sort((a, b) => Number(a.at !== 0) - Number(b.at !== 0) || b.option.count - a.option.count)
      .slice(0, 8)
      .map((entry) => entry.option);
  }, [options, query]);

  useEffect(() => { setActive(0); }, [query]);

  useEffect(() => {
    function onOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, []);

  function choose(option: FinderOption | undefined) {
    if (!option) return;
    if (option.sub && option.style) onStyle(option.family.slug, option.sub.slug, option.style.slug);
    else if (option.sub) onSub(option.family.slug, option.sub.slug);
    else onFamily(option.family.slug);
    setQuery("");
    setOpen(false);
    inputRef.current?.blur();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((current) => Math.min(current + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      if (open && results.length) { event.preventDefault(); choose(results[active]); }
    } else if (event.key === "Escape") {
      if (query) setQuery(""); else setOpen(false);
    }
  }

  const showList = open && query.trim().length > 0;

  return (
    <div className="gfinder" ref={containerRef}>
      <MagnifyingGlass className="gfinder__icon" aria-hidden="true" />
      <input
        ref={inputRef}
        id={inputId}
        className="gfinder__input"
        type="search"
        role="combobox"
        aria-label="Buscar un género o subgénero"
        aria-autocomplete="list"
        aria-expanded={showList}
        aria-controls={listboxId}
        aria-activedescendant={showList && results.length ? `${listboxId}-${active}` : undefined}
        autoComplete="off"
        enterKeyHint="search"
        value={query}
        placeholder="Buscar estilo: thrash, ska, trova…"
        onFocus={() => setOpen(true)}
        onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
        onKeyDown={handleKeyDown}
      />
      {query ? (
        <button type="button" className="gfinder__clear" aria-label="Borrar búsqueda de estilo" onClick={() => { setQuery(""); inputRef.current?.focus(); }}>
          <X aria-hidden="true" weight="bold" />
        </button>
      ) : null}
      {showList ? (
        <div id={listboxId} role="listbox" aria-label="Estilos encontrados" className="gfinder__list">
          {results.length ? results.map((option, index) => (
            <button
              key={option.key}
              id={`${listboxId}-${index}`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={index === active}
              className="gfinder__option"
              onMouseEnter={() => setActive(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(option)}
            >
              <span className="gfinder__name">{option.name}</span>
              <span className="gfinder__context">{option.context}</span>
              <span className="gfinder__count">{formatCount(option.count)}</span>
            </button>
          )) : <p className="gfinder__empty">Ningún estilo coincide con «{query.trim()}».</p>}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Línea de resultado bajo los filtros: cuántas fichas se ven y qué filtros
 * están activos, cada uno con su «quitar» y un «Quitar filtros» general.
 */
export function ListSummary({ total, noun, query, genreLabel, onClearQuery, onClearGenre, loading }: {
  total: number | undefined;
  noun: { one: string; many: string };
  query: string;
  genreLabel: string | null;
  onClearQuery: () => void;
  onClearGenre: () => void;
  loading: boolean;
}) {
  const filtered = Boolean(query.trim()) || genreLabel !== null;
  return (
    <div className="list-summary" aria-live="polite" aria-busy={loading}>
      <p className="list-summary__count">
        {total === undefined ? " " : <><strong>{formatCount(total)}</strong> {total === 1 ? noun.one : noun.many}</>}
      </p>
      {filtered ? (
        <ul className="list-summary__filters" aria-label="Filtros activos">
          {query.trim() ? (
            <li><button type="button" className="fpill" onClick={onClearQuery} aria-label={`Quitar búsqueda «${query.trim()}»`}>
              <span className="fpill__text">«{query.trim()}»</span><X aria-hidden="true" weight="bold" />
            </button></li>
          ) : null}
          {genreLabel ? (
            <li><button type="button" className="fpill" onClick={onClearGenre} aria-label={`Quitar filtro ${genreLabel}`}>
              <span className="fpill__text">{genreLabel}</span><X aria-hidden="true" weight="bold" />
            </button></li>
          ) : null}
          {query.trim() && genreLabel ? (
            <li><button type="button" className="btn btn--ghost btn--sm list-summary__clear" onClick={() => { onClearQuery(); onClearGenre(); }}>Quitar filtros</button></li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

/** Nombre legible del filtro activo («Metal › Thrash metal», «Música venezolana › Joropo › Pasaje», «Sin género»), con la ampliación si está puesta. */
export function genreSelectionLabel(facets: GenreFacets | undefined, selection: GenreSelection): string | null {
  if (!selection.family) return null;
  if (selection.family === WITHOUT_GENRE) return "Sin género";
  const family = facets?.families.find((entry) => entry.slug === selection.family);
  const sub = selection.sub ? family?.genres.find((entry) => entry.slug === selection.sub) : undefined;
  const style = selection.style ? sub?.subgenres?.find((entry) => entry.slug === selection.style) : undefined;
  const base = [family?.name ?? selection.family, selection.sub ? sub?.name ?? selection.sub : null, selection.style ? style?.name ?? selection.style : null]
    .filter(Boolean).join(" › ");
  return selection.related ? `${base} (+ por su artista)` : base;
}
