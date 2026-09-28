// CRV · Géneros en las fusiones de artistas y álbumes (PLAN_GENEROS §4
// «Fusiones de artistas y álbumes»).
//
// La fusión traslada las filas de `drop` a `keep` en su misma transacción, sin
// borrar nada en cascada:
//   - misma pareja entidad–género: una fila con la unión de evidencias; si una
//     es `human` y la otra `rule`, queda la `human`;
//   - dos principales confirmados distintos: gana el `human` si solo uno lo es;
//     si no, el de la entidad que sobrevive. El otro pasa a secundario y el
//     caso va a revisión;
//   - familia en una e hijo en otra: la familia queda `superseded` por el hijo.
// La foto de todas las filas de ambas entidades antes del traslado viaja en la
// auditoría de la fusión: deshacerla las devuelve tal cual estaban.
import type { PoolClient } from "pg";
import type { GenreEntityKind } from "./rules.js";
import { canonicalJson, GENRE_COLUMN, GENRE_REVIEW_KIND, GENRE_TABLE, MERGE_REVIEW_ORIGIN, loadTaxonomy } from "./store.js";
import { isFamilyOf } from "./taxonomy.js";

type Row = Record<string, unknown>;

export interface GenreMergeSnapshot {
  kind: GenreEntityKind;
  keepId: number;
  dropId: number;
  /** Filas de ambas entidades antes del traslado (copia entera). */
  rows: Row[];
  /** Hora de la transacción de la fusión: lo decidido después no se pisa al deshacer. */
  takenAt: string;
}

const REVIEW_COLUMN: Readonly<Record<GenreEntityKind, string>> = { artist: "artist_a_id", album: "album_id" };

/** `true` si las tablas de géneros existen (antes de 0027 la fusión no las toca). */
export async function genreTablesExist(client: PoolClient): Promise<boolean> {
  const { rows } = await client.query<{ present: boolean }>("SELECT to_regclass('ingest.album_genres') IS NOT NULL AS present");
  return rows[0]?.present ?? false;
}

const isHuman = (row: Row) => row["decision_kind"] === "human";
const isLive = (row: Row) => row["status"] === "confirmed" || row["status"] === "suggested";
const isPrimary = (row: Row) => row["role"] === "primary" && row["status"] === "confirmed";

function unionEvidence(a: unknown, b: unknown): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const item of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    const key = canonicalJson(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

const unionIds = (a: unknown, b: unknown): number[] =>
  [...new Set([...(a as Array<string | number> ?? []), ...(b as Array<string | number> ?? [])].map(Number))].sort((x, y) => x - y);

async function openMergeReview(client: PoolClient, kind: GenreEntityKind, keepId: number, detail: Record<string, unknown>): Promise<void> {
  const fingerprint = `merge:${canonicalJson(detail)}`;
  await client.query(`
    INSERT INTO ingest.review_queue(kind, priority, ${REVIEW_COLUMN[kind]}, payload, notes)
    VALUES($1::ingest.review_kind, 4, $2, $3::jsonb, 'género: primary_disagreement (fusión)')`, [
    GENRE_REVIEW_KIND, keepId,
    JSON.stringify({ origin: MERGE_REVIEW_ORIGIN, entityKind: kind, entityId: keepId, genreCase: "primary_disagreement", fingerprint, ...detail }),
  ]);
}

/**
 * Traslada los géneros de `dropId` a `keepId`. Debe llamarse antes de que la
 * fusión reapunte las demás referencias: así el reapunte genérico ya no
 * encuentra filas de género que mover ni descartar.
 */
export async function transferGenreAssignments(
  client: PoolClient, kind: GenreEntityKind, keepId: number, dropId: number,
): Promise<GenreMergeSnapshot | undefined> {
  if (!(await genreTablesExist(client))) return undefined;
  const table = GENRE_TABLE[kind];
  const column = GENRE_COLUMN[kind];
  const all = (await client.query<Row>(
    `SELECT * FROM ${table} WHERE ${column} = ANY($1::bigint[]) ORDER BY id FOR UPDATE`, [[keepId, dropId]])).rows;
  const takenAt = (await client.query<{ at: string }>("SELECT now()::text AS at")).rows[0]!.at;
  // Copia: las filas de trabajo se ajustan en memoria más abajo.
  const snapshot: GenreMergeSnapshot = { kind, keepId, dropId, rows: all.map((row) => ({ ...row })), takenAt };
  const dropRows = all.filter((row) => Number(row[column]) === dropId);
  if (!dropRows.length) return snapshot;
  const keepRows = all.filter((row) => Number(row[column]) === keepId);
  const taxonomy = await loadTaxonomy(client);

  // 1. Principal: uno solo confirmado por entidad.
  const keepPrimary = keepRows.find(isPrimary);
  const dropPrimary = dropRows.find(isPrimary);
  if (keepPrimary && dropPrimary && keepPrimary["genre_id"] !== dropPrimary["genre_id"]) {
    const dropWins = isHuman(dropPrimary) && !isHuman(keepPrimary);
    const loser = dropWins ? keepPrimary : dropPrimary;
    await client.query(`UPDATE ${table} SET role='secondary', updated_at=now() WHERE id=$1`, [loser["id"]]);
    loser["role"] = "secondary";
    const keptGenreId = Number((dropWins ? dropPrimary : keepPrimary)["genre_id"]);
    const demotedGenreId = Number(loser["genre_id"]);
    // Una familia genérica y su subgénero no discrepan: el paso 3 ya deja
    // vigente el término más específico y desplaza la familia.
    if (!isFamilyOf(taxonomy, keptGenreId, demotedGenreId)
      && !isFamilyOf(taxonomy, demotedGenreId, keptGenreId)) {
      await openMergeReview(client, kind, keepId, {
        mergedFrom: dropId, keptPrimaryGenreId: keptGenreId, demotedGenreId,
      });
    }
  }

  // 2. Misma pareja: una fila con la unión de evidencias; `human` gana a `rule`.
  const keepByGenre = new Map(keepRows.map((row) => [Number(row["genre_id"]), row]));
  for (const row of dropRows) {
    const twin = keepByGenre.get(Number(row["genre_id"]));
    if (!twin) {
      await client.query(`UPDATE ${table} SET ${column}=$1, updated_at=now() WHERE id=$2`, [keepId, row["id"]]);
      continue;
    }
    const winner = isHuman(row) && !isHuman(twin) ? row : twin;
    // El principal ya quedó resuelto arriba: si la ganadora lo era y el otro
    // lado ya tiene otro principal, baja a secundario.
    const role = winner["role"] === "primary" && keepRows.some((other) => other !== twin && isPrimary(other)) ? "secondary" : winner["role"];
    await client.query(`UPDATE ${table} SET superseded_by_id=$1 WHERE superseded_by_id=$2`, [twin["id"], row["id"]]);
    await client.query(`DELETE FROM ${table} WHERE id=$1`, [row["id"]]);
    await client.query(`
      UPDATE ${table} SET role=$2, status=$3, confidence=$4, source_kind=$5, source_id=$6, raw_value=$7,
             decided_by=$8, decided_at=$9, decision_rule=$10, decision_kind=$11, decision_note=$12,
             superseded_by_id=$13, claim_ids=$14::bigint[], evidence=$15::jsonb, updated_at=now()
       WHERE id=$1`, [
      twin["id"], role, winner["status"], winner["confidence"], winner["source_kind"], winner["source_id"], winner["raw_value"],
      winner["decided_by"], winner["decided_at"], winner["decision_rule"], winner["decision_kind"], winner["decision_note"],
      winner === twin ? twin["superseded_by_id"] : null,
      unionIds(twin["claim_ids"], row["claim_ids"]), JSON.stringify(unionEvidence(twin["evidence"], row["evidence"])),
    ]);
  }

  // 3. Familia e hijo vigentes a la vez: la familia queda desplazada. Una
  //    familia humana no la desplaza un hijo de reglas: el recálculo lo avisa.
  const merged = (await client.query<Row>(`SELECT * FROM ${table} WHERE ${column}=$1 ORDER BY id`, [keepId])).rows;
  const live = merged.filter(isLive);
  for (const family of live) {
    const child = live.find((other) => other !== family && isFamilyOf(taxonomy, Number(family["genre_id"]), Number(other["genre_id"]))
      && (isHuman(other) || !isHuman(family)));
    if (!child) continue;
    await client.query(
      `UPDATE ${table} SET status='superseded', role='secondary', superseded_by_id=$2, updated_at=now() WHERE id=$1`, [family["id"], child["id"]]);
    if (isPrimary(family) && !merged.some((row) => row !== family && isPrimary(row)) && child["status"] === "confirmed") {
      await client.query(`UPDATE ${table} SET role='primary', updated_at=now() WHERE id=$1`, [child["id"]]);
      child["role"] = "primary";
    }
    family["status"] = "superseded";
    family["role"] = "secondary";
  }
  return snapshot;
}

/**
 * Deshace el traslado: `keep` y `drop` vuelven a tener exactamente las filas
 * de la foto. Las filas `rule` que aparecieron después sobre `keep` se
 * descartan (se recalculan); si una persona decidió algo nuevo sobre `keep`
 * desde la fusión, no se deshace: se aborta para no pisar esa decisión.
 */
export async function restoreGenreAssignments(client: PoolClient, snapshot: GenreMergeSnapshot): Promise<void> {
  if (!(await genreTablesExist(client))) return;
  const table = GENRE_TABLE[snapshot.kind];
  const column = GENRE_COLUMN[snapshot.kind];
  const snapshotIds = snapshot.rows.map((row) => Number(row["id"]));
  const decided = await client.query(`
    SELECT 1 FROM ingest.genre_assignment_log
     WHERE entity_kind=$1 AND entity_id = ANY($2::bigint[]) AND created_at > $3::timestamptz LIMIT 1`,
  [snapshot.kind, [snapshot.keepId, snapshot.dropId], snapshot.takenAt]);
  if (decided.rowCount) {
    throw new Error(`hay decisiones humanas de género posteriores a la fusión sobre ${snapshot.kind} ${snapshot.keepId}; revísalas antes de deshacer`);
  }
  await client.query("SET LOCAL crv.genres_restore = 'on'");
  await client.query(`DELETE FROM ${table} WHERE ${column} = ANY($1::bigint[]) OR id = ANY($2::bigint[])`, [[snapshot.keepId, snapshot.dropId], snapshotIds]);
  for (const row of snapshot.rows) {
    await client.query(
      `INSERT INTO ${table} OVERRIDING SYSTEM VALUE SELECT * FROM jsonb_populate_record(NULL::${table}, $1::jsonb)`, [JSON.stringify(row)]);
  }
  await client.query("SET LOCAL crv.genres_restore = 'off'");
}

/**
 * Borra las filas de una entidad que se retira y devuelve su copia para el
 * historial; cada una queda además en `genre_assignment_log`.
 */
export async function detachGenreAssignments(
  client: PoolClient, kind: GenreEntityKind, entityId: number, context: { reason: string; runId?: number },
): Promise<Row[]> {
  if (!(await genreTablesExist(client))) return [];
  const table = GENRE_TABLE[kind];
  const column = GENRE_COLUMN[kind];
  const rows = (await client.query<Row>(`SELECT * FROM ${table} WHERE ${column}=$1 ORDER BY id FOR UPDATE`, [entityId])).rows;
  if (!rows.length) return rows;
  // `superseded_by_id` es diferible: borrar todas juntas no rompe la FK.
  await client.query(`DELETE FROM ${table} WHERE ${column}=$1`, [entityId]);
  for (const row of rows) {
    await client.query(`
      INSERT INTO ingest.genre_assignment_log(entity_kind, entity_id, genre_id, action, before, after, actor, reason, run_id)
      VALUES($1,$2,$3,'entity_removed',$4::jsonb,NULL,'human',$5,$6)`,
    [kind, entityId, row["genre_id"], JSON.stringify(row), context.reason, context.runId ?? null]);
  }
  return rows;
}
