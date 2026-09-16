// CRV · Índice de búsqueda en memoria (PHASES E11.9; plan P12).
//
// LA BASE ES `SQL_ASCII` Y NO SABE COMPARAR SIN TILDES: `lower('ÁNGEL')` sigue
// devolviendo `Ángel` y `ILIKE '%jose%'` no encuentra «José» (regla 0.1.11 del
// plan). Con ~10k personas, cargar nombres y alias (dos SELECT, <1 MB) y
// filtrar en Node es más barato y exacto que cualquier truco en SQL.
//
// SE INVALIDA AL ESCRIBIR: TTL de 60 s para el caso general y, además, un
// `invalidateSearchIndex()` explícito al terminar cualquier run de operador,
// una fusión en lote o un plan de correcciones, para que un alta o un cambio
// de nombre se vean de inmediato.
import { getPool } from "../db/client.js";
import { normalizeEntityName } from "../normalization/entity-name.js";

export type IndexedKind = "person" | "artist" | "organization";

export interface SearchIndexEntry {
  id: number;
  name: string;
  /** Claves comparables: el nombre propio y cada alias, sin tildes ni mayúsculas. */
  keys: string[];
}

const TTL_MS = 60_000;

const SOURCES: Readonly<Record<IndexedKind, { table: string; aliasTable: string; aliasColumn: string }>> = {
  person: { table: "public.persons", aliasTable: "ingest.person_aliases", aliasColumn: "person_id" },
  artist: { table: "public.artists", aliasTable: "ingest.artist_aliases", aliasColumn: "artist_id" },
  organization: { table: "public.organizations", aliasTable: "ingest.organization_aliases", aliasColumn: "organization_id" },
};

interface CacheEntry {
  loadedAt: number;
  entries: SearchIndexEntry[];
}

const cache = new Map<IndexedKind, CacheEntry>();

async function loadEntries(kind: IndexedKind): Promise<SearchIndexEntry[]> {
  const source = SOURCES[kind];
  const [entities, aliases] = await Promise.all([
    getPool().query<{ id: string; name: string }>(`SELECT id::text, name FROM ${source.table} ORDER BY id`),
    getPool().query<{ owner_id: string; alias: string }>(
      `SELECT ${source.aliasColumn}::text AS owner_id, alias FROM ${source.aliasTable} ORDER BY ${source.aliasColumn}, alias`),
  ]);
  const byId = new Map<number, SearchIndexEntry>();
  for (const row of entities.rows) {
    const key = normalizeEntityName(row.name).secondaryKey;
    byId.set(Number(row.id), { id: Number(row.id), name: row.name, keys: key ? [key] : [] });
  }
  for (const row of aliases.rows) {
    const entry = byId.get(Number(row.owner_id));
    const key = normalizeEntityName(row.alias).secondaryKey;
    if (entry && key && !entry.keys.includes(key)) entry.keys.push(key);
  }
  return [...byId.values()];
}

async function entriesFor(kind: IndexedKind): Promise<SearchIndexEntry[]> {
  const cached = cache.get(kind);
  if (cached && Date.now() - cached.loadedAt < TTL_MS) return cached.entries;
  const entries = await loadEntries(kind);
  cache.set(kind, { loadedAt: Date.now(), entries });
  return entries;
}

/**
 * Ids cuyo nombre o alias contiene la consulta (sin tildes ni mayúsculas),
 * con los que empiezan por ella primero. Vacío si la consulta no tiene nada
 * que comparar (solo signos).
 */
export async function searchIds(kind: IndexedKind, q: string): Promise<number[]> {
  const needle = normalizeEntityName(q).secondaryKey;
  if (!needle) return [];
  const entries = await entriesFor(kind);
  return entries
    .filter((entry) => entry.keys.some((key) => key.includes(needle)))
    .sort((left, right) => {
      const leftStarts = left.keys.some((key) => key.startsWith(needle)) ? 0 : 1;
      const rightStarts = right.keys.some((key) => key.startsWith(needle)) ? 0 : 1;
      return leftStarts - rightStarts || left.name.localeCompare(right.name, "es");
    })
    .map((entry) => entry.id);
}

/** Sin `kind`, invalida los tres índices. Se llama al terminar cualquier escritura. */
export function invalidateSearchIndex(kind?: IndexedKind): void {
  if (kind) cache.delete(kind);
  else cache.clear();
}

/**
 * Carga los tres índices. Se llama al arrancar la API —en segundo plano y sin
 * bloquear el `listen`— para que la primera búsqueda de una persona real no
 * pague la lectura completa (~10k nombres y alias): en la base de desarrollo
 * esa carga cuesta ~900 ms y las consultas siguientes, menos de 10 ms.
 */
export async function warmSearchIndex(onError?: (error: unknown) => void): Promise<void> {
  await Promise.all((Object.keys(SOURCES) as IndexedKind[]).map(async (kind) => {
    try {
      await entriesFor(kind);
    } catch (error) {
      onError?.(error);
    }
  }));
}

/** Solo para tests: cuántos índices hay cargados. */
export function searchIndexSize(): number {
  return cache.size;
}
