import { useEffect, useId, useRef, useState } from "react";
import { albumsApi, artistsApi, organizationsApi, personsApi } from "../lib/api";

type PickerKind = "artist" | "person" | "organization" | "album";

const SEARCHERS: Record<PickerKind, (q: string) => Promise<Array<{ id: number; label: string; sub?: string | null }>>> = {
  artist: (q) => artistsApi.list({ q, limit: 8 }).then((page) => page.data.map((row) => ({ id: row.id, label: row.name, sub: row.originCity }))),
  person: (q) => personsApi.list({ q, limit: 8 }).then((page) => page.data.map((row) => ({ id: row.id, label: row.name, sub: row.nationality }))),
  organization: (q) => organizationsApi.list({ q, limit: 8 }).then((page) => page.data.map((row) => ({ id: row.id, label: row.name, sub: row.organizationType }))),
  album: (q) => albumsApi.list({ q, limit: 8 }).then((page) => page.data.map((row) => ({ id: row.id, label: row.title, sub: row.artistName }))),
};

interface EntityPickerProps {
  kind: PickerKind;
  label: string;
  value: number | null;
  valueLabel: string | null;
  onSelect: (id: number, label: string) => void;
  placeholder?: string;
}

/** Buscar-y-elegir contra la API (sin cargar el catálogo entero en el navegador). */
export function EntityPicker({ kind, label, value, valueLabel, onSelect, placeholder }: EntityPickerProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<Array<{ id: number; label: string; sub?: string | null }>>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputId = useId();
  const listboxId = `${inputId}-listbox`;

  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    let active = true;
    const timer = window.setTimeout(() => {
      SEARCHERS[kind](query.trim()).then((rows) => { if (active) { setResults(rows); setActiveIndex(-1); } }).catch(() => { if (active) setResults([]); });
    }, 200);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query, kind]);

  useEffect(() => {
    function onOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, []);

  function choose(index: number) {
    const row = results[index];
    if (!row) return;
    onSelect(row.id, row.label);
    setOpen(false);
    setQuery("");
    setActiveIndex(-1);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) => Math.min(current + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter" && open && activeIndex >= 0) {
      event.preventDefault();
      choose(activeIndex);
    } else if (event.key === "Escape") {
      setOpen(false);
      setActiveIndex(-1);
    }
  }

  return (
    <div className="field" ref={containerRef} style={{ position: "relative" }}>
      <label htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open && results.length > 0}
        aria-controls={listboxId}
        aria-activedescendant={activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
        value={open ? query : (valueLabel ?? "")}
        onFocus={() => { setOpen(true); setQuery(""); }}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder ?? "Escribe para buscar…"}
      />
      {open && results.length > 0 ? (
        <div id={listboxId} role="listbox" aria-label={`Resultados para ${label}`} style={{
          position: "absolute", top: "100%", left: 0, right: 0, marginTop: 4, zIndex: 20,
          background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)",
          maxHeight: 220, overflowY: "auto", boxShadow: "var(--shadow-md)",
        }}>
          {results.map((row, index) => (
            <button
              key={row.id}
              id={`${listboxId}-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              type="button"
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(index)}
              style={{
                display: "block", width: "100%", textAlign: "left", padding: "8px 12px", background: "none",
                border: 0, borderBottom: "1px solid var(--border-soft)", cursor: "pointer", color: "var(--text)",
              }}
            >
              <div style={{ fontSize: 13.5, fontWeight: 600 }}>{row.label}</div>
              {row.sub ? <div style={{ fontSize: 11.5, color: "var(--text-faint)" }}>{row.sub}</div> : null}
            </button>
          ))}
        </div>
      ) : null}
      {value !== null && !open ? <span className="hint">id {value}</span> : null}
    </div>
  );
}
