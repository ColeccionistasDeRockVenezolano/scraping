// Etapa 4 «Altas» — enriquecimiento post-Mesa: los álbumes creados por
// `applyReviewDecisions` (veredicto «different») nacieron del claim de título,
// así que los claims hermanos (release_year, album_type) del plan nunca se
// aplicaron. Este script los afirma con `settleEntityField` (corrección humana
// sancionada) en un run reversible.
//
// Uso (dry-run por defecto; --confirm escribe):
//   ./scripts/with-node22.sh node_modules/.bin/tsx scripts/etapa4-altas-2026-10-03/enriquecer-mesa-creadas.mts [--confirm]
import { readFileSync, writeFileSync } from "node:fs";
import { closeDb, getPool } from "../../src/db/client.js";
import { settleEntityField, withOperatorRun } from "../../src/merge/operator.js";

const args = process.argv.slice(2);
const confirm = args.includes("--confirm");
const PLAN = "reports/etapa4-altas-2026-10-03/plan-lote1.jsonl";
const SALIDA = "reports/etapa4-altas-2026-10-03/aplicacion-enriquecimiento-mesa.json";
const RUNS_LOTE = "11726,11729,11732,11741,11746,11752";

const norm = (s: unknown) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "");

interface PlanItem { tipo: string; values?: Record<string, unknown>; parent?: { artist_id?: number } }
const plan = readFileSync(PLAN, "utf8").trim().split("\n").map((l) => JSON.parse(l) as PlanItem);
const itemsAlbum = plan.filter((p) => p.tipo === "album" && p.values);

const pool = getPool();
const { rows } = await pool.query<{ claim_id: string; album_id: string; titulo: string; artist_id: string; release_year: string | null; album_type: string | null }>(`
  SELECT c.id::text AS claim_id, c.album_id::text AS album_id, al.title AS titulo, al.artist_id::text AS artist_id,
         al.release_year::text AS release_year, al.album_type::text AS album_type
    FROM ingest.claims c
    JOIN public.albums al ON al.id = c.album_id
   WHERE c.field='title' AND c.status='accepted' AND c.album_id IS NOT NULL
     AND c.identity_key LIKE '%#operador-%' AND c.run_id IN (${RUNS_LOTE})
     AND (al.release_year IS NULL OR al.album_type IS NULL)
   ORDER BY c.album_id`);

interface Target { albumId: number; titulo: string; campos: Array<{ field: string; value: unknown }> }
const targets: Target[] = [];
for (const r of rows) {
  const item = itemsAlbum.find((p) => norm(p.values!["title"]) === norm(r.titulo)
    && (p.parent?.artist_id === undefined || String(p.parent.artist_id) === r.artist_id));
  if (!item) { console.log(`AVISO: sin ítem del plan para álbum ${r.album_id} «${r.titulo}» — se omite`); continue; }
  const campos: Target["campos"] = [];
  const anio = item.values!["release_year"];
  if (r.release_year === null && typeof anio === "number") campos.push({ field: "release_year", value: anio });
  const at = item.values!["album_type"];
  if (at && r.album_type === null) campos.push({ field: "album_type", value: at });
  if (campos.length) targets.push({ albumId: Number(r.album_id), titulo: r.titulo, campos });
}

console.log(`fichas a enriquecer: ${targets.length} (campos: ${targets.reduce((a, t) => a + t.campos.length, 0)})`);
for (const t of targets) console.log(`  #${t.albumId} «${t.titulo}»: ${t.campos.map((c) => `${c.field}=${c.value}`).join(", ")}`);

if (!confirm) {
  console.log("[dry-run] aplicaría settleEntityField por campo en un run. Nada escrito.");
  await closeDb();
  process.exit(0);
}
if (!targets.length) { console.log("nada que enriquecer."); await closeDb(); process.exit(0); }

const { runId, result } = await withOperatorRun({
  name: "hermes:etapa4-enriquecer-mesa",
  operator: "hermes-curaduria (delegado por Brian)",
  note: "Enriquecimiento de las fichas creadas por la Mesa en la etapa 4: años y tipos del plan que no viajaron con la decisión «different» (claims hermanos). OK de Brian 2026-10-04.",
}, async (context) => {
  const hechas: Array<Record<string, unknown>> = [];
  for (const t of targets) {
    try {
      for (const c of t.campos) {
        const write = await settleEntityField(context, "album", t.albumId, c.field, c.value);
        hechas.push({ albumId: t.albumId, field: c.field, value: c.value, accion: write.action });
      }
    } catch (error) {
      hechas.push({ albumId: t.albumId, error: (error as Error).message.slice(0, 200) });
    }
  }
  return hechas;
}, );
console.log(`run ${runId}: ${result.length} escrituras`);
for (const h of result.filter((h) => h["error"])) console.log("  FALLO:", JSON.stringify(h));
writeFileSync(SALIDA, JSON.stringify({ fecha: new Date().toISOString(), runId, detalle: result }, null, 2));
console.log(`salida: ${SALIDA}`);
await closeDb();
