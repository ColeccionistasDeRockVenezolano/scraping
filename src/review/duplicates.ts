// Fusión auditada de entidades duplicadas del core.
//
// El ER conserva las tildes en su clave primaria a propósito: "Pacífica" y
// "Pacifica" solo comparten la clave secundaria y nunca se unen solos. Cuando
// esa variación ya produjo dos filas en el core, este módulo las fusiona.
//
// Tres reglas que conviene ver explicadas:
//
//  * NADA SE BORRA ANTES DE REAPUNTAR. `claims` y `merge_audit` cuelgan de las
//    entidades con ON DELETE CASCADE: borrar el duplicado sin mover antes sus
//    referencias borraría también su rastro. Las FKs se descubren en el
//    catálogo, así que una tabla nueva que apunte al core no queda fuera.
//  * NO SE ADIVINA. Solo se agrupa por la clave sin tildes/mayúsculas, no por
//    la variante sin artículo ("Los Pixel" y "Pixel" son dos bandas en el
//    canal). Dos discos con el mismo título y años distintos no se tocan
//    (Spiteri 1973 y 1981), ni dos discos cuyas pistas en la misma posición
//    tienen títulos distintos.
//  * EL NOMBRE PERDIDO QUEDA COMO ALIAS, y la fusión deja una fila en
//    merge_audit enlazada a claims, como cualquier otro cambio del core. La
//    excepción la decide una persona: un fragmento como «Car» no es una
//    variante del nombre y no se guarda (`alias: false`).
//
// Personas y créditos no se agrupan solos: su fusión la pide una decisión
// explícita (person-corrections.ts), que reutiliza `mergeInto`.
import type { PoolClient } from "pg";
import { getPool } from "../db/client.js";
import { finishRun } from "../ingest/runs.js";
import { normalizeEntityName } from "../normalization/entity-name.js";

export type DuplicateKind = "artist" | "album";
export type MergeKind = DuplicateKind | "track" | "person" | "album_credit" | "track_credit";

const TABLE: Record<MergeKind, string> = {
  artist: "artists", album: "albums", track: "tracks", person: "persons", album_credit: "album_credits", track_credit: "track_credits",
};
const IDENTITY: Partial<Record<MergeKind, string>> = { artist: "name", album: "title", track: "title", person: "name" };
const ALIAS_TABLE: Partial<Record<MergeKind, string>> = {
  artist: "ingest.artist_aliases", album: "ingest.album_aliases", track: "ingest.track_aliases", person: "ingest.person_aliases",
};
const ALIAS_TYPE: Partial<Record<MergeKind, string>> = { artist: "name_variant", album: "alternate_title", track: "alternate_title", person: "name_variant" };
/**
 * Columnas que no se completan desde el duplicado: identidad, parental,
 * posición y, en los créditos, el acreditado y su rol (completar `artist_id`
 * en un crédito de persona violaría el "un solo destino").
 */
const NOT_FILLED = new Set([
  "id", "name", "title", "artist_id", "album_id", "disc_number", "track_number", "created_at", "updated_at",
  "person_id", "organization_id", "track_id", "credit_type", "role",
]);

export interface DuplicateGroup {
  kind: DuplicateKind;
  keepId: number;
  dropIds: number[];
  names: string[];
  artist?: string;
}

export interface SkippedGroup { kind: DuplicateKind; ids: number[]; names: string[]; reason: string; }

export interface DuplicateScan { groups: DuplicateGroup[]; skipped: SkippedGroup[]; }

function duplicateKey(value: string): string {
  return normalizeEntityName(value).secondaryKey;
}

/** Previsualización pura: qué filas del core parecen la misma entidad. */
export async function findDuplicateGroups(queryable: Pick<PoolClient, "query"> = getPool()): Promise<DuplicateScan> {
  const groups: DuplicateGroup[] = [];
  const skipped: SkippedGroup[] = [];

  const artists = (await queryable.query<{ id: string; name: string }>("SELECT id::text,name FROM public.artists ORDER BY id")).rows;
  const byArtist = new Map<string, typeof artists>();
  for (const artist of artists) {
    const key = duplicateKey(artist.name);
    if (!key) continue;
    byArtist.set(key, [...(byArtist.get(key) ?? []), artist]);
  }
  for (const list of byArtist.values()) {
    if (list.length < 2) continue;
    groups.push({ kind: "artist", keepId: Number(list[0]!.id), dropIds: list.slice(1).map((row) => Number(row.id)), names: list.map((row) => row.name) });
  }

  const albums = (await queryable.query<{ id: string; artist_id: string; title: string; release_year: number | null; artist: string }>(`
    SELECT a.id::text,a.artist_id::text,a.title,a.release_year,ar.name AS artist
      FROM public.albums a JOIN public.artists ar ON ar.id=a.artist_id ORDER BY a.id`)).rows;
  const byAlbum = new Map<string, typeof albums>();
  for (const album of albums) {
    const key = `${album.artist_id}|${duplicateKey(album.title)}`;
    byAlbum.set(key, [...(byAlbum.get(key) ?? []), album]);
  }
  for (const list of byAlbum.values()) {
    if (list.length < 2) continue;
    const years = new Set(list.map((row) => row.release_year).filter((year): year is number => year !== null));
    const names = list.map((row) => `${row.title}${row.release_year ? ` (${row.release_year})` : ""}`);
    if (years.size > 1) {
      skipped.push({ kind: "album", ids: list.map((row) => Number(row.id)), names, reason: `mismo título con años distintos: ${[...years].join(", ")}` });
      continue;
    }
    groups.push({ kind: "album", keepId: Number(list[0]!.id), dropIds: list.slice(1).map((row) => Number(row.id)), names, artist: list[0]!.artist });
  }
  return { groups, skipped };
}

async function referencingColumns(client: PoolClient, kind: MergeKind): Promise<Array<{ table: string; column: string }>> {
  const { rows } = await client.query<{ table: string; column: string }>(`
    SELECT c.conrelid::regclass::text AS table, a.attname AS column
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
     WHERE c.contype='f' AND c.confrelid=$1::regclass
     ORDER BY 1,2`, [`public.${TABLE[kind]}`]);
  return rows;
}

/** Diferencias que impiden fusionar un disco: pistas distintas en la misma posición. */
async function trackCollisions(client: PoolClient, keepId: number, dropId: number): Promise<Array<{ keep: number; drop: number; keepTitle: string; dropTitle: string }>> {
  const { rows } = await client.query<{ keep: string; drop: string; keep_title: string; drop_title: string }>(`
    SELECT k.id::text AS keep,d.id::text AS drop,k.title AS keep_title,d.title AS drop_title
      FROM public.tracks d
      JOIN public.tracks k ON k.album_id=$1 AND k.disc_number=d.disc_number AND k.track_number=d.track_number
     WHERE d.album_id=$2 ORDER BY d.disc_number,d.track_number`, [keepId, dropId]);
  return rows.map((row) => ({ keep: Number(row.keep), drop: Number(row.drop), keepTitle: row.keep_title, dropTitle: row.drop_title }));
}

async function fillEmptyColumns(client: PoolClient, kind: MergeKind, keepId: number, dropId: number): Promise<string[]> {
  const table = TABLE[kind];
  const { rows: columns } = await client.query<{ column_name: string }>(`
    SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [table]);
  const filled: string[] = [];
  for (const { column_name: column } of columns) {
    if (NOT_FILLED.has(column)) continue;
    // album_type es NOT NULL con DEFAULT 'other': 'other' significa "nadie lo dijo".
    const emptyKeep = kind === "album" && column === "album_type" ? `k.${column}='other'` : `k.${column} IS NULL`;
    const presentDrop = kind === "album" && column === "album_type" ? `d.${column}<>'other'` : `d.${column} IS NOT NULL`;
    const updated = await client.query(`
      UPDATE public.${table} k SET ${column}=d.${column} FROM public.${table} d
       WHERE k.id=$1 AND d.id=$2 AND ${emptyKeep} AND ${presentDrop}`, [keepId, dropId]);
    if (updated.rowCount) filled.push(column);
  }
  return filled;
}

export interface MergeOutcome { moved: number; discarded: number; filled: string[]; tracksMerged: number; auditId: number; }

export async function mergeInto(
  client: PoolClient, kind: MergeKind, keepId: number, dropId: number, note: string, runId: number,
  options: { alias?: boolean } = {},
): Promise<MergeOutcome> {
  if (keepId === dropId) throw new Error(`${kind} ${keepId}: no se puede fusionar consigo mismo`);
  const table = TABLE[kind];
  const identity = IDENTITY[kind];
  const aliasTable = ALIAS_TABLE[kind];
  const loaded = await client.query<Record<string, unknown>>(`SELECT * FROM public.${table} WHERE id=ANY($1::bigint[]) FOR UPDATE`, [[keepId, dropId]]);
  const keep = loaded.rows.find((row) => Number(row["id"]) === keepId);
  const drop = loaded.rows.find((row) => Number(row["id"]) === dropId);
  if (!keep || !drop) throw new Error(`${kind} ${keepId}/${dropId}: alguna fila ya no existe`);

  let tracksMerged = 0;
  if (kind === "album") {
    const collisions = await trackCollisions(client, keepId, dropId);
    const different = collisions.filter((item) => duplicateKey(item.keepTitle) !== duplicateKey(item.dropTitle));
    if (different.length) {
      throw new Error(`pistas distintas en la misma posición (${different.slice(0, 3).map((item) => `"${item.keepTitle}" / "${item.dropTitle}"`).join(", ")})`);
    }
    for (const item of collisions) {
      await mergeInto(client, "track", item.keep, item.drop, note, runId);
      tracksMerged += 1;
    }
    // Un álbum admite un solo enlace primario: si el que queda ya lo tiene,
    // el del duplicado pasa a secundario en vez de perderse.
    await client.query(`
      UPDATE media.video_albums SET is_primary_link=false
       WHERE album_id=$1 AND is_primary_link
         AND EXISTS (SELECT 1 FROM media.video_albums WHERE album_id=$2 AND is_primary_link)`, [dropId, keepId]);
  }
  if (aliasTable) await client.query(`UPDATE ${aliasTable} SET is_primary=false WHERE ${kind}_id=$1`, [dropId]);

  // Evidencia de ambas filas: sus claims y los enlazados a sus auditorías. Los
  // créditos acotados por número ("tracks 01, 03") solo la tienen por auditoría.
  const claimIds = (await client.query<{ id: string }>(`
    SELECT id::text FROM (
      SELECT c.id, c.${kind}_id=$2 AS dropped FROM ingest.claims c WHERE c.${kind}_id=ANY($1::bigint[])
      UNION ALL
      SELECT mac.claim_id, ma.${kind}_id=$2 FROM ingest.merge_audit ma JOIN ingest.merge_audit_claims mac ON mac.merge_audit_id=ma.id
       WHERE ma.${kind}_id=ANY($1::bigint[])
    ) evidence GROUP BY id ORDER BY bool_or(dropped) DESC,id`, [[keepId, dropId], dropId])).rows.map((row) => Number(row.id));

  let moved = 0; let discarded = 0;
  for (const ref of await referencingColumns(client, kind)) {
    const { rows } = await client.query<{ ctid: string }>(`SELECT ctid::text FROM ${ref.table} WHERE ${ref.column}=$1`, [dropId]);
    for (const row of rows) {
      await client.query("SAVEPOINT dedupe_row");
      try {
        await client.query(`UPDATE ${ref.table} SET ${ref.column}=$1 WHERE ctid=$2::tid`, [keepId, row.ctid]);
        await client.query("RELEASE SAVEPOINT dedupe_row");
        moved += 1;
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT dedupe_row");
        // Única violada: la misma relación ya existe en la entidad que queda.
        if ((error as { code?: string }).code !== "23505") throw error;
        await client.query(`DELETE FROM ${ref.table} WHERE ctid=$1::tid`, [row.ctid]);
        await client.query("RELEASE SAVEPOINT dedupe_row");
        discarded += 1;
      }
    }
  }

  const filled = await fillEmptyColumns(client, kind, keepId, dropId);
  if (identity && aliasTable && options.alias !== false) {
    const dropName = String(drop[identity]);
    if (dropName !== String(keep[identity])) {
      await client.query(`
        INSERT INTO ${aliasTable}(${kind}_id,alias,alias_type,normalized_alias,is_primary,confidence,notes)
        VALUES($1,$2,$3::ingest.alias_type,$4,false,'high','Nombre de un duplicado fusionado')
        ON CONFLICT DO NOTHING`, [keepId, dropName, ALIAS_TYPE[kind], normalizeEntityName(dropName).primaryKey]);
    }
  }
  await client.query(`DELETE FROM public.${table} WHERE id=$1`, [dropId]);

  const auditRow = await client.query<{ id: string }>(`
    INSERT INTO ingest.merge_audit(run_id,entity_kind,${kind}_id,field,old_value,new_value,reason,confidence,performed_by)
    VALUES($1,$2::ingest.claim_entity_kind,$3,'merged_duplicate',$4::jsonb,$5::jsonb,$6,'high','human') RETURNING id::text`,
  [runId, kind, keepId, JSON.stringify(drop), JSON.stringify({ keptId: keepId, filled, moved, discarded, tracksMerged }), note]);
  for (const claimId of claimIds.slice(0, 50)) {
    await client.query(`INSERT INTO ingest.merge_audit_claims(merge_audit_id,claim_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [Number(auditRow.rows[0]!.id), claimId]);
  }
  return { moved, discarded, filled, tracksMerged, auditId: Number(auditRow.rows[0]!.id) };
}

export interface DuplicateMergeResult {
  runId: number;
  merged: Array<{ kind: DuplicateKind; keepId: number; dropId: number; names: string[]; moved: number; discarded: number; filled: string[]; tracksMerged: number }>;
  failed: Array<{ kind: DuplicateKind; keepId: number; dropId: number; names: string[]; error: string }>;
  skipped: SkippedGroup[];
}

/** Fusiona una pareja en su propia transacción. */
export async function mergeDuplicate(kind: DuplicateKind, keepId: number, dropId: number, note: string, runId: number) {
  if (!note.trim()) throw new Error("nota obligatoria para fusionar duplicados");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('merge:duplicates'))");
    const { auditId: _auditId, ...result } = await mergeInto(client, kind, keepId, dropId, note, runId);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Fusiona primero artistas y después discos: unir dos artistas puede dejar
 * bajo el mismo artista dos copias de un disco que antes no se veían.
 */
export async function mergeAllDuplicates(note: string): Promise<DuplicateMergeResult> {
  if (!note.trim()) throw new Error("nota obligatoria para fusionar duplicados");
  const opened = await getPool().query<{ id: string }>(`
    INSERT INTO ingest.scrape_runs(kind,status,params) VALUES('merge_run','running',$1::jsonb) RETURNING id::text`,
  [JSON.stringify({ action: "merge_duplicates", note })]);
  const runId = Number(opened.rows[0]!.id);
  const result: DuplicateMergeResult = { runId, merged: [], failed: [], skipped: [] };
  for (const kind of ["artist", "album"] as const) {
    const scan = await findDuplicateGroups();
    if (kind === "album") result.skipped = scan.skipped;
    for (const group of scan.groups.filter((item) => item.kind === kind)) {
      for (const dropId of group.dropIds) {
        try {
          const merged = await mergeDuplicate(kind, group.keepId, dropId, note, runId);
          result.merged.push({ kind, keepId: group.keepId, dropId, names: group.names, ...merged });
        } catch (error) {
          result.failed.push({ kind, keepId: group.keepId, dropId, names: group.names, error: (error as Error).message });
        }
      }
    }
  }
  await finishRun(runId, result.failed.length ? "partial" : "ok", {
    merged: result.merged.length, failed: result.failed.length, skipped: result.skipped.length,
  }, result.failed.length ? JSON.stringify(result.failed.slice(0, 50)) : undefined);
  return result;
}
