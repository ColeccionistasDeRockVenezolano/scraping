// CRV · Cambios en la taxonomía de géneros (PLAN_GENEROS §4 «Cambios en la
// taxonomía» y etapa 2, puntos 2, 4 y 6).
//
// Toda modificación de `genres`/`genre_aliases` pasa por aquí: la carga
// inicial desde `data/genres/taxonomy.json` y los cambios sueltos del CLI
// (alias, renombre, desactivación). Cada operación queda en
// `genre_taxonomy_changes` con actor, motivo y antes/después, y solo se
// recalculan las entidades cuya evidencia depende de lo que cambió.
//
// `--dry-run` hace EXACTAMENTE lo mismo dentro de una transacción que se
// deshace al final: el reporte antes/después es el real, no una estimación.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import { z } from "zod";
import { getPool } from "../db/client.js";
import { normalizeGenreText } from "./normalize.js";
import type { GenreEntityKind } from "./rules.js";
import {
  GENRE_COLUMN, GENRE_REVIEW_KIND, GENRE_TABLE, loadAssignments, loadGenreClaims, loadTaxonomy, lockGenres,
  recomputeEntityGenres,
} from "./store.js";
import { candidateAliasKeys, resolveGenreValue, type GenreLevel } from "./taxonomy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_TAXONOMY_FILE = path.resolve(__dirname, "..", "..", "data", "genres", "taxonomy.json");

// --- Archivo de taxonomía -------------------------------------------------

const slugSchema = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/u, "slug en minúsculas-con-guiones");
const fileSchema = z.object({
  format: z.literal("crv-genre-taxonomy.v1"),
  status: z.string().optional(),
  families: z.array(z.object({
    slug: slugSchema, name: z.string().trim().min(1).max(100), description: z.string().optional(),
    aliases: z.array(z.string()).default([]), typoAliases: z.array(z.string()).default([]),
  })),
  genres: z.array(z.object({
    slug: slugSchema, name: z.string().trim().min(1).max(100), family: slugSchema, description: z.string().optional(),
    aliases: z.array(z.string()).default([]), typoAliases: z.array(z.string()).default([]),
  })),
  // Tercer nivel (0037): cada subgénero cuelga de un género del archivo.
  subgenres: z.array(z.object({
    slug: slugSchema, name: z.string().trim().min(1).max(100), genre: slugSchema, description: z.string().optional(),
    aliases: z.array(z.string()).default([]), typoAliases: z.array(z.string()).default([]),
  })).default([]),
  notAGenre: z.record(z.string(), z.array(z.string())).default({}),
}).passthrough();

export type TaxonomyFile = z.infer<typeof fileSchema>;

export interface DesiredTaxonomy {
  genres: Array<{ slug: string; name: string; level: GenreLevel; parentSlug: string | null; description: string | null }>;
  /** alias normalizado → slug o `not_a_genre`, con la nota que explica de dónde sale. */
  aliases: Map<string, { target: string; notes: string }>;
}

/** Valida el archivo y lo convierte en la taxonomía deseada. Falla ante cualquier ambigüedad. */
export function desiredFromFile(input: unknown): DesiredTaxonomy {
  const file = fileSchema.parse(input);
  const errors: string[] = [];
  const genres: DesiredTaxonomy["genres"] = [];
  const slugs = new Set<string>();
  const families = new Set(file.families.map((family) => family.slug));
  const genreSlugs = new Set(file.genres.map((genre) => genre.slug));
  const aliases = new Map<string, { target: string; notes: string }>();
  const addAlias = (raw: string, target: string, notes: string) => {
    const key = normalizeGenreText(raw);
    if (!key) { errors.push(`alias vacío tras normalizar: «${raw}» (${target})`); return; }
    const previous = aliases.get(key);
    if (previous && previous.target !== target) errors.push(`alias «${key}» apunta a ${previous.target} y a ${target}`);
    else if (!previous) aliases.set(key, { target, notes });
  };
  const addGenre = (entry: { slug: string; name: string; description?: string | undefined; aliases: string[]; typoAliases: string[] }, level: GenreLevel, parentSlug: string | null) => {
    if (slugs.has(entry.slug)) errors.push(`slug repetido: ${entry.slug}`);
    slugs.add(entry.slug);
    genres.push({ slug: entry.slug, name: entry.name, level, parentSlug, description: entry.description ?? null });
    addAlias(entry.name, entry.slug, "nombre del género");
    for (const alias of entry.aliases) addAlias(alias, entry.slug, "equivalencia aprobada");
    for (const alias of entry.typoAliases) addAlias(alias, entry.slug, "errata evidente de la fuente");
  };
  for (const family of file.families) addGenre(family, "family", null);
  for (const genre of file.genres) {
    if (!families.has(genre.family)) errors.push(`${genre.slug}: familia inexistente ${genre.family}`);
    addGenre(genre, "genre", genre.family);
  }
  for (const subgenre of file.subgenres) {
    if (!genreSlugs.has(subgenre.genre)) errors.push(`${subgenre.slug}: género inexistente ${subgenre.genre} (el padre de un subgénero es un género)`);
    addGenre(subgenre, "subgenre", subgenre.genre);
  }
  for (const [category, values] of Object.entries(file.notAGenre)) {
    for (const value of values) addAlias(value, "not_a_genre", `no es un género: ${category}`);
  }
  if (errors.length) throw new Error(`taxonomía inválida:\n  - ${errors.join("\n  - ")}`);
  return { genres, aliases };
}

export async function readTaxonomyFile(file = DEFAULT_TAXONOMY_FILE): Promise<DesiredTaxonomy> {
  return desiredFromFile(JSON.parse(await readFile(file, "utf8")));
}

// --- Operaciones ----------------------------------------------------------

export type TaxonomyOperation =
  | { op: "create_genre"; slug: string; name: string; level: GenreLevel; parentSlug: string | null; description: string | null }
  | { op: "rename_genre"; slug: string; name: string }
  | { op: "reparent_genre"; slug: string; parentSlug: string }
  | { op: "set_alias"; alias: string; target: string; notes: string | null }
  | { op: "remove_alias"; alias: string }
  | { op: "deactivate_genre"; slug: string; replacementSlug: string };

interface CurrentGenre { id: number; slug: string; name: string; level: string; parentSlug: string | null; active: boolean }
interface CurrentAlias { alias: string; target: string }

async function currentState(client: PoolClient): Promise<{ genres: Map<string, CurrentGenre>; aliases: Map<string, CurrentAlias> }> {
  const genres = await client.query<{ id: string; slug: string; name: string; level: string; parent_slug: string | null; active: boolean }>(`
    SELECT g.id::text, g.slug, g.name, g.level, p.slug AS parent_slug, g.active
      FROM ingest.genres g LEFT JOIN ingest.genres p ON p.id = g.parent_genre_id ORDER BY g.id`);
  const aliases = await client.query<{ alias_normalized: string; target: string }>(`
    SELECT a.alias_normalized, COALESCE(g.slug, 'not_a_genre') AS target
      FROM ingest.genre_aliases a LEFT JOIN ingest.genres g ON g.id = a.genre_id`);
  return {
    genres: new Map(genres.rows.map((row) => [row.slug, { id: Number(row.id), slug: row.slug, name: row.name, level: row.level, parentSlug: row.parent_slug, active: row.active }])),
    aliases: new Map(aliases.rows.map((row) => [row.alias_normalized, { alias: row.alias_normalized, target: row.target }])),
  };
}

/** Diferencia entre el archivo aprobado y la base. Sin `prune`, no quita alias que el archivo no nombre. */
export async function planFromDesired(client: PoolClient, desired: DesiredTaxonomy, options: { prune?: boolean } = {}): Promise<TaxonomyOperation[]> {
  const current = await currentState(client);
  const ops: TaxonomyOperation[] = [];
  // Los padres se crean antes que los hijos: familias, géneros, subgéneros.
  const depth = (level: GenreLevel) => (level === "family" ? 0 : level === "genre" ? 1 : 2);
  const ordered = [...desired.genres].sort((a, b) => depth(a.level) - depth(b.level));
  for (const genre of ordered) {
    const existing = current.genres.get(genre.slug);
    if (!existing) {
      ops.push({ op: "create_genre", slug: genre.slug, name: genre.name, level: genre.level, parentSlug: genre.parentSlug, description: genre.description });
      continue;
    }
    if (existing.level !== genre.level) throw new Error(`${genre.slug}: el archivo lo declara ${genre.level} y en la base es ${existing.level}`);
    if (existing.name !== genre.name) ops.push({ op: "rename_genre", slug: genre.slug, name: genre.name });
    if (genre.parentSlug && existing.parentSlug !== genre.parentSlug) ops.push({ op: "reparent_genre", slug: genre.slug, parentSlug: genre.parentSlug });
  }
  for (const [alias, item] of [...desired.aliases].sort(([a], [b]) => a.localeCompare(b))) {
    if (current.aliases.get(alias)?.target !== item.target) ops.push({ op: "set_alias", alias, target: item.target, notes: item.notes });
  }
  if (options.prune) {
    for (const alias of [...current.aliases.keys()].sort()) if (!desired.aliases.has(alias)) ops.push({ op: "remove_alias", alias });
  }
  return ops;
}

export interface ChangeContext { actor: string; reason: string; runId?: number }

interface Touched { aliasKeys: Set<string>; genreIds: Set<number>; deactivated: Array<{ genreId: number; replacementId: number }> }

async function genreBySlug(client: PoolClient, slug: string): Promise<{ id: number; level: string; active: boolean; name: string; parentId: number | null } | undefined> {
  const { rows } = await client.query<{ id: string; level: string; active: boolean; name: string; parent_genre_id: string | null }>(
    "SELECT id::text, level, active, name, parent_genre_id::text FROM ingest.genres WHERE slug = $1", [slug]);
  const row = rows[0];
  return row ? { id: Number(row.id), level: row.level, active: row.active, name: row.name, parentId: row.parent_genre_id === null ? null : Number(row.parent_genre_id) } : undefined;
}

async function logChange(client: PoolClient, ctx: ChangeContext, change: { kind: string; targetKind: "genre" | "alias"; key: string; before: unknown; after: unknown }): Promise<void> {
  await client.query(`
    INSERT INTO ingest.genre_taxonomy_changes(change_kind, target_kind, target_key, before, after, actor, reason, run_id)
    VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8)`, [
    change.kind, change.targetKind, change.key,
    change.before === undefined ? null : JSON.stringify(change.before), change.after === undefined ? null : JSON.stringify(change.after),
    ctx.actor, ctx.reason, ctx.runId ?? null,
  ]);
}

async function applyOperation(client: PoolClient, op: TaxonomyOperation, ctx: ChangeContext, touched: Touched): Promise<void> {
  switch (op.op) {
    case "create_genre": {
      const parent = op.parentSlug ? await genreBySlug(client, op.parentSlug) : undefined;
      if (op.parentSlug && !parent) throw new Error(`${op.slug}: padre ${op.parentSlug} inexistente`);
      const expected = op.level === "genre" ? "family" : op.level === "subgenre" ? "genre" : null;
      if (parent && parent.level !== expected) throw new Error(`${op.slug} (${op.level}): su padre ${op.parentSlug} es ${parent.level}, debe ser ${expected}`);
      await client.query(`
        INSERT INTO ingest.genres(slug, name, level, parent_genre_id, description, created_by, change_reason)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [op.slug, op.name, op.level, parent?.id ?? null, op.description, ctx.actor, ctx.reason]);
      await logChange(client, ctx, { kind: op.op, targetKind: "genre", key: op.slug, before: null, after: op });
      return;
    }
    case "rename_genre": {
      // El slug no cambia nunca: filtros y estaciones siguen funcionando.
      const genre = await genreBySlug(client, op.slug);
      if (!genre) throw new Error(`género ${op.slug} inexistente`);
      await client.query("UPDATE ingest.genres SET name=$2, updated_by=$3, updated_at=now(), change_reason=$4 WHERE id=$1",
        [genre.id, op.name, ctx.actor, ctx.reason]);
      touched.genreIds.add(genre.id);
      await logChange(client, ctx, { kind: op.op, targetKind: "genre", key: op.slug, before: { name: genre.name }, after: { name: op.name } });
      return;
    }
    case "reparent_genre": {
      const genre = await genreBySlug(client, op.slug);
      const parent = await genreBySlug(client, op.parentSlug);
      if (!genre || !parent) throw new Error(`reparent ${op.slug} → ${op.parentSlug}: género o padre inexistente`);
      const expected = genre.level === "genre" ? "family" : genre.level === "subgenre" ? "genre" : null;
      if (parent.level !== expected) throw new Error(`reparent ${op.slug} (${genre.level}) → ${op.parentSlug}: el padre debe ser ${expected ?? "ninguno"}`);
      await client.query("UPDATE ingest.genres SET parent_genre_id=$2, updated_by=$3, updated_at=now(), change_reason=$4 WHERE id=$1",
        [genre.id, parent.id, ctx.actor, ctx.reason]);
      touched.genreIds.add(genre.id);
      if (genre.parentId !== null) touched.genreIds.add(genre.parentId);
      touched.genreIds.add(parent.id);
      await logChange(client, ctx, { kind: op.op, targetKind: "genre", key: op.slug, before: { parentId: genre.parentId }, after: { parentSlug: op.parentSlug } });
      return;
    }
    case "set_alias": {
      const alias = normalizeGenreText(op.alias);
      if (!alias) throw new Error(`alias vacío: «${op.alias}»`);
      const target = op.target === "not_a_genre" ? undefined : await genreBySlug(client, op.target);
      if (op.target !== "not_a_genre" && !target) throw new Error(`alias ${alias}: género ${op.target} inexistente`);
      if (target && !target.active) throw new Error(`alias ${alias}: el género ${op.target} está inactivo`);
      const before = (await client.query<{ kind: string; genre_id: string | null }>(
        "SELECT kind, genre_id::text FROM ingest.genre_aliases WHERE alias_normalized=$1", [alias])).rows[0];
      await client.query(`
        INSERT INTO ingest.genre_aliases(alias_normalized, kind, genre_id, notes, created_by, change_reason)
        VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT (alias_normalized) DO UPDATE
          SET kind=EXCLUDED.kind, genre_id=EXCLUDED.genre_id, notes=EXCLUDED.notes,
              updated_by=$5, updated_at=now(), change_reason=$6`,
      [alias, target ? "genre" : "not_a_genre", target?.id ?? null, op.notes, ctx.actor, ctx.reason]);
      touched.aliasKeys.add(alias);
      await logChange(client, ctx, { kind: before ? "update_alias" : "create_alias", targetKind: "alias", key: alias, before: before ?? null, after: { target: op.target } });
      return;
    }
    case "remove_alias": {
      const alias = normalizeGenreText(op.alias);
      const removed = await client.query<{ kind: string; genre_id: string | null }>(
        "DELETE FROM ingest.genre_aliases WHERE alias_normalized=$1 RETURNING kind, genre_id::text", [alias]);
      if (!removed.rows[0]) throw new Error(`alias «${alias}» inexistente`);
      touched.aliasKeys.add(alias);
      await logChange(client, ctx, { kind: op.op, targetKind: "alias", key: alias, before: removed.rows[0], after: null });
      return;
    }
    case "deactivate_genre": {
      const genre = await genreBySlug(client, op.slug);
      const replacement = await genreBySlug(client, op.replacementSlug);
      if (!genre || !replacement) throw new Error(`desactivar ${op.slug} → ${op.replacementSlug}: género inexistente`);
      if (!replacement.active || replacement.id === genre.id) throw new Error(`el reemplazo ${op.replacementSlug} debe ser otro género activo`);
      if (genre.level !== "subgenre") {
        const children = await client.query("SELECT 1 FROM ingest.genres WHERE parent_genre_id=$1 AND active LIMIT 1", [genre.id]);
        if (children.rowCount) throw new Error(`${op.slug} tiene hijos activos: desactívalos o muévelos antes`);
      }
      await client.query(`
        UPDATE ingest.genres SET active=false, replaced_by_genre_id=$2, updated_by=$3, updated_at=now(), change_reason=$4 WHERE id=$1`,
      [genre.id, replacement.id, ctx.actor, ctx.reason]);
      touched.genreIds.add(genre.id);
      touched.deactivated.push({ genreId: genre.id, replacementId: replacement.id });
      await logChange(client, ctx, { kind: op.op, targetKind: "genre", key: op.slug, before: { active: true }, after: { active: false, replacement: op.replacementSlug } });
      return;
    }
  }
}

// --- Entidades afectadas y reporte ----------------------------------------

export interface EntityGenreSnapshot {
  rows: Array<{ genre: string; role: string; status: string; decisionKind: string }>;
  albumGenre?: string | null;
}

async function snapshotEntities(client: PoolClient, kind: GenreEntityKind, ids: number[]): Promise<Map<number, EntityGenreSnapshot>> {
  const out = new Map<number, EntityGenreSnapshot>(ids.map((id) => [id, { rows: [] }]));
  if (!ids.length) return out;
  const column = GENRE_COLUMN[kind];
  const { rows } = await client.query<{ entity_id: string; slug: string; role: string; status: string; decision_kind: string }>(`
    SELECT x.${column}::text AS entity_id, g.slug, x.role, x.status, x.decision_kind
      FROM ${GENRE_TABLE[kind]} x JOIN ingest.genres g ON g.id = x.genre_id
     WHERE x.${column} = ANY($1::bigint[]) ORDER BY x.${column}, g.slug`, [ids]);
  for (const row of rows) out.get(Number(row.entity_id))!.rows.push({ genre: row.slug, role: row.role, status: row.status, decisionKind: row.decision_kind });
  if (kind === "album") {
    const albums = await client.query<{ id: string; genre: string | null }>("SELECT id::text, genre FROM public.albums WHERE id = ANY($1::bigint[])", [ids]);
    for (const album of albums.rows) out.get(Number(album.id))!.albumGenre = album.genre;
  }
  return out;
}

/** Entidades cuya evidencia depende de lo tocado: solo ellas se recalculan. */
async function affectedEntities(client: PoolClient, kind: GenreEntityKind, touched: Touched): Promise<number[]> {
  const ids = new Set<number>();
  if (touched.aliasKeys.size) {
    for (const [entityId, claims] of await loadGenreClaims(client, kind)) {
      if (claims.some((claim) => [...candidateAliasKeys(claim.rawValue)].some((key) => touched.aliasKeys.has(key)))) ids.add(entityId);
    }
  }
  if (touched.genreIds.size) {
    const column = GENRE_COLUMN[kind];
    const { rows } = await client.query<{ id: string }>(
      `SELECT DISTINCT ${column}::text AS id FROM ${GENRE_TABLE[kind]} WHERE genre_id = ANY($1::bigint[])`, [[...touched.genreIds]]);
    for (const row of rows) ids.add(Number(row.id));
  }
  return [...ids].sort((a, b) => a - b);
}

/**
 * Avisos informativos sobre decisiones humanas que un cambio de taxonomía deja
 * sin sustento. Van con `origin = genres-taxonomy`: el recálculo no los cierra.
 */
async function humanNotices(client: PoolClient, kind: GenreEntityKind, ids: number[], touched: Touched, ctx: ChangeContext): Promise<number> {
  if (!ids.length) return 0;
  const taxonomy = await loadTaxonomy(client);
  const assignments = await loadAssignments(client, kind, ids);
  const reviewColumn = kind === "album" ? "album_id" : "artist_a_id";
  let opened = 0;
  for (const [entityId, rows] of assignments) {
    for (const row of rows.filter((item) => item.decisionKind === "human")) {
      const deactivated = touched.deactivated.find((item) => item.genreId === row.genreId);
      let detail: Record<string, unknown> | undefined;
      if (deactivated) {
        detail = { kind: "genre_deactivated", genreId: row.genreId, proposedReplacementId: deactivated.replacementId };
      } else if (row.rawValue && touched.aliasKeys.size && [...candidateAliasKeys(row.rawValue)].some((key) => touched.aliasKeys.has(key))) {
        const resolved = resolveGenreValue(taxonomy, row.rawValue).items.some((item) => item.kind === "genre" && item.genreId === row.genreId);
        if (!resolved) detail = { kind: "alias_no_longer_resolves", genreId: row.genreId, rawValue: row.rawValue };
      }
      if (!detail) continue;
      await client.query(`
        INSERT INTO ingest.review_queue(kind, priority, ${reviewColumn}, payload, notes)
        VALUES($1::ingest.review_kind, 3, $2, $3::jsonb, $4)`, [
        GENRE_REVIEW_KIND, entityId,
        JSON.stringify({ origin: "genres-taxonomy", entityKind: kind, entityId, genreCase: "human_contradiction", humanAssignmentId: row.id, decidedBy: row.decidedBy, ...detail, runId: ctx.runId ?? null }),
        `género: la taxonomía cambió bajo una decisión de ${row.decidedBy ?? "una persona"} (${ctx.reason})`,
      ]);
      opened += 1;
    }
  }
  return opened;
}

export interface TaxonomyChangeReport {
  mode: "dry-run" | "confirm";
  runId: number;
  operations: TaxonomyOperation[];
  affected: Record<GenreEntityKind, number>;
  humanNotices: number;
  changes: Array<{ kind: GenreEntityKind; entityId: number; before: EntityGenreSnapshot; after: EntityGenreSnapshot }>;
}

/** Aplica operaciones de taxonomía y recalcula lo afectado, con reporte antes/después. */
export async function applyTaxonomyOperations(
  operations: TaxonomyOperation[], ctx: Omit<ChangeContext, "runId">, options: { confirm: boolean },
): Promise<TaxonomyChangeReport> {
  if (!ctx.actor.trim() || !ctx.reason.trim()) throw new Error("--by y --reason son obligatorios en todo cambio de taxonomía");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await lockGenres(client);
    const run = await client.query<{ id: string }>(`
      INSERT INTO ingest.scrape_runs(kind, status, params) VALUES('merge_run','running',$1::jsonb) RETURNING id::text`,
    [JSON.stringify({ action: "genres_taxonomy", actor: ctx.actor, reason: ctx.reason, confirm: options.confirm, operations: operations.length })]);
    const runId = Number(run.rows[0]!.id);
    const context: ChangeContext = { ...ctx, runId };
    const touched: Touched = { aliasKeys: new Set(), genreIds: new Set(), deactivated: [] };

    // Lo afectado por alias se mide antes y después: quitar un alias afecta a
    // quien lo usaba, añadirlo a quien lo empieza a usar; ambos por su texto.
    const plannedAliasKeys = new Set(operations.flatMap((op) => (op.op === "set_alias" || op.op === "remove_alias" ? [normalizeGenreText(op.alias)] : [])));
    const plannedGenres = new Set<number>();
    for (const op of operations) {
      if (op.op === "rename_genre" || op.op === "reparent_genre" || op.op === "deactivate_genre") {
        const genre = await genreBySlug(client, op.slug);
        if (genre) plannedGenres.add(genre.id);
      }
    }
    const preview: Touched = { aliasKeys: plannedAliasKeys, genreIds: plannedGenres, deactivated: [] };
    const affected = {
      artist: await affectedEntities(client, "artist", preview),
      album: await affectedEntities(client, "album", preview),
    };
    const before = { artist: await snapshotEntities(client, "artist", affected.artist), album: await snapshotEntities(client, "album", affected.album) };

    for (const op of operations) await applyOperation(client, op, context, touched);

    const taxonomy = await loadTaxonomy(client);
    for (const kind of ["artist", "album"] as const) {
      for (const entityId of await affectedEntities(client, kind, touched)) if (!affected[kind].includes(entityId)) affected[kind].push(entityId);
      affected[kind].sort((a, b) => a - b);
    }
    const notices = (await humanNotices(client, "artist", affected.artist, touched, context))
      + (await humanNotices(client, "album", affected.album, touched, context));
    for (const kind of ["artist", "album"] as const) {
      for (const entityId of affected[kind]) await recomputeEntityGenres(client, taxonomy, kind, entityId, { runId });
    }
    const after = { artist: await snapshotEntities(client, "artist", affected.artist), album: await snapshotEntities(client, "album", affected.album) };
    const changes: TaxonomyChangeReport["changes"] = [];
    for (const kind of ["artist", "album"] as const) {
      for (const entityId of affected[kind]) {
        const b = before[kind].get(entityId) ?? { rows: [] };
        const a = after[kind].get(entityId) ?? { rows: [] };
        if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ kind, entityId, before: b, after: a });
      }
    }
    await client.query("UPDATE ingest.scrape_runs SET status='ok', finished_at=now(), counters=$2::jsonb WHERE id=$1",
      [runId, JSON.stringify({ operations: operations.length, affectedArtists: affected.artist.length, affectedAlbums: affected.album.length, changes: changes.length })]);
    await client.query(options.confirm ? "COMMIT" : "ROLLBACK");
    return {
      mode: options.confirm ? "confirm" : "dry-run", runId, operations,
      affected: { artist: affected.artist.length, album: affected.album.length }, humanNotices: notices, changes,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Plan de la carga del archivo aprobado, sin escribir nada. */
export async function planTaxonomyFile(file = DEFAULT_TAXONOMY_FILE, options: { prune?: boolean } = {}): Promise<TaxonomyOperation[]> {
  const desired = await readTaxonomyFile(file);
  const client = await getPool().connect();
  try {
    return await planFromDesired(client, desired, options);
  } finally {
    client.release();
  }
}
