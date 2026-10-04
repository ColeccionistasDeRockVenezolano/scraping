// Etapa 4 «Altas» — cierre de las 9 filas parqueadas del careo de discos.
//
// Veredictos asistidos con evidencia (capturas RYM + catálogo vivo), resueltos
// con el «resuelve lo que queda» de Brian (2026-10-04). Mesa + applyReviewDecisions
// acotado, en un merge_run reversible por el diario 0028.
//
// Uso (dry-run por defecto; --confirm escribe):
//   ./scripts/with-node22.sh node_modules/.bin/tsx scripts/etapa4-altas-2026-10-03/cerrar-parqueados-discos.mts [--confirm]
import { readFileSync, writeFileSync } from "node:fs";
import { closeDb, getPool } from "../../src/db/client.js";
import { applyReviewDecisions } from "../../src/review/decisions.js";

const args = process.argv.slice(2);
const confirm = args.includes("--confirm");
const DEC = "reports/etapa4-altas-2026-10-03/decisiones-parqueadas-discos.jsonl";
const SALIDA = "reports/etapa4-altas-2026-10-03/aplicacion-parqueadas-discos.json";
const OPERATOR = "hermes-curaduria";
const NOTA = "Careo de discos etapa 4 — filas parqueadas: veredicto asistido con capturas RYM + catálogo vivo, OK de Brian 2026-10-04 («resuelve lo que queda»).";

interface Dec { reviewId: number; verdict: "same" | "different"; caso: string }
const filas: Dec[] = readFileSync(DEC, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Dec);
console.log(`decisiones: ${filas.length} (same ${filas.filter((f) => f.verdict === "same").length} · different ${filas.filter((f) => f.verdict === "different").length})`);

const pool = getPool();
const ids = filas.map((f) => f.reviewId);
const abiertos = new Map((await pool.query<{ id: string; status: string }>(
  "SELECT id::text AS id, status::text AS status FROM ingest.review_queue WHERE id = ANY($1::bigint[])", [ids],
)).rows.map((r) => [Number(r.id), r.status]));
const pendientes = filas.filter((f) => abiertos.get(f.reviewId) === "open" || abiertos.get(f.reviewId) === "in_progress");
for (const f of filas) {
  if (!pendientes.includes(f)) console.log(`AVISO: review ${f.reviewId} ya está ${abiertos.get(f.reviewId) ?? "inexistente"} — se omite`);
}
const activas = new Set((await pool.query<{ review_id: string }>(
  "SELECT DISTINCT review_id::text AS review_id FROM ingest.review_decisions WHERE review_id = ANY($1::bigint[]) AND status='active'", [ids],
)).rows.map((r) => Number(r.review_id)));

if (!confirm) {
  console.log(`[dry-run] insertaría ${pendientes.filter((f) => !activas.has(f.reviewId)).length} decisiones y aplicaría ${pendientes.length} reviews. Nada escrito.`);
  await closeDb();
  process.exit(0);
}

const nuevas = pendientes.filter((f) => !activas.has(f.reviewId));
if (nuevas.length) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const f of nuevas) {
      await client.query(
        `INSERT INTO ingest.review_decisions(review_id, verdict, decided_by, note, context)
         VALUES($1,$2,$3,$4,$5::jsonb)`,
        [f.reviewId, f.verdict, OPERATOR, `${NOTA} — ${f.caso}`,
         JSON.stringify({ via: "cli-etapa4", fuente: "decisiones-parqueadas-discos.jsonl", fecha: "2026-10-04" })],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const result = await applyReviewDecisions(`[${OPERATOR}] ${NOTA}`, { reviewIds: pendientes.map((f) => f.reviewId) });
console.log(`merge_run ${result.runId}: ${result.appliedReviews} aplicadas · ${result.failed} fallos de ${result.total}`);
for (const e of result.errors.slice(0, 10)) console.log(`  fallo review ${e.reviewId}: ${e.error}`);

const post = await pool.query<{ status: string; n: string }>(
  "SELECT status::text AS status, count(*)::text AS n FROM ingest.review_queue WHERE id = ANY($1::bigint[]) GROUP BY status", [ids],
);
console.log("post-check:", post.rows.map((r) => `${r.n} ${r.status}`).join(" · "));
writeFileSync(SALIDA, JSON.stringify({ fecha: new Date().toISOString(), runId: result.runId, decisiones: pendientes, resultado: { appliedReviews: result.appliedReviews, failed: result.failed, total: result.total, errors: result.errors } }, null, 2));
console.log(`salida: ${SALIDA}`);
await closeDb();
