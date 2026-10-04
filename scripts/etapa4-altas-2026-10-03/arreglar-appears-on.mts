// Etapa 4 «Altas» — reparación de las fichas creadas desde filas «Appears On»
// del barrido de los 222 + duplicados de doble firma del lote 1.
//
// Cada par lo verifica el barrido lateral (capturas de página RYM: la fila del
// padre debe ser la sección propia del release, no «Appears On»). La fusión va
// por `mergeDuplicate` (mismo camino que `crv review duplicates`), en un
// merge_run propio, con auditoría y deshacer por el diario 0028.
//
// Uso (dry-run por defecto; --confirm escribe):
//   ./scripts/with-node22.sh node_modules/.bin/tsx scripts/etapa4-altas-2026-10-03/arreglar-appears-on.mts [--confirm]
import { writeFileSync } from "node:fs";
import { closeDb, getPool } from "../../src/db/client.js";
import { finishRun } from "../../src/ingest/runs.js";
import { mergeDuplicate } from "../../src/review/duplicates.js";

const args = process.argv.slice(2);
const confirm = args.includes("--confirm");
const SALIDA = "reports/etapa4-altas-2026-10-03/aplicacion-fix-appears-on.json";
const NOTA = "Reparación del lote 1 (etapa 4): fusión de fichas creadas desde filas «Appears On» y de duplicados de doble firma, verificada contra las capturas RYM. OK de Brian 2026-10-04.";

interface Par { keep: number; drop: number; caso: string }
const PARES: Par[] = [
  { keep: 3020, drop: 15474, caso: "«Sin afina' mucho» (Cuarto Poder ← fila Appears On) → «Sin Afinar Mucho» (Apache, la obra)" },
  { keep: 15549, drop: 15450, caso: "«En vivo» (C4 Trío ← fila Appears On) → «En vivo» (Movida Acústica Urbana, la obra)" },
  { keep: 15571, drop: 15498, caso: "«Tonada para Simón» (Hana Kobayashi ← fila Appears On) → «Tonada para Simón» (Rodrigo Solo, la obra)" },
  { keep: 15627, drop: 15436, caso: "«La energía» duplicada (Vargas & Apache): se mantiene la firma primera del release" },
  { keep: 15610, drop: 15443, caso: "«Tsee Mud... Bacro... LSD» duplicada: se mantiene la firma primera del release" },
  { keep: 2753, drop: 15475, caso: "«Afinando» (Cuarto Poder ← fila Appears On) → «Afinando» (Apache, ya en catálogo desde el 2026-09-13)" },
  { keep: 316, drop: 15499, caso: "«No estás solo» (Hana Kobayashi ← fila Appears On) → «No Estás Solo» (Rodrigo Solo, ya en catálogo desde el 2026-09-11)" },
];

const pool = getPool();
const ids = [...new Set(PARES.flatMap((p) => [p.keep, p.drop]))];
const filas = new Map((await pool.query<{ id: string; title: string; artist_id: string }>(
  "SELECT id::text AS id, title, artist_id::text AS artist_id FROM public.albums WHERE id = ANY($1::bigint[])", [ids],
)).rows.map((r) => [Number(r.id), r]));
console.log("pre-vuelo:");
const listos: Par[] = [];
for (const p of PARES) {
  const k = filas.get(p.keep), d = filas.get(p.drop);
  if (!k || !d) { console.log(`  [omitido: ficha faltante] keep ${p.keep} ← drop ${p.drop} (ya fusionado o inexistente)`); continue; }
  listos.push(p);
  const refs = (await pool.query<{ n: string }>(
    "SELECT (SELECT count(*) FROM ingest.claims WHERE album_id=$1)::text AS n", [p.drop],
  )).rows[0]!.n;
  console.log(`  [ok] keep ${p.keep} «${k.title}» ← drop ${p.drop} «${d.title}» (claims del drop: ${refs})`);
}

if (!confirm) {
  console.log(`[dry-run] fusionaría ${listos.length} pares en un merge_run de reparación. Nada escrito.`);
  await closeDb();
  process.exit(0);
}

if (!listos.length) {
  console.log("nada pendiente: todos los pares ya están fusionados.");
  await closeDb();
  process.exit(0);
}

const opened = await pool.query<{ id: string }>(`
  INSERT INTO ingest.scrape_runs(kind,status,params) VALUES('merge_run','running',$1::jsonb) RETURNING id::text`,
[JSON.stringify({ action: "fix_appears_on_lote1", note: NOTA, pares: PARES.map((p) => ({ keep: p.keep, drop: p.drop, caso: p.caso })) })]);
const runId = Number(opened.rows[0]!.id);
console.log(`merge_run ${runId}`);

const resultados: Array<Record<string, unknown>> = [];
for (const p of listos) {
  try {
    const merged = await mergeDuplicate("album", p.keep, p.drop, `${NOTA} — ${p.caso}`, runId);
    resultados.push({ ...p, estado: "fusionado", ...merged });
    console.log(`  fusionado: ${p.drop} → ${p.keep} (movidos ${merged.moved}, descartados ${merged.discarded}, campos ${merged.filled.join(",") || "-"})`);
  } catch (error) {
    resultados.push({ ...p, estado: "fallo", error: (error as Error).message });
    console.log(`  FALLO: ${p.drop} → ${p.keep}: ${(error as Error).message}`);
  }
}

const fallos = resultados.filter((r) => r["estado"] === "fallo").length;
await finishRun(runId, fallos === 0 ? "ok" : "partial", { pares: listos.length, fallos },
  fallos ? JSON.stringify(resultados.filter((r) => r["estado"] === "fallo")) : undefined);
writeFileSync(SALIDA, JSON.stringify({ fecha: new Date().toISOString(), runId, resultados }, null, 2));
console.log(`run ${runId} ${fallos === 0 ? "ok" : "partial"} · salida: ${SALIDA}`);
await closeDb();
