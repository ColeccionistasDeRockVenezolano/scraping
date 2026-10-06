// RYM «nuevos» · cola: los 394 discos que el ER frenó por parecerse a otro del mismo artista
// (Brian 2026-10-06: «crear salvo los idénticos»). En la muestra casi todos son discos distintos
// (Vol. II ⇄ Vol. I, remix, en vivo, otro título). Solo se funden los que son el mismo título al
// quitar mayúsculas, tildes, signos o el artículo, con el mismo año (±1) — revisados uno a uno
// el 2026-10-06; «La venezolana» (1976) ⇄ «Venezolana» (1967) queda como disco aparte.
// «Mismo» = acceptReview con el candidato (el claim se funde en la ficha existente);
// «distinto» = rejectReview (el ER crea el disco). Un run por revisión, como en la Mesa.
//   ./scripts/with-node22.sh node_modules/.bin/tsx scripts/rym-nuevos-aplicar/resolver-album-match.mts [--confirm]
import { writeFileSync } from "node:fs";
import { closeDb, getPool } from "../../src/db/client.js";
import { acceptReview, rejectReview } from "../../src/review/operator-review.js";

const MISMOS = new Set([1836043, 1836044, 1836051, 1836216, 1836484, 1836502, 1836522, 1847265, 1847282, 1847297, 1847300]);
const confirm = process.argv.includes("--confirm");
const operator = "claude-code (delegado por Brian)";

const { rows } = await getPool().query<{ id: string; title: string; candidate: string | null }>(`
  SELECT q.id::text, d.input_name_original AS title, d.candidates->0->>'canonicalName' AS candidate
    FROM ingest.review_queue q
    JOIN ingest.entity_resolution_decisions d ON d.id = (q.payload->>'resolutionDecisionId')::bigint
   WHERE q.kind='album_match' AND q.status IN ('open','in_progress') ORDER BY q.id`);
const informe = { mismos: [] as unknown[], distintos: [] as unknown[], errores: [] as unknown[] };
for (const row of rows) {
  const id = Number(row.id);
  const mismo = MISMOS.has(id);
  if (!confirm) { (mismo ? informe.mismos : informe.distintos).push({ id, title: row.title, candidate: row.candidate }); continue; }
  try {
    const note = mismo
      ? "RYM «nuevos» 2026-10-06: mismo disco (título igual salvo mayúsculas/tildes/artículo, mismo año); se funde en la ficha existente"
      : "RYM «nuevos» 2026-10-06: disco distinto del candidato (otro volumen, parte, versión o título); se crea";
    const r = mismo ? await acceptReview(id, { operator, note }) : await rejectReview(id, { operator, note });
    (mismo ? informe.mismos : informe.distintos).push({ id, title: row.title, candidate: row.candidate, runId: r.runId, detail: r.detail });
  } catch (error) {
    informe.errores.push({ id, title: row.title, error: error instanceof Error ? error.message.slice(0, 200) : String(error) });
  }
}
writeFileSync(`reports/rym-nuevos-aplicacion-2026-10-05/album-match-${confirm ? "aplicado" : "ensayo"}.json`, JSON.stringify(informe, null, 1));
console.log(JSON.stringify({ modo: confirm ? "aplicado" : "ensayo", mismos: informe.mismos.length, distintos: informe.distintos.length,
  errores: informe.errores.length, ejemplos: informe.errores.slice(0, 3) }));
await closeDb();
