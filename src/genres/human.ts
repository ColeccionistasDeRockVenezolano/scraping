// CRV · Decisiones humanas sobre géneros (PLAN_GENEROS §4 «Prioridad de las
// decisiones humanas»).
//
// Una fila `human` solo la cambia otra decisión humana o su reversión. Estas
// funciones son el único camino para crearlas; el CLI las usa hoy y la Mesa
// de Cotejo las usará en la etapa 3, solo con sesión de administrador de herra.
// Cada decisión queda en `genre_assignment_log` con antes/después, actor y
// motivo; revertir devuelve la entidad al resultado de las reglas con los
// datos actuales, no a una foto antigua.
import type { PoolClient } from "pg";
import type { GenreEntityKind } from "./rules.js";
import { GENRE_COLUMN, GENRE_TABLE, loadTaxonomy, recomputeEntityGenres, type RecomputeResult } from "./store.js";
import { isFamilyOf } from "./taxonomy.js";

export interface HumanDecisionInput {
  kind: GenreEntityKind;
  entityId: number;
  genreSlug: string;
  actor: string;
  reason: string;
  runId?: number;
}

async function genreId(client: PoolClient, slug: string, requireActive: boolean): Promise<number> {
  const { rows } = await client.query<{ id: string; active: boolean }>("SELECT id::text, active FROM ingest.genres WHERE slug=$1", [slug]);
  if (!rows[0]) throw new Error(`género ${slug} inexistente`);
  if (requireActive && !rows[0].active) throw new Error(`el género ${slug} está inactivo`);
  return Number(rows[0].id);
}

async function entityExists(client: PoolClient, kind: GenreEntityKind, id: number): Promise<void> {
  const table = kind === "album" ? "public.albums" : "public.artists";
  const found = await client.query(`SELECT 1 FROM ${table} WHERE id=$1 FOR UPDATE`, [id]);
  if (!found.rowCount) throw new Error(`${kind} ${id} inexistente`);
}

function validate(input: HumanDecisionInput): void {
  if (!input.actor.trim() || !input.reason.trim()) throw new Error("una decisión humana exige actor y motivo");
}

async function rowFor(client: PoolClient, kind: GenreEntityKind, entityId: number, genre: number): Promise<Record<string, unknown> | undefined> {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT * FROM ${GENRE_TABLE[kind]} WHERE ${GENRE_COLUMN[kind]}=$1 AND genre_id=$2 FOR UPDATE`, [entityId, genre]);
  return rows[0];
}

async function log(client: PoolClient, input: HumanDecisionInput, genre: number, action: string, before: unknown, after: unknown): Promise<void> {
  await client.query(`
    INSERT INTO ingest.genre_assignment_log(entity_kind, entity_id, genre_id, action, before, after, actor, reason, run_id)
    VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9)`, [
    input.kind, input.entityId, genre, action, before === undefined ? null : JSON.stringify(before),
    after === undefined ? null : JSON.stringify(after), input.actor, input.reason, input.runId ?? null,
  ]);
}

/** Fija una fila humana (upsert por entidad+género). */
async function upsertHuman(
  client: PoolClient, input: HumanDecisionInput, genre: number, values: { role: "primary" | "secondary"; status: "confirmed" | "rejected" },
): Promise<Record<string, unknown>> {
  const table = GENRE_TABLE[input.kind];
  const column = GENRE_COLUMN[input.kind];
  const before = await rowFor(client, input.kind, input.entityId, genre);
  const saved = await client.query<Record<string, unknown>>(`
    INSERT INTO ${table}(${column}, genre_id, role, status, confidence, source_kind, source_id, claim_ids, raw_value, evidence,
                         decided_by, decided_at, decision_rule, decision_kind, decision_note)
    VALUES($1,$2,$3,$4,'high','editorial',NULL,'{}',NULL,'[]'::jsonb,$5,now(),'human_decision','human',$6)
    ON CONFLICT (${column}, genre_id) DO UPDATE
      SET role=EXCLUDED.role, status=EXCLUDED.status, confidence='high', decided_by=EXCLUDED.decided_by, decided_at=now(),
          decision_rule='human_decision', decision_kind='human', decision_note=EXCLUDED.decision_note,
          superseded_by_id=NULL, updated_at=now()
    RETURNING *`, [input.entityId, genre, values.role, values.status, input.actor, input.reason]);
  const after = saved.rows[0]!;
  await log(client, input, genre, values.status === "rejected" ? "reject" : values.role === "primary" ? "confirm_primary" : "confirm_secondary", before ?? null, after);
  return after;
}

/**
 * Confirma un género (principal o secundario). Un principal anterior pasa a
 * secundario; si se confirma un hijo, la familia de la entidad queda
 * `superseded` por él. Confirmar una familia con un hijo vigente se niega:
 * sería perder precisión que alguien ya tiene.
 */
export async function confirmGenre(
  client: PoolClient, input: HumanDecisionInput & { role: "primary" | "secondary" },
): Promise<RecomputeResult> {
  validate(input);
  await entityExists(client, input.kind, input.entityId);
  const taxonomy = await loadTaxonomy(client);
  const genre = await genreId(client, input.genreSlug, true);
  const table = GENRE_TABLE[input.kind];
  const column = GENRE_COLUMN[input.kind];
  const live = (await client.query<{ id: string; genre_id: string; decision_kind: string }>(
    `SELECT id::text, genre_id::text, decision_kind FROM ${table} WHERE ${column}=$1 AND status IN ('confirmed','suggested') AND genre_id<>$2`,
    [input.entityId, genre])).rows;
  const child = live.find((row) => isFamilyOf(taxonomy, genre, Number(row.genre_id)));
  if (child) throw new Error(`${input.genreSlug} es la familia de un género ya asignado: confirma o rechaza el hijo`);
  if (input.role === "primary") {
    const previous = (await client.query<Record<string, unknown>>(
      `UPDATE ${table} SET role='secondary', updated_at=now() WHERE ${column}=$1 AND role='primary' AND status='confirmed' AND genre_id<>$2 RETURNING *`,
      [input.entityId, genre])).rows;
    for (const row of previous) {
      if (row["decision_kind"] === "human") await log(client, input, Number(row["genre_id"]), "demote_primary", { ...row, role: "primary" }, row);
    }
  }
  const saved = await upsertHuman(client, input, genre, { role: input.role, status: "confirmed" });
  const families = live.filter((row) => isFamilyOf(taxonomy, Number(row.genre_id), genre));
  for (const family of families) {
    await client.query(`UPDATE ${table} SET status='superseded', role='secondary', superseded_by_id=$2, updated_at=now() WHERE id=$1`,
      [Number(family.id), Number(saved["id"])]);
  }
  return recomputeEntityGenres(client, taxonomy, input.kind, input.entityId, { runId: input.runId });
}

/** Rechaza un género: la fila queda `rejected` (humana) y ninguna regla la reabre. */
export async function rejectGenre(client: PoolClient, input: HumanDecisionInput): Promise<RecomputeResult> {
  validate(input);
  await entityExists(client, input.kind, input.entityId);
  const genre = await genreId(client, input.genreSlug, false);
  const table = GENRE_TABLE[input.kind];
  // Lo que este género desplazaba vuelve a estar vigente.
  const saved = await upsertHuman(client, input, genre, { role: "secondary", status: "rejected" });
  await client.query(`UPDATE ${table} SET status='confirmed', superseded_by_id=NULL, updated_at=now() WHERE superseded_by_id=$1`, [Number(saved["id"])]);
  return recomputeEntityGenres(client, await loadTaxonomy(client), input.kind, input.entityId, { runId: input.runId });
}

/**
 * Deshace la decisión humana sobre un género: la fila humana desaparece (queda
 * en el historial) y la entidad vuelve a lo que digan las reglas hoy.
 */
export async function revertGenreDecision(client: PoolClient, input: HumanDecisionInput): Promise<RecomputeResult> {
  validate(input);
  await entityExists(client, input.kind, input.entityId);
  const genre = await genreId(client, input.genreSlug, false);
  const table = GENRE_TABLE[input.kind];
  const before = await rowFor(client, input.kind, input.entityId, genre);
  if (!before || before["decision_kind"] !== "human") throw new Error(`no hay decisión humana sobre ${input.genreSlug} en ${input.kind} ${input.entityId}`);
  await client.query(`UPDATE ${table} SET status='confirmed', superseded_by_id=NULL, updated_at=now() WHERE superseded_by_id=$1`, [Number(before["id"])]);
  await client.query(`DELETE FROM ${table} WHERE id=$1`, [Number(before["id"])]);
  await log(client, input, genre, "revert", before, null);
  return recomputeEntityGenres(client, await loadTaxonomy(client), input.kind, input.entityId, { runId: input.runId });
}

/** Origen de los casos que abre una persona (no los recalcula ni los cierra ninguna regla). */
export const EDITORIAL_REVIEW_ORIGIN = "genres-editorial";

export interface EntityNoteInput {
  kind: GenreEntityKind;
  entityId: number;
  actor: string;
  reason: string;
  runId?: number;
}

async function noteOnly(client: PoolClient, input: EntityNoteInput, action: string, after: Record<string, unknown>): Promise<void> {
  if (!input.actor.trim() || !input.reason.trim()) throw new Error("una decisión humana exige actor y motivo");
  await entityExists(client, input.kind, input.entityId);
  await client.query(`
    INSERT INTO ingest.genre_assignment_log(entity_kind, entity_id, genre_id, action, before, after, actor, reason, run_id)
    VALUES($1,$2,NULL,$3,NULL,$4::jsonb,$5,$6,$7)`,
  [input.kind, input.entityId, action, JSON.stringify(after), input.actor, input.reason, input.runId ?? null]);
}

/**
 * «Evidencia insuficiente»: la persona miró la ficha y no hay con qué
 * clasificarla. No crea ni borra asignaciones; `Sin clasificar` sigue siendo
 * la respuesta correcta y la ficha deja la cola hasta que alguien la reabra.
 */
export async function markInsufficientEvidence(client: PoolClient, input: EntityNoteInput): Promise<void> {
  await noteOnly(client, input, "insufficient_evidence", { status: "insufficient_evidence" });
}

/** Deshace «evidencia insuficiente»: la ficha vuelve a la cola. */
export async function reopenEntity(client: PoolClient, input: EntityNoteInput): Promise<void> {
  const last = await client.query<{ action: string }>(`
    SELECT action FROM ingest.genre_assignment_log
     WHERE entity_kind=$1 AND entity_id=$2 AND action IN ('insufficient_evidence','reopen') ORDER BY id DESC LIMIT 1`,
  [input.kind, input.entityId]);
  if (last.rows[0]?.action !== "insufficient_evidence") throw new Error(`${input.kind} ${input.entityId} no está marcado con evidencia insuficiente`);
  await noteOnly(client, input, "reopen", { status: "reopened" });
}

/**
 * Solicitud de un término nuevo. La taxonomía solo cambia por CLI y con
 * aprobación (PLAN §4 «Cambios en la taxonomía»): aquí se deja el caso en la
 * cola para quien la administra, con el texto de la fuente que lo motivó.
 */
export async function requestNewTerm(
  client: PoolClient, input: EntityNoteInput & { proposedName: string; familySlug?: string | undefined; rawValue?: string | undefined },
): Promise<number> {
  const proposedName = input.proposedName.trim().slice(0, 100);
  if (!proposedName) throw new Error("falta el nombre del término propuesto");
  if (input.familySlug) {
    const family = await client.query("SELECT 1 FROM ingest.genres WHERE slug=$1 AND level='family'", [input.familySlug]);
    if (!family.rowCount) throw new Error(`familia ${input.familySlug} inexistente`);
  }
  const detail = { proposedName, familySlug: input.familySlug ?? null, rawValue: input.rawValue ?? null };
  await noteOnly(client, input, "request_new_term", detail);
  const column = input.kind === "album" ? "album_id" : "artist_a_id";
  const inserted = await client.query<{ id: string }>(`
    INSERT INTO ingest.review_queue(kind, priority, ${column}, payload, notes)
    VALUES('genre_unknown', 5, $1, $2::jsonb, $3) RETURNING id::text`, [
    input.entityId,
    JSON.stringify({
      origin: EDITORIAL_REVIEW_ORIGIN, entityKind: input.kind, entityId: input.entityId, genreCase: "new_term",
      fingerprint: `new_term:${proposedName.toLowerCase()}`, requestedBy: input.actor, reason: input.reason, ...detail,
    }),
    `género: término nuevo propuesto «${proposedName}»`,
  ]);
  return Number(inserted.rows[0]!.id);
}
