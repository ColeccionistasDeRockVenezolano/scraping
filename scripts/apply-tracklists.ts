// CRV · Aplica las listas de pistas que DeepSeek leyó de las páginas guardadas
// (scripts/extract-tracklists-deepseek.ts), en UN run del operador reversible.
//
// Guardas añadidas tras la muestra de 40 (2026-09-28):
//   * espacios y saltos de línea del blog se colapsan; se quita un punto final suelto;
//   * un título repetido en la misma lista rechaza el disco (en «Canción - Banda»
//     DeepSeek tomó las bandas: Extreme Gore Fest 9);
//   * en recopilatorios de varios artistas, dos o más «pistas» con nombre de un
//     artista del catálogo rechazan el disco;
//   * más de 25 pistas en un solo disco va a revisión (dobles CD numerados seguido).
// Solo toca discos que siguen sin pistas al aplicar.
//
//   npx tsx scripts/apply-tracklists.ts [--exclude=1,2] [--confirm]
import { readFileSync, writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";
import { createEntity, withOperatorRun } from "../src/merge/operator.js";

const DATE = "2026-09-28";
const IN = `reports/tracklists-deepseek-${DATE}.jsonl`;
const confirm = process.argv.includes("--confirm");
const exclude = new Set((process.argv.find((a) => a.startsWith("--exclude="))?.slice(10) ?? "").split(",").filter(Boolean).map(Number));
const VARIOUS = /^(?:va|v\.a\.|various artists?|varios(?: artistas)?)$/iu;

interface Row { albumId: number; artist: string; title: string; status: string; sourceUrl: string; tracks: Array<{ disc: number; position: number; title: string; duration: string | null }> }

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/gu, " ").trim();
const clean = (s: string) => s.replace(/\s+/gu, " ").trim().replace(/(?<!\.)\.$/u, "").trim();
const seconds = (d: string | null) => {
  const m = d ? /^(\d{1,2}):(\d{2})$/u.exec(d.trim()) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

async function main(): Promise<void> {
  const rows = readFileSync(IN, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row).filter((r) => r.status === "ok");
  const pool = getPool();
  const artistNames = new Set((await pool.query<{ name: string }>("SELECT name FROM public.artists")).rows.map((r) => fold(r.name)));
  const empty = new Set((await pool.query<{ id: string }>(
    "SELECT a.id::text FROM public.albums a WHERE NOT EXISTS (SELECT 1 FROM public.tracks t WHERE t.album_id=a.id)")).rows.map((r) => Number(r.id)));
  const report = { accepted: [] as Array<{ albumId: number; artist: string; title: string; tracks: number; url: string }>,
    rejected: [] as Array<{ albumId: number; artist: string; title: string; why: string }>, runId: null as number | null, tracksCreated: 0 };
  const plan: Array<{ row: Row; tracks: Array<{ disc: number; position: number; title: string; duration: number | null }> }> = [];
  for (const row of rows) {
    const reject = (why: string) => report.rejected.push({ albumId: row.albumId, artist: row.artist, title: row.title, why });
    if (exclude.has(row.albumId)) { reject("excluido a mano"); continue; }
    if (!empty.has(row.albumId)) { reject("ya tiene pistas o no existe"); continue; }
    const tracks = row.tracks.map((t) => ({ disc: t.disc, position: t.position, title: clean(t.title), duration: seconds(t.duration) }));
    const keys = tracks.map((t) => fold(t.title));
    if (new Set(keys).size !== keys.length) { reject("títulos repetidos en la lista"); continue; }
    if (VARIOUS.test(row.artist.trim()) && keys.filter((k) => artistNames.has(k)).length >= 2) { reject("las pistas son nombres de artistas"); continue; }
    if (tracks.filter((t) => t.disc === 1).length > 25) { reject("más de 25 pistas en un disco (¿doble CD?)"); continue; }
    if (tracks.some((t) => !t.title)) { reject("título vacío"); continue; }
    plan.push({ row, tracks });
    report.accepted.push({ albumId: row.albumId, artist: row.artist, title: row.title, tracks: tracks.length, url: row.sourceUrl });
  }
  if (confirm) {
    const { runId, result } = await withOperatorRun({
      name: "claude:tracklists-deepseek", operator: "claude (delegado por Brian)",
      note: "Listas de pistas leídas por DeepSeek flash de las páginas guardadas (data/raw) de cada disco sin pistas; cada título aparece literal en el texto. Muestra de 40 revisada a mano el 2026-09-28 (Brian: muestra y luego directo).",
      params: { ledger: IN, albums: plan.map((p) => ({ albumId: p.row.albumId, url: p.row.sourceUrl })) },
    }, async (context) => {
      let created = 0;
      for (const { row, tracks } of plan) {
        for (const t of tracks) {
          await createEntity(context, "track", { title: t.title, disc_number: t.disc, track_number: t.position,
            ...(t.duration ? { duration_seconds: t.duration } : {}) }, { albumId: row.albumId, allowSimilar: true });
          created += 1;
        }
      }
      return created;
    });
    report.runId = runId;
    report.tracksCreated = result;
  }
  const out = `reports/apply-tracklists-${confirm ? "confirm" : "dry-run"}-${DATE}.json`;
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`listas: ${report.accepted.length} discos aceptados (${plan.reduce((s, p) => s + p.tracks.length, 0)} pistas), ${report.rejected.length} rechazados${report.runId ? `; run ${report.runId}, ${report.tracksCreated} pistas creadas` : ""} → ${out}`);
  for (const r of report.rejected) console.log(`  ✗ ${r.albumId} ${r.artist} | ${r.title}: ${r.why}`);
  await closeDb();
}

main().catch(async (error) => { console.error(error); await closeDb(); process.exit(1); });
