// CRV · Sonda de fusión de personas contra la base de desarrollo (E11.1).
//
// Fusiona un par REAL dentro de una transacción y la revierte SIEMPRE en el
// `finally`: comprueba sobre los datos reales que el par que bloqueaba la
// fusión (14 → 3617, con revisión careada en review_queue: P1) ya se une, y
// que el motor tarda menos de 2 s (P8). Nada de lo que escribe sobrevive.
//
//   ./scripts/with-node22.sh node_modules/.bin/tsx scripts/probes/merge-probe.mts [keepId] [dropId]
//
// Reglas: solo lee y simula; el ROLLBACK va en el `finally` y no depende del
// resultado. Código de salida 1 si la fusión falla o si supera el límite.
import { closeDb, getPool } from "../../src/db/client.js";
import { getEnv } from "../../src/config/env.js";
import { mergeInto, type MergeOutcome } from "../../src/review/duplicates.js";

const LIMIT_MS = 2000;
const keepId = Number(process.argv[2] ?? 14);
const dropId = Number(process.argv[3] ?? 3617);
// Solo el destino (host:puerto/base), nunca las credenciales.
const target = new URL(getEnv().DATABASE_URL);

const client = await getPool().connect();
let outcome: MergeOutcome | undefined;
let failure: unknown;
let elapsedMs = 0;
let pair = "";
try {
  await client.query("BEGIN");
  const names = await client.query<{ id: string; name: string }>(
    "SELECT id::text,name FROM public.persons WHERE id=ANY($1::bigint[])", [[keepId, dropId]]);
  const name = (id: number) => names.rows.find((row) => Number(row.id) === id)?.name ?? "(no existe)";
  pair = `${keepId} «${name(keepId)}» ← ${dropId} «${name(dropId)}»`;
  const run = await client.query<{ id: string }>(
    `INSERT INTO ingest.scrape_runs(kind,status,params) VALUES('merge_run','running',$1::jsonb) RETURNING id::text`,
    [JSON.stringify({ action: "merge_probe", keepId, dropId })]);
  const runId = Number(run.rows[0]!.id);
  const started = performance.now();
  outcome = await mergeInto(client, "person", keepId, dropId, `sonda de fusión ${keepId}←${dropId} (run ${runId})`, runId);
  elapsedMs = performance.now() - started;
} catch (error) {
  failure = error;
} finally {
  // Todo se revierte, incluso cuando la fusión falla a mitad.
  await client.query("ROLLBACK").catch((error: unknown) => { console.error("el ROLLBACK de la sonda falló:", error); });
  client.release();
  await closeDb();
}

console.log(`sonda de fusión de personas (solo lectura: la transacción se revierte)`);
console.log(`  base: ${target.hostname}:${target.port}${target.pathname}`);
console.log(`  par: ${pair}`);
if (failure) {
  console.log(`  FALLO: ${(failure as Error).message}`);
  console.log(`  tiempo hasta el fallo: ${elapsedMs.toFixed(0)} ms`);
  console.log("RESULTADO: FALLO");
  process.exitCode = 1;
} else if (outcome) {
  console.log(`  referencias movidas: ${outcome.moved} en ${outcome.movedRefs.length} columnas (${[...new Set(outcome.movedRefs.map((item) => item.table))].join(", ")})`);
  console.log(`  filas descartadas: ${outcome.discarded} · columnas completadas: ${outcome.filled.length ? outcome.filled.join(", ") : "ninguna"}`);
  console.log(`  revisiones careadas soltadas: ${outcome.detachedReviews.length} · auditoría: ${outcome.auditId}`);
  console.log(`  tiempo: ${elapsedMs.toFixed(0)} ms (límite ${LIMIT_MS} ms)`);
  const ok = elapsedMs < LIMIT_MS;
  console.log(`RESULTADO: ${ok ? "OK" : `LENTA (${elapsedMs.toFixed(0)} ms ≥ ${LIMIT_MS} ms)`}`);
  if (!ok) process.exitCode = 1;
}
