// Fusión auditada de entidades duplicadas del core.
//
// El ER conserva las tildes en su clave primaria a propósito: "Pacífica" y
// "Pacifica" solo comparten la clave secundaria y nunca se unen solos. Cuando
// esa variación ya produjo dos filas en el core, este módulo las fusiona.
//
// Cinco reglas que conviene ver explicadas:
//
//  * NADA SE BORRA ANTES DE REAPUNTAR. `claims` y `merge_audit` cuelgan de las
//    entidades con ON DELETE CASCADE: borrar el duplicado sin mover antes sus
//    referencias borraría también su rastro. Las FKs se descubren en el
//    catálogo, así que una tabla nueva que apunte al core no queda fuera.
//  * UN CLAIM NUNCA SE BORRA. Si el duplicado afirma lo mismo que la ficha que
//    queda (misma fuente, página, campo y valor), reapuntarlo violaría
//    `claims_dedupe_uk`. En ese caso el gemelo pierde su destino y queda
//    `superseded` con una nota: su evidencia sigue consultable. Antes se
//    borraba en cascada, contra la regla «los claims no se borran» (P3).
//  * LA FUSIÓN SALE EN UNA SOLA TRANSACCIÓN Y SE PUEDE DESHACER. Los 118k
//    intentos fallidos de la base de desarrollo tardaban 4,9–7,5 s por un
//    UPDATE por fila; ahora el caso normal es un UPDATE masivo por referencia
//    y solo las colisiones bajan a fila a fila (P8). La auditoría guarda la
//    clave primaria de cada fila movida (`movedRefs`), las filas descartadas
//    enteras (`discardedRows`) y las revisiones soltadas
//    (`detachedReviews`), que es lo que necesita `undoMergeRun` (P6).
//  * LAS REVISIONES CAREADAS SE SUELTAN SOLAS. Una revisión que comparaba las
//    dos fichas no puede reapuntarse (violaría `review_queue_distinct_*_chk`):
//    se le quita el lado que desaparece, se cierra si seguía abierta y la fila
//    anterior queda en la auditoría. Fusionar un par que el ER careó dejaba de
//    funcionar por esto (P1).
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
export type MergeKind = DuplicateKind | "track" | "person" | "album_credit" | "track_credit" | "artist_membership";

const TABLE: Record<MergeKind, string> = {
  artist: "artists", album: "albums", track: "tracks", person: "persons",
  album_credit: "album_credits", track_credit: "track_credits", artist_membership: "artist_members",
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

/**
 * Columnas que carean dos fichas en `ingest.review_queue`. Reapuntar una
 * revisión que comparaba `keep` contra `drop` dejaría la misma fila en los dos
 * lados y violaría `review_queue_distinct_persons_chk` /
 * `review_queue_distinct_artists_chk` (P1, verificado con 14/3617).
 */
const PAIR_COLUMNS: Partial<Record<MergeKind, readonly [string, string]>> = {
  artist: ["artist_a_id", "artist_b_id"],
  person: ["person_a_id", "person_b_id"],
};

/** Columnas cuyo «vacío» no es NULL sino el DEFAULT del core: «nadie lo dijo». */
const EMPTY_RULES: Readonly<Record<string, { empty: string; present: string }>> = {
  "albums.album_type": { empty: "k.album_type='other'", present: "d.album_type<>'other'" },
  "persons.is_venezuelan": { empty: "k.is_venezuelan=false", present: "d.is_venezuelan=true" },
};
/**
 * Los mismos «vacíos» en valores, para la previsualización de fusión
 * (E11.3/E11.10): así la previsualización no promete completar un campo que el
 * motor considera lleno. Si aquí se añade una regla, hay que añadirla arriba.
 */
export const MERGE_EMPTY_VALUES: Readonly<Record<string, unknown>> = {
  "albums.album_type": "other",
  "persons.is_venezuelan": false,
};

/**
 * Tipos con página propia e identidad fusionable que dejan redirección: el id
 * que desaparece debe llevar a la ficha que quedó (P5). Los créditos y las
 * membresías no son entidades navegables y no redirigen.
 */
const REDIRECT_KINDS = new Set<MergeKind>(["artist", "person", "organization", "album", "track"]);

export interface DuplicateGroup {
  kind: DuplicateKind;
  keepId: number;
  dropIds: number[];
  names: string[];
  artist?: string;
}

export interface SkippedGroup { kind: DuplicateKind; ids: number[]; names: string[]; reason: string; }

export interface DuplicateScan { groups: DuplicateGroup[]; skipped: SkippedGroup[]; }

export interface MovedRef { table: string; column: string; keys: Array<Record<string, unknown>> }

export interface DiscardedRow {
  table: string;
  column: string;
  row: Record<string, unknown>;
  /** superseded: claim sin destino; deleted: copia previa al borrado. */
  policy: "superseded" | "deleted";
}

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

/**
 * FKs reales que apuntan a la entidad, con nombre canónico `esquema.tabla`:
 * el rastro de la fusión debe poder repetirse tal cual al deshacerla.
 */
async function referencingColumns(client: PoolClient, kind: MergeKind): Promise<Array<{ table: string; column: string }>> {
  const { rows } = await client.query<{ table: string; column: string }>(`
    SELECT quote_ident(n.nspname)||'.'||quote_ident(c.relname) AS "table", a.attname AS "column"
      FROM pg_constraint con
      JOIN pg_class c ON c.oid=con.conrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=ANY(con.conkey)
     WHERE con.contype='f' AND con.confrelid=$1::regclass
     ORDER BY 1,2`, [`public.${TABLE[kind]}`]);
  return rows;
}

/** Columnas de la clave primaria, en su orden. */
async function primaryKeyColumns(client: PoolClient, table: string): Promise<string[]> {
  const { rows } = await client.query<{ column: string }>(`
    SELECT a.attname AS column
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
     WHERE i.indrelid=$1::regclass AND i.indisprimary
     ORDER BY array_position(i.indkey::int2[], a.attnum)`, [table]);
  return rows.map((row) => row.column);
}

/** Clave primaria como objeto JSON; `{}` si la tabla no tuviera PK (no debería). */
const keyExpression = (pk: string[]) =>
  pk.length === 0 ? "'{}'::jsonb" : `jsonb_build_object(${pk.map((column) => `'${column}', ${column}`).join(", ")})`;

/** Relanza un error de PostgreSQL con la tabla en el mensaje, sin perder su código. */
function withTable(error: unknown, ref: { table: string; column: string }): unknown {
  const failure = error as Error;
  failure.message = `${ref.table}.${ref.column}: ${failure.message}`;
  return failure;
}

/**
 * Una revisión que careaba las dos fichas pierde el sentido al fusionarlas, y
 * reapuntarla violaría `review_queue_distinct_*_chk`. Se suelta el lado que
 * desaparece, se cierra si seguía abierta y la fila anterior queda en la
 * auditoría para poder deshacer.
 */
async function detachSelfPairs(
  client: PoolClient, kind: MergeKind, keepId: number, dropId: number, runId: number,
): Promise<Array<Record<string, unknown>>> {
  const pair = PAIR_COLUMNS[kind];
  if (!pair) return [];
  const [a, b] = pair;
  const before = (await client.query<Record<string, unknown>>(
    `SELECT * FROM ingest.review_queue WHERE (${a}=$1 AND ${b}=$2) OR (${a}=$2 AND ${b}=$1) FOR UPDATE`,
    [keepId, dropId])).rows;
  if (before.length === 0) return [];
  // El lado que se suelta es `drop`; el otro —`keep`— se conserva tal cual, así
  // que el UPDATE no necesita el id que queda.
  await client.query(`
    UPDATE ingest.review_queue
       SET ${a}=CASE WHEN ${a}=$1 THEN NULL ELSE ${a} END,
           ${b}=CASE WHEN ${b}=$1 THEN NULL ELSE ${b} END,
           status=CASE WHEN status IN ('open','in_progress') THEN 'approved'::ingest.review_status ELSE status END,
           resolved_by=COALESCE(resolved_by,'human'),
           resolved_at=COALESCE(resolved_at,now()),
           resolution_note=concat_ws(' · ', resolution_note, $2::text),
           updated_at=now()
     WHERE id=ANY($3::bigint[])`,
  [dropId, `par ${keepId}/${dropId} fusionado en ${keepId} (run ${runId})`, before.map((row) => row["id"])]);
  return before;
}

/**
 * Política de colisión: la misma relación ya existe en la ficha que queda.
 *
 *  * `ingest.claims`: NUNCA se borra. El gemelo pierde su destino y queda
 *    `superseded` con una nota; su evidencia sobrevive. Si el gemelo tampoco
 *    puede soltarse, se aborta la fusión: un error es preferible a perder
 *    procedencia.
 *  * Cualquier otra fila: se copia entera a la auditoría y se borra, para que
 *    la fusión pueda deshacerse.
 */
async function discardCollision(
  client: PoolClient, kind: MergeKind, ref: { table: string; column: string }, ctid: string,
  keepId: number, dropId: number, runId: number,
): Promise<DiscardedRow> {
  const original = (await client.query<{ row: Record<string, unknown> }>(
    `SELECT to_jsonb(t) AS "row" FROM ${ref.table} t WHERE ctid=$1::tid`, [ctid])).rows[0]?.row ?? {};
  if (ref.table === "ingest.claims") {
    const note = `gemelo de un claim de ${kind} ${keepId} tras fusionar ${dropId} (run ${runId})`;
    try {
      await client.query(`
        UPDATE ingest.claims SET ${ref.column}=NULL, status='superseded', updated_at=now(),
               notes=concat_ws(' · ', notes, $2::text)
         WHERE ctid=$1::tid`, [ctid, note]);
    } catch (error) {
      throw new Error(`no se puede fusionar sin perder evidencia: el claim ${JSON.stringify(original)} no pudo soltarse`, { cause: error });
    }
    return { table: ref.table, column: ref.column, row: original, policy: "superseded" };
  }
  await client.query(`DELETE FROM ${ref.table} WHERE ctid=$1::tid`, [ctid]);
  return { table: ref.table, column: ref.column, row: original, policy: "deleted" };
}

/**
 * Reapunta una columna entera del duplicado a la ficha que queda.
 *
 * Primero un UPDATE masivo: el caso normal (una persona con decenas de
 * créditos y claims) se resuelve en un viaje. Solo si el lote choca con una
 * unicidad se repite fila a fila, con SAVEPOINT por fila y la política de
 * colisión de `discardCollision`. Cualquier otro error se relanza con la tabla
 * en el mensaje.
 */
async function moveReference(
  client: PoolClient, kind: MergeKind, ref: { table: string; column: string }, keepId: number, dropId: number, runId: number,
): Promise<{ moved: MovedRef[]; discarded: DiscardedRow[] }> {
  const keys = keyExpression(await primaryKeyColumns(client, ref.table));
  await client.query("SAVEPOINT move_batch");
  try {
    const bulk = await client.query<{ key: Record<string, unknown> }>(
      `UPDATE ${ref.table} SET ${ref.column}=$1 WHERE ${ref.column}=$2 RETURNING ${keys} AS "key"`, [keepId, dropId]);
    await client.query("RELEASE SAVEPOINT move_batch");
    return bulk.rowCount
      ? { moved: [{ table: ref.table, column: ref.column, keys: bulk.rows.map((row) => row.key) }], discarded: [] }
      : { moved: [], discarded: [] };
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT move_batch");
    if ((error as { code?: string }).code !== "23505") throw withTable(error, ref);
  }
  const rows = (await client.query<{ ctid: string; key: Record<string, unknown> }>(
    `SELECT ctid::text AS ctid, ${keys} AS "key" FROM ${ref.table} WHERE ${ref.column}=$1 ORDER BY ctid`, [dropId])).rows;
  const moved: Array<Record<string, unknown>> = [];
  const discarded: DiscardedRow[] = [];
  for (const row of rows) {
    await client.query("SAVEPOINT move_row");
    try {
      await client.query(`UPDATE ${ref.table} SET ${ref.column}=$1 WHERE ctid=$2::tid`, [keepId, row.ctid]);
      await client.query("RELEASE SAVEPOINT move_row");
      moved.push(row.key);
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT move_row");
      if ((error as { code?: string }).code !== "23505") throw withTable(error, ref);
      discarded.push(await discardCollision(client, kind, ref, row.ctid, keepId, dropId, runId));
    }
  }
  return { moved: moved.length ? [{ table: ref.table, column: ref.column, keys: moved }] : [], discarded };
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

/**
 * Completa en `keep` las columnas vacías con el valor del duplicado: una sola
 * sentencia (antes: un `information_schema` y un UPDATE por columna) y
 * `filled` sale de comparar el antes y el después con RETURNING. Reglas de
 * vacío: `album_type='other'` y `is_venezuelan=false` son el DEFAULT del core
 * —«nadie lo dijo»—, así que un `true` del duplicado se conserva (P9).
 */
async function fillEmptyColumns(client: PoolClient, kind: MergeKind, keepId: number, dropId: number): Promise<string[]> {
  const table = TABLE[kind];
  const { rows: columns } = await client.query<{ column_name: string }>(`
    SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [table]);
  const fillable = columns.map((row) => row.column_name).filter((column) => !NOT_FILLED.has(column));
  if (fillable.length === 0) return [];
  const assignments = fillable.map((column) => {
    const rule = EMPTY_RULES[`${table}.${column}`] ?? { empty: `k.${column} IS NULL`, present: `d.${column} IS NOT NULL` };
    return `${column}=CASE WHEN ${rule.empty} AND ${rule.present} THEN d.${column} ELSE k.${column} END`;
  });
  const updated = await client.query<{ before: Record<string, unknown>; after: Record<string, unknown> }>(`
    WITH before AS (SELECT to_jsonb(x) AS "row" FROM public.${table} x WHERE x.id=$1)
    UPDATE public.${table} k SET ${assignments.join(", ")}
      FROM public.${table} d
     WHERE k.id=$1 AND d.id=$2
    RETURNING to_jsonb(k) AS "after", (SELECT "row" FROM before) AS "before"`, [keepId, dropId]);
  const row = updated.rows[0];
  if (!row) return [];
  return fillable.filter((column) => JSON.stringify(row.before[column] ?? null) !== JSON.stringify(row.after[column] ?? null));
}

export interface MergeOutcome {
  moved: number;
  discarded: number;
  filled: string[];
  tracksMerged: number;
  auditId: number;
  /** Clave primaria de cada fila movida, por tabla y columna. */
  movedRefs: MovedRef[];
  /** Filas que no cabían en `keep`, con su copia entera. */
  discardedRows: DiscardedRow[];
  /** Revisiones que careaban las dos fichas, tal como estaban antes. */
  detachedReviews: Array<Record<string, unknown>>;
}

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

  // Antes de reapuntar nada: la revisión que careaba las dos fichas no admite
  // el reapunte (chk de distintas) y hay que soltarle el lado que desaparece.
  const detachedReviews = await detachSelfPairs(client, kind, keepId, dropId, runId);

  // Evidencia de ambas filas: sus claims y los enlazados a sus auditorías. Los
  // créditos acotados por número ("tracks 01, 03") solo la tienen por auditoría.
  const claimIds = (await client.query<{ id: string }>(`
    SELECT id::text FROM (
      SELECT c.id, c.${kind}_id=$2 AS dropped FROM ingest.claims c WHERE c.${kind}_id=ANY($1::bigint[])
      UNION ALL
      SELECT mac.claim_id, ma.${kind}_id=$2 FROM ingest.merge_audit ma JOIN ingest.merge_audit_claims mac ON mac.merge_audit_id=ma.id
       WHERE ma.${kind}_id=ANY($1::bigint[])
    ) evidence GROUP BY id ORDER BY bool_or(dropped) DESC,id`, [[keepId, dropId], dropId])).rows.map((row) => Number(row.id));

  let moved = 0;
  const movedRefs: MovedRef[] = [];
  const discardedRows: DiscardedRow[] = [];
  for (const ref of await referencingColumns(client, kind)) {
    const outcome = await moveReference(client, kind, ref, keepId, dropId, runId);
    for (const item of outcome.moved) {
      movedRefs.push(item);
      moved += item.keys.length;
    }
    discardedRows.push(...outcome.discarded);
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
  [runId, kind, keepId, JSON.stringify(drop),
    JSON.stringify({ keptId: keepId, filled, moved, discarded: discardedRows.length, tracksMerged,
      movedRefs, discardedRows, detachedReviews, version: 2 }), note]);
  const auditId = Number(auditRow.rows[0]!.id);
  // La evidencia completa, sin el recorte a 50 de antes (P4): hay fichas con
  // más de 150 claims y las fusiones ya llegaban al tope.
  await client.query(
    "INSERT INTO ingest.merge_audit_claims(merge_audit_id,claim_id) SELECT $1, unnest($2::bigint[]) ON CONFLICT DO NOTHING",
    [auditId, claimIds]);
  // El id que desaparece queda redirigido a la ficha viva (P5). Primero se
  // comprime la cadena —quien apuntaba al duplicado pasa a apuntar a la que
  // queda— y después se registra el propio `drop`, con la auditoría y el run
  // como rastro para poder deshacerlo (E11.8).
  if (REDIRECT_KINDS.has(kind)) {
    await client.query(
      "UPDATE ingest.entity_redirects SET to_id=$3 WHERE entity_kind=$1 AND to_id=$2",
      [kind, dropId, keepId]);
    await client.query(`
      INSERT INTO ingest.entity_redirects(entity_kind,from_id,to_id,merge_audit_id,run_id)
      VALUES($1,$2,$3,$4,$5)
      ON CONFLICT (entity_kind,from_id) DO UPDATE
        SET to_id=EXCLUDED.to_id, merge_audit_id=EXCLUDED.merge_audit_id, run_id=EXCLUDED.run_id`,
    [kind, dropId, keepId, auditId, runId]);
  }
  return { moved, discarded: discardedRows.length, filled, tracksMerged, auditId, movedRefs, discardedRows, detachedReviews };
}

export interface DuplicateMergeResult {
  runId: number;
  merged: Array<{ kind: DuplicateKind; keepId: number; dropId: number; names: string[]; moved: number; discarded: number; filled: string[]; tracksMerged: number }>;
  failed: Array<{ kind: DuplicateKind; keepId: number; dropId: number; names: string[]; error: string }>;
  skipped: SkippedGroup[];
}

/** Tope de fallos que caben en el `error_log` del run. No trunca evidencia. */
const MAX_FAILURES_IN_LOG = 50;

/** Fusiona una pareja en su propia transacción. */
export async function mergeDuplicate(kind: DuplicateKind, keepId: number, dropId: number, note: string, runId: number) {
  if (!note.trim()) throw new Error("nota obligatoria para fusionar duplicados");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('merge:duplicates'))");
    // El rastro completo vive en la auditoría; el resultado del lote se queda
    // con los contadores de siempre.
    const {
      auditId: _auditId, movedRefs: _movedRefs, discardedRows: _discardedRows, detachedReviews: _detachedReviews, ...result
    } = await mergeInto(client, kind, keepId, dropId, note, runId);
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
  }, result.failed.length ? JSON.stringify(result.failed.slice(0, MAX_FAILURES_IN_LOG)) : undefined);
  return result;
}
