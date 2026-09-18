// CRV · Índice de búsqueda en memoria (PHASES E11.9; plan P12).
//
// LA BASE ES `SQL_ASCII` Y NO SABE COMPARAR SIN TILDES: `lower('ÁNGEL')` sigue
// devolviendo `Ángel` y `ILIKE '%jose%'` no encuentra «José» (regla 0.1.11 del
// plan). Con ~10k personas, cargar nombres y alias (dos SELECT, <1 MB) y
// filtrar en Node es más barato y exacto que cualquier truco en SQL.
//
// REFRESCO SIN BLOQUEAR (auditoría de rendimiento #2). Antes, al vencer el TTL
// de 60 s, la primera búsqueda pagaba la recarga completa dentro de su propia
// petición: medido entre 0,2–0,6 s con la caché del disco fría y hasta 24–30 s
// con el disco ocupado (contenedores de prueba, respaldos), porque PostgreSQL
// vive en un HDD. Ahora el patrón es stale-while-revalidate: una lectura con
// el índice vencido recibe LO QUE HAY y dispara el refresco de fondo —uno solo
// a la vez, con 5 s de espera tras un fallo—. Bloquea únicamente el primer
// uso absoluto: sin datos no hay nada que servir.
//
// LA INVALIDACIÓN ES UN AVISO, NO UN BORRADO: `invalidateSearchIndex()` marca
// los índices vencidos y ARRANCA el refresco en el acto —la escritura recién
// confirmada deja la base caliente y la recarga cuesta ~100 ms—. Una lectura
// que llegue en ese instante sirve el índice anterior; la siguiente ya ve el
// cambio. Es el precio de no colgar a nadie detrás de una recarga larga.
import { getPool } from "../db/client.js";
import { moduleLogger } from "../logger/index.js";
import { normalizeEntityName } from "../normalization/entity-name.js";

export type IndexedKind = "person" | "artist" | "organization";

export interface SearchIndexEntry {
  id: number;
  name: string;
  /** Claves comparables: el nombre propio y cada alias, sin tildes ni mayúsculas. */
  keys: string[];
}

const log = moduleLogger("api:search-index");

const TTL_MS = 60_000;
/** Tras un fallo, espacio antes de volver a intentar (no castigar la base). */
const REFRESH_RETRY_MS = 5_000;

const SOURCES: Readonly<Record<IndexedKind, { table: string; aliasTable: string; aliasColumn: string }>> = {
  person: { table: "public.persons", aliasTable: "ingest.person_aliases", aliasColumn: "person_id" },
  artist: { table: "public.artists", aliasTable: "ingest.artist_aliases", aliasColumn: "artist_id" },
  organization: { table: "public.organizations", aliasTable: "ingest.organization_aliases", aliasColumn: "organization_id" },
};

interface CacheEntry {
  entries: SearchIndexEntry[];
  /** true desde la primera carga con éxito (aunque el catálogo esté vacío). */
  loaded: boolean;
  /** Momento de la última carga con éxito. */
  loadedAt: number;
  /** Una invalidación pidió refresco: la próxima lectura sirve lo que hay y refresca. */
  stale: boolean;
  /** Último fallo (0 = ninguno): espacia los reintentos. */
  failureAt: number;
}

const cache = new Map<IndexedKind, CacheEntry>();
/** Cargas en vuelo: una sola por tipo, compartida por quien la espere. */
const inFlight = new Map<IndexedKind, Promise<void>>();

function entryFor(kind: IndexedKind): CacheEntry {
  let entry = cache.get(kind);
  if (!entry) {
    entry = { entries: [], loaded: false, loadedAt: 0, stale: false, failureAt: 0 };
    cache.set(kind, entry);
  }
  return entry;
}

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

/** Carga y guarda; el fallo sube (bloqueante) y queda fechado para el reintento. */
async function loadInto(kind: IndexedKind): Promise<void> {
  const entry = entryFor(kind);
  try {
    const entries = await loadEntries(kind);
    entry.entries = entries;
    entry.loaded = true;
    entry.loadedAt = Date.now();
    entry.stale = false;
    entry.failureAt = 0;
  } catch (error) {
    entry.failureAt = Date.now();
    throw error;
  }
}

/** Carga compartida: dos lecturas simultáneas sin datos pagan una sola carga. */
function loadOnce(kind: IndexedKind): Promise<void> {
  const running = inFlight.get(kind);
  if (running) return running;
  const promise = loadInto(kind).finally(() => inFlight.delete(kind));
  inFlight.set(kind, promise);
  return promise;
}

/**
 * Refresco de fondo: nunca lanza y, si falla, conserva el índice anterior
 * (mejor viejo que una búsqueda caída). Un solo refresco por tipo a la vez.
 */
function refreshInBackground(kind: IndexedKind, onError?: (error: unknown) => void): Promise<void> {
  const running = inFlight.get(kind);
  if (running) return running;
  const entry = entryFor(kind);
  if (entry.failureAt !== 0 && Date.now() - entry.failureAt < REFRESH_RETRY_MS) return Promise.resolve();
  return loadOnce(kind).catch((error: unknown) => {
    log.warn({ err: error, kind }, "no se pudo refrescar el índice de búsqueda; se sirve el anterior");
    onError?.(error);
  });
}

/**
 * Fuerza la recarga (de uno o de los tres) y espera a que termine. La usan el
 * arranque y las pruebas; en operación normal basta la invalidación al escribir.
 */
export async function refreshSearchIndex(kind?: IndexedKind): Promise<void> {
  const kinds = kind ? [kind] : Object.keys(SOURCES) as IndexedKind[];
  await Promise.all(kinds.map((current) => refreshInBackground(current)));
}

async function entriesFor(kind: IndexedKind): Promise<SearchIndexEntry[]> {
  const entry = cache.get(kind);
  if (entry?.loaded) {
    if (entry.stale || Date.now() - entry.loadedAt >= TTL_MS) void refreshInBackground(kind);
    return entry.entries;
  }
  // Primer uso absoluto: no hay índice anterior que servir.
  await loadOnce(kind);
  return entryFor(kind).entries;
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

/**
 * Sin `kind`, invalida los tres índices. Se llama al terminar cualquier
 * escritura del catálogo: marca lo servido como vencido y refresca ya, sin
 * bloquear a quien escribió ni a quien lea en el intervalo.
 */
export function invalidateSearchIndex(kind?: IndexedKind): void {
  const kinds = kind ? [kind] : Object.keys(SOURCES) as IndexedKind[];
  for (const current of kinds) {
    const entry = cache.get(current);
    if (entry) entry.stale = true;
    void refreshInBackground(current);
  }
}

/**
 * Carga los tres índices. Se llama al arrancar la API —en segundo plano y sin
 * bloquear el `listen`— para que la primera búsqueda real no sea la que pague
 * la lectura completa (~900 ms en caliente; en frío, lo que diga el disco).
 * Con los índices ya frescos no hace nada.
 */
export async function warmSearchIndex(onError?: (error: unknown) => void): Promise<void> {
  await Promise.all((Object.keys(SOURCES) as IndexedKind[]).map(async (kind) => {
    const entry = cache.get(kind);
    if (entry?.loaded && !entry.stale && Date.now() - entry.loadedAt < TTL_MS) return;
    await refreshInBackground(kind, onError);
  }));
}

/** Cuántos tipos de índice están cargados (diagnóstico y sondas). */
export function searchIndexSize(): number {
  return [...cache.values()].filter((entry) => entry.loaded).length;
}
