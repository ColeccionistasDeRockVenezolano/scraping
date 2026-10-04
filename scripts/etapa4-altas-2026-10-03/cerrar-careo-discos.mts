// Etapa 4 «Altas» — cierre del careo de discos (paquete de confirmación).
//
// Registra el veredicto en la Mesa (ingest.review_decisions: same/different) de
// los reviews confirmados por Brian y aplica SOLO esos reviews con
// `applyReviewDecisions` (un merge_run acotado, reversible por el diario 0028).
//
// Uso (dry-run por defecto; --confirm escribe):
//   ./scripts/with-node22.sh node_modules/.bin/tsx scripts/etapa4-altas-2026-10-03/cerrar-careo-discos.mts [--confirm]
import { readFileSync, writeFileSync } from "node:fs";
import { closeDb, getPool } from "../../src/db/client.js";
import { applyReviewDecisions } from "../../src/review/decisions.js";

const args = process.argv.slice(2);
const confirm = args.includes("--confirm");
const TSV = "reports/etapa4-altas-2026-10-03/careo-discos.tsv";
const SALIDA = "reports/etapa4-altas-2026-10-03/aplicacion-careo-discos.json";
const OPERATOR = "hermes-curaduria";
const NOTA = "Careo de discos de la etapa 4 — paquete de confirmación: veredicto por evidencia (11 «misma» / 29 «otra»), con el OK de Brian del 2026-10-04.";

interface Row {
  review_id: string;
  propuesta: string;
  disco_rym: string;
  cat_titulo: string;
  nota_fina: string;
}

function loadRows(): Row[] {
  const [head = "", ...lines] = readFileSync(TSV, "utf8").trim().split("\n");
  const cols = head.split("\t");
  return lines.map((line) => Object.fromEntries(line.split("\t").map((v, i) => [cols[i], v])) as unknown as Row);
}

const rows = loadRows();
const verdictOf = (p: string) => (p === "misma" ? "same" : p === "otra" ? "different" : undefined);
const targets = rows
  .map((r) => ({ reviewId: Number(r.review_id), verdict: verdictOf(r.propuesta), disco: r.disco_rym, cat: r.cat_titulo, nota: r.nota_fina }))
  .filter((t): t is typeof t & { verdict: "same" | "different" } => t.verdict !== undefined);
const parqueadas = rows.filter((r) => verdictOf(r.propuesta) === undefined);

if (!targets.length) throw new Error("el TSV no trae filas confirmadas (¿se regeneró el paquete?)");
const nSame = targets.filter((t) => t.verdict === "same").length;
console.log(`confirmadas: ${targets.length} (same ${nSame} · different ${targets.length - nSame}) · parqueadas: ${parqueadas.length}`);

const pool = getPool();
const ids = targets.map((t) => t.reviewId);
const estados = new Map((await pool.query<{ id: string; status: string }>(
  "SELECT id::text AS id, status::text AS status FROM ingest.review_queue WHERE id = ANY($1::bigint[])", [ids],
)).rows.map((r) => [Number(r.id), r.status]));
const cerradas = new Set(targets.filter((t) => estados.get(t.reviewId) !== "open" && estados.get(t.reviewId) !== "in_progress").map((t) => t.reviewId));
for (const id of cerradas) console.log(`AVISO: review ${id} está en estado «${estados.get(id) ?? "inexistente"}» — se omite`);

const activas = new Set((await pool.query<{ review_id: string }>(
  "SELECT DISTINCT review_id::text AS review_id FROM ingest.review_decisions WHERE review_id = ANY($1::bigint[]) AND status='active'", [ids],
)).rows.map((r) => Number(r.review_id)));
for (const id of activas) console.log(`AVISO: review ${id} ya tiene decisión activa en la Mesa`);

const aplicar = targets.filter((t) => !cerradas.has(t.reviewId));
const nuevas = aplicar.filter((t) => !activas.has(t.reviewId));

if (!confirm) {
  console.log(`[dry-run] insertaría ${nuevas.length} decisiones y aplicaría un merge_run con alcance a ${aplicar.length} reviews. Nada escrito.`);
  await closeDb();
  process.exit(0);
}

if (nuevas.length) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const t of nuevas) {
      await client.query(
        `INSERT INTO ingest.review_decisions(review_id, verdict, decided_by, note, context)
         VALUES($1,$2,$3,$4,$5::jsonb)`,
        [t.reviewId, t.verdict, OPERATOR, NOTA, JSON.stringify({ via: "cli-etapa4", fuente: "careo-discos.tsv", fecha: "2026-10-04" })],
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

const result = await applyReviewDecisions(`[${OPERATOR}] ${NOTA}`, { reviewIds: aplicar.map((t) => t.reviewId) });
console.log(`merge_run ${result.runId}: ${result.appliedReviews} reviews aplicadas · ${result.failed} fallos · ${result.appliedDecisionRows} filas de decisión marcadas (de ${result.total} en alcance)`);
for (const e of result.errors.slice(0, 20)) console.log(`  fallo review ${e.reviewId}: ${e.error}`);

const post = await pool.query<{ status: string; n: string }>(
  "SELECT status::text AS status, count(*)::text AS n FROM ingest.review_queue WHERE id = ANY($1::bigint[]) GROUP BY status", [ids],
);
console.log("post-check:", post.rows.map((r) => `${r.n} ${r.status}`).join(" · "));

writeFileSync(SALIDA, JSON.stringify({
  fecha: new Date().toISOString(), runId: result.runId,
  aplicadas: aplicar.map((t) => ({ reviewId: t.reviewId, verdict: t.verdict, disco: t.disco, catalogo: t.cat, nota: t.nota })),
  parqueadas: parqueadas.map((p) => ({ reviewId: Number(p.review_id), disco: p.disco_rym, pregunta: p.nota_fina })),
  resultado: { appliedReviews: result.appliedReviews, failed: result.failed, total: result.total, errors: result.errors },
}, null, 2));
console.log(`salida: ${SALIDA}`);
await closeDb();
