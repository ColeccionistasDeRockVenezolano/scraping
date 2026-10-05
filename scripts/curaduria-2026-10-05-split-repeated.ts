// CRV · Curaduría 2026-10-05: pistas homónimas fundidas (Sincopa, misma página).
//
// Movimientos clásicos («Allegro», «Gigue»…) o piezas repetidas de una misma
// ficha de Sincopa compartían identidad (artista::disco::título) y la promoción
// las fundió en una sola pista: sus duraciones, números y títulos chocan como
// «valores en disputa» y el disco queda con huecos de numeración.
//
// Regla (la del motor: `keepRepeatedTrackOccurrences`): la posición capturada
// distingue las ocurrencias y ambas se conservan. Por cada conflicto abierto
// cuyos dos claims vienen de la MISMA página con ocurrencias distintas:
//   - el lado cuya ocurrencia coincide con el número de la pista se queda (el
//     conflicto se resuelve por ese lado);
//   - la otra ocurrencia (todos sus claims de esa página) se mueve a la pista
//     de su número: la que ya existe con el mismo título, o una nueva.
// Si ningún lado coincide con el número, o el número ajeno lo ocupa otra
// pista con otro título, no se toca (queda en el informe).
//
//   ./scripts/with-node22.sh npx tsx scripts/curaduria-2026-10-05-split-repeated.ts [--confirm]
import { writeFileSync } from "node:fs";
import type { PoolClient } from "pg";
import { closeDb, getPool } from "../src/db/client.js";
import { resolveFieldConflict } from "../src/merge/engine.js";
import { withOperatorRun } from "../src/merge/operator.js";

const OPERATOR = "claude-code";
const NOTE = "Curaduría 2026-10-05: pistas homónimas de la misma ficha de Sincopa fundidas en una; cada ocurrencia vuelve a su posición (la evidencia capturada las distingue)";
const fold = (s: string): string => s.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase().replace(/[^\p{L}\d]+/gu, " ").trim();

interface ConflictRow {
  conflict_id: string; field: string; track_id: string; album_id: string; disc_number: number; track_number: number; title: string;
  claim_a_id: string; claim_b_id: string; occ_a: number | null; occ_b: number | null;
}

const OCC = `(SELECT (c2.raw_value #>> '{}')::int FROM ingest.claims c JOIN ingest.claim_evidence e ON e.claim_id=c.id
    JOIN ingest.claims c2 ON c2.source_id=c.source_id AND c2.raw_page_id IS NOT DISTINCT FROM c.raw_page_id
     AND c2.identity_key=c.identity_key AND c2.field='track_number' AND c2.entity_kind='track'
    JOIN ingest.claim_evidence e2 ON e2.claim_id=c2.id AND e2.position=e.position
   WHERE c.id=$ID LIMIT 1)`;

async function loadConflicts(client: PoolClient): Promise<ConflictRow[]> {
  const { rows } = await client.query<ConflictRow>(`
    SELECT cf.id::text AS conflict_id, cf.field, t.id::text AS track_id, t.album_id::text, t.disc_number, t.track_number, t.title,
           ca.id::text AS claim_a_id, cb.id::text AS claim_b_id,
           ${OCC.replace("$ID", "ca.id")} AS occ_a, ${OCC.replace("$ID", "cb.id")} AS occ_b
      FROM ingest.conflicts cf
      JOIN ingest.claims ca ON ca.id=cf.claim_a_id JOIN ingest.claims cb ON cb.id=cf.claim_b_id
      JOIN public.tracks t ON t.id=ca.track_id
     WHERE cf.status='open' AND cf.entity_kind='track' AND ca.track_id=cb.track_id
       AND ca.source_id=cb.source_id AND ca.raw_page_id=cb.raw_page_id
     ORDER BY t.album_id, t.track_number, cf.id`);
  return rows.filter((row) => row.occ_a !== null && row.occ_b !== null && row.occ_a !== row.occ_b);
}

/** Todos los claims de la misma ocurrencia (fuente, página, identidad y posición de evidencia) que cuelgan de la pista. */
async function occurrenceClaims(client: PoolClient, claimId: number, trackId: number): Promise<number[]> {
  const { rows } = await client.query<{ id: string }>(`
    SELECT DISTINCT s.id::text FROM ingest.claims c JOIN ingest.claim_evidence e ON e.claim_id=c.id
      JOIN ingest.claims s ON s.source_id=c.source_id AND s.raw_page_id IS NOT DISTINCT FROM c.raw_page_id AND s.identity_key=c.identity_key
      JOIN ingest.claim_evidence es ON es.claim_id=s.id AND es.position=e.position
     WHERE c.id=$1 AND s.track_id=$2`, [claimId, trackId]);
  return rows.map((row) => Number(row.id));
}

interface Outcome { conflictId: number; trackId: number; field: string; action: string; detail: string }

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const pool = getPool();
  const probe = await pool.connect();
  const conflicts = await loadConflicts(probe);
  probe.release();
  console.log(`${conflicts.length} conflictos con ocurrencias distintas de la misma página`);

  const outcomes: Outcome[] = [];
  const work = async (client: PoolClient, runId: number | undefined): Promise<void> => {
    for (const row of conflicts) {
      const conflictId = Number(row.conflict_id);
      const trackId = Number(row.track_id);
      const live = await client.query<{ status: string }>("SELECT status::text FROM ingest.conflicts WHERE id=$1", [conflictId]);
      if (live.rows[0]?.status !== "open") { outcomes.push({ conflictId, trackId, field: row.field, action: "ya_cerrado", detail: "" }); continue; }
      const { rows: [track] } = await client.query<{ track_number: number; disc_number: number; album_id: string; title: string }>(
        "SELECT track_number, disc_number, album_id::text, title FROM public.tracks WHERE id=$1", [trackId]);
      if (!track) { outcomes.push({ conflictId, trackId, field: row.field, action: "sin_pista", detail: "" }); continue; }
      const staysA = row.occ_a === track.track_number;
      const staysB = row.occ_b === track.track_number;
      if (staysA && staysB) { outcomes.push({ conflictId, trackId, field: row.field, action: "manual", detail: "misma posición" }); continue; }
      // Lados que no pertenecen a esta pista: con uno solo, el otro gana el conflicto; con los dos, se mudan ambos.
      const foreign: Array<{ claim: number; pos: number }> = [];
      if (!staysA) foreign.push({ claim: Number(row.claim_a_id), pos: row.occ_a! });
      if (!staysB) foreign.push({ claim: Number(row.claim_b_id), pos: row.occ_b! });
      const plans: Array<{ moving: number[]; destination: number | null; pos: number; title: string }> = [];
      let blocked: string | null = null;
      for (const side of foreign) {
        const moving = await occurrenceClaims(client, side.claim, trackId);
        const { rows: [titleClaim] } = await client.query<{ value: string }>(
          "SELECT COALESCE(normalized_value, raw_value) #>> '{}' AS value FROM ingest.claims WHERE id=ANY($1::bigint[]) AND field='title' ORDER BY id LIMIT 1", [moving]);
        const occTitle = titleClaim?.value ?? track.title;
        const { rows: occupied } = await client.query<{ id: string; title: string }>(
          "SELECT id::text, title FROM public.tracks WHERE album_id=$1 AND disc_number=$2 AND track_number=$3",
          [Number(track.album_id), track.disc_number, side.pos]);
        if (occupied[0]) {
          const there = fold(occupied[0].title);
          const same = there === fold(occTitle) || there === fold(track.title) || there.startsWith(`${fold(track.title)} `) || there.startsWith(`${fold(occTitle)} `);
          if (!same) { blocked = `la posición ${side.pos} la ocupa «${occupied[0].title}» (${occupied[0].id})`; break; }
          plans.push({ moving, destination: Number(occupied[0].id), pos: side.pos, title: occTitle });
        } else {
          plans.push({ moving, destination: null, pos: side.pos, title: occTitle });
        }
      }
      if (blocked) { outcomes.push({ conflictId, trackId, field: row.field, action: "manual", detail: blocked }); continue; }
      if (foreign.length === 1) {
        await resolveFieldConflict(conflictId, staysA ? "resolved_a" : "resolved_b", { actor: "human", note: NOTE, ...(runId ? { runId } : {}), client });
      }
      for (const plan of plans) {
        let destination = plan.destination;
        if (destination === null) {
          const { rows: [created] } = await client.query<{ id: string }>(
            "INSERT INTO public.tracks(album_id, disc_number, track_number, title) VALUES ($1,$2,$3,$4) RETURNING id::text",
            [Number(track.album_id), track.disc_number, plan.pos, plan.title]);
          destination = Number(created!.id);
        }
        await client.query("UPDATE ingest.claims SET track_id=$1, status='accepted', updated_at=now() WHERE id=ANY($2::bigint[])", [destination, plan.moving]);
        const { rows: [duration] } = await client.query<{ value: string }>(
          "SELECT COALESCE(normalized_value, raw_value) #>> '{}' AS value FROM ingest.claims WHERE id=ANY($1::bigint[]) AND field='duration_seconds' ORDER BY id LIMIT 1", [plan.moving]);
        if (duration && /^\d+$/u.test(duration.value)) {
          await client.query("UPDATE public.tracks SET duration_seconds=$1 WHERE id=$2 AND duration_seconds IS NULL", [Number(duration.value), destination]);
        }
        outcomes.push({ conflictId, trackId, field: row.field, action: plan.destination === null ? "pista_nueva" : "movida_a_existente",
          detail: `ocurrencia ${plan.pos} «${plan.title}» → pista ${destination} (${plan.moving.length} claims)` });
      }
    }
    // Conflictos que quedaron entre una pista y claims ya mudados: el claim que se fue no disputa nada aquí.
    const { rows: stale } = await client.query<{ id: string }>(`
      SELECT cf.id::text FROM ingest.conflicts cf JOIN ingest.claims ca ON ca.id=cf.claim_a_id JOIN ingest.claims cb ON cb.id=cf.claim_b_id
       WHERE cf.status='open' AND cf.entity_kind='track' AND ca.track_id IS DISTINCT FROM cb.track_id`);
    for (const item of stale) {
      await client.query(`UPDATE ingest.conflicts SET status='both_kept', resolved_by='human', resolution_note=$2, resolved_at=now() WHERE id=$1`, [Number(item.id), NOTE]);
      await client.query(`UPDATE ingest.review_queue SET status='approved', resolved_by='human', resolution_note=$2, resolved_at=now(), updated_at=now()
        WHERE conflict_id=$1 AND status IN ('open','in_progress')`, [Number(item.id), NOTE]);
      outcomes.push({ conflictId: Number(item.id), trackId: 0, field: "", action: "cerrado_por_mudanza", detail: "" });
    }
  };

  if (confirm) {
    const { runId } = await withOperatorRun({ name: "curation:split-repeated-tracks", operator: OPERATOR, note: NOTE }, (context) => work(context.client, context.runId));
    console.log(`run ${runId}`);
  } else {
    const client = await pool.connect();
    try { await client.query("BEGIN"); await work(client, undefined); } finally { await client.query("ROLLBACK"); client.release(); }
  }
  const counts: Record<string, number> = {};
  for (const outcome of outcomes) counts[outcome.action] = (counts[outcome.action] ?? 0) + 1;
  console.log(counts);
  writeFileSync(`reports/curaduria-2026-10-05/split-repeated-${confirm ? "confirm" : "dry-run"}.json`, JSON.stringify(outcomes, null, 1));
  await closeDb();
}
void main();
