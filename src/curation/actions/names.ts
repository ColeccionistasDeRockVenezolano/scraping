// CRV · Colisiones de nombre antes de renombrar (PLAN_CURADURIA E4.7, M6).
//
// Renombrar puede crear un duplicado lógico, y en artistas (`name` es UNIQUE en
// el core) directamente falla. La vista previa busca, sin tildes ni mayúsculas
// (`nameKey`, en TypeScript: la base es SQL_ASCII), fichas del mismo tipo con el
// nombre nuevo: artistas, personas y organizaciones en todo el catálogo; discos
// dentro del mismo artista; pistas dentro del mismo disco.
//
// Los nombres de cada ámbito se cargan una sola vez por vista previa, y cada
// renombrado que el lote ya propone se superpone: dos fichas que el mismo lote
// deja con el mismo nombre también chocan.
//
// Al aplicar no se recarga nada: solo importa la colisión que bloquea
// (idéntica en artistas), y esa se comprueba con igualdad exacta en SQL dentro
// de la transacción del ítem.
import type { PoolClient } from "pg";
import type { ResolvableClaimKind } from "../../merge/specs.js";
import { nameKey } from "../lexicon.js";
import type { Collision, NameLookup } from "./types.js";

/** Las colisiones que se muestran por ítem: bastan para decidir. */
const MAX_COLLISIONS = 20;

interface ScopeIndex {
  labels: Map<number, string>;
  byKey: Map<string, Set<number>>;
}

/** Nombres fijos del core, no vienen del usuario. */
const SCOPES: Readonly<Record<ResolvableClaimKind, { all: string; parentOf?: string; inParent?: string }>> = {
  artist: { all: "SELECT id::text, name AS label FROM public.artists" },
  person: { all: "SELECT id::text, name AS label FROM public.persons" },
  organization: { all: "SELECT id::text, name AS label FROM public.organizations" },
  album: {
    all: "",
    parentOf: "SELECT artist_id::text AS parent FROM public.albums WHERE id=$1",
    inParent: "SELECT id::text, title AS label FROM public.albums WHERE artist_id=$1",
  },
  track: {
    all: "",
    parentOf: "SELECT album_id::text AS parent FROM public.tracks WHERE id=$1",
    inParent: "SELECT id::text, title AS label FROM public.tracks WHERE album_id=$1",
  },
};

function addToKey(index: ScopeIndex, id: number, label: string): void {
  const key = nameKey(label);
  if (!key) return;
  const ids = index.byKey.get(key);
  if (ids) ids.add(id); else index.byKey.set(key, new Set([id]));
}

/** Búsqueda de la vista previa: índices por ámbito cargados bajo demanda, con los renombrados del lote superpuestos. */
export function previewNameLookup(client: PoolClient): NameLookup {
  const indexes = new Map<string, Promise<ScopeIndex>>();
  const parents = new Map<string, Promise<number | null>>();
  /** Nombre que ya le da a cada ficha un ítem anterior del lote, por tipo. */
  const renamed = new Map<ResolvableClaimKind, Map<number, string>>();

  const parentOf = (kind: ResolvableClaimKind, id: number): Promise<number | null> => {
    const sql = SCOPES[kind].parentOf;
    if (!sql) return Promise.resolve(null);
    const cacheKey = `${kind}:${id}`;
    let parent = parents.get(cacheKey);
    if (!parent) {
      parent = client.query<{ parent: string | null }>(sql, [id]).then(({ rows }) => (rows[0]?.parent ? Number(rows[0].parent) : null));
      parents.set(cacheKey, parent);
    }
    return parent;
  };

  const indexOf = (kind: ResolvableClaimKind, parent: number | null): Promise<ScopeIndex> => {
    const scopeKey = `${kind}:${parent ?? "*"}`;
    let index = indexes.get(scopeKey);
    if (!index) {
      const scope = SCOPES[kind];
      const query = scope.inParent ? client.query<{ id: string; label: string }>(scope.inParent, [parent])
        : client.query<{ id: string; label: string }>(scope.all);
      index = query.then(({ rows }) => {
        const built: ScopeIndex = { labels: new Map(), byKey: new Map() };
        for (const row of rows) {
          built.labels.set(Number(row.id), row.label);
          addToKey(built, Number(row.id), row.label);
        }
        return built;
      });
      indexes.set(scopeKey, index);
    }
    return index;
  };

  return {
    async similar(kind, id, value) {
      const key = nameKey(value);
      if (!key) return [];
      const parent = await parentOf(kind, id);
      if (SCOPES[kind].inParent && parent === null) return [];
      const index = await indexOf(kind, parent);
      // El nombre vigente de cada ficha: el que ya le da un ítem anterior del lote, o el del catálogo.
      const overlay = renamed.get(kind);
      const candidates = new Set(index.byKey.get(key) ?? []);
      for (const [other, label] of overlay ?? []) {
        if (index.labels.has(other) && nameKey(label) === key) candidates.add(other);
      }
      const found: Collision[] = [];
      for (const other of candidates) {
        const label = overlay?.get(other) ?? index.labels.get(other);
        if (other === id || label === undefined || nameKey(label) !== key) continue;
        found.push({ kind, id: other, label, exact: label === value });
      }
      return found.sort((a, b) => Number(b.exact) - Number(a.exact) || a.id - b.id).slice(0, MAX_COLLISIONS);
    },
    rename(kind, id, value) {
      const overlay = renamed.get(kind);
      if (overlay) overlay.set(id, value); else renamed.set(kind, new Map([[id, value]]));
    },
  };
}

/** Búsqueda al aplicar: solo la colisión que bloquea (nombre idéntico de artista), dentro de la transacción del ítem. */
export function liveNameLookup(client: PoolClient): NameLookup {
  return {
    async similar(kind, id, value) {
      if (kind !== "artist") return [];
      const { rows } = await client.query<{ id: string; name: string }>(
        "SELECT id::text, name FROM public.artists WHERE name=$1 AND id<>$2 ORDER BY id", [value, id]);
      return rows.map((row): Collision => ({ kind, id: Number(row.id), label: row.name, exact: true }));
    },
    rename() {
      // Al aplicar, el catálogo vivo ya refleja los ítems anteriores.
    },
  };
}
