// CRV · Mejora de portadas pequeñas (≤300 px): aplica las coincidencias claras
// de scripts/portadas-mejora-cosecha.py (decision=auto: misma portada, ≥0,90 y
// ≥500 px; prioridad Spotify > Deezer > MusicBrainz > Discogs, Brian
// 2026-10-03). Las «revisar» no se tocan: van a la hoja de contacto.
//
// UN run de operador en una sola transacción (`crv runs undo <run>` lo deshace entero).
// Sin --confirm corre entero y se deshace; el informe lleva una muestra de 40.
// Después `npm run media:localize` descarga las nuevas.
//
//   ./scripts/with-node22.sh npx tsx scripts/portadas-mejora-aplicar.ts [--confirm]
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { closeDb } from "../src/db/client.js";
import { updateEntity, withOperatorRun } from "../src/merge/operator.js";

const DIR = "data/raw/portadas-mejora-2026-10-03";
const HARVEST = `${DIR}/candidatos.jsonl`;
const PRIORITY = ["spotify", "deezer", "musicbrainz", "discogs"];
const NOTE = "Mejora de portadas: miniatura (≤300 px) cambiada por la misma portada en grande, prioridad Spotify > Deezer > MusicBrainz > Discogs (Brian, 2026-10-03)";
const SAMPLE = 40;

interface Candidate { source: string; url: string; page: string; size: [number, number]; score: number }
interface Row { albumId: number; artist: string; title: string; phase: string; decision: string; best: Candidate | null }
interface Outcome { row: Row; action: string }
class DryRun extends Error {
  constructor(readonly outcomes: Outcome[]) { super("dry-run"); }
}

// Discos ya aplicados en un run anterior (aplicados-run*.json): tras
// `media:localize` su portada vuelve a ser local y no deben repetirse.
function applied(): Set<number> {
  const ids = new Set<number>();
  if (!existsSync(DIR)) return ids;
  for (const file of readdirSync(DIR).filter((name) => /^aplicados-run\d+\.json$/u.test(name))) {
    for (const id of JSON.parse(readFileSync(`${DIR}/${file}`, "utf8")) as number[]) ids.add(id);
  }
  return ids;
}

function chosen(): Row[] {
  const skip = applied();
  const byAlbum = new Map<number, Row>();
  for (const line of readFileSync(HARVEST, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as Row;
    if (row.decision !== "auto" || !row.best || skip.has(row.albumId)) continue;
    const previous = byAlbum.get(row.albumId);
    if (!previous || PRIORITY.indexOf(row.best.source) < PRIORITY.indexOf(previous.best!.source)) byAlbum.set(row.albumId, row);
  }
  return [...byAlbum.values()];
}

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const rows = chosen();
  let runId: number | null = null;
  let outcomes: Outcome[];
  try {
    const done = await withOperatorRun({ name: "cover_upgrade", operator: "brian", note: NOTE, params: { harvest: HARVEST, albums: rows.length } }, async (context) => {
      const list: Outcome[] = [];
      for (const row of rows) {
        // Solo si la portada sigue siendo la local que se comparó (nadie la cambió entre medias).
        const current = await context.client.query<{ cover_url: string | null }>("SELECT cover_url FROM public.albums WHERE id=$1", [row.albumId]);
        if (!current.rows[0]) { list.push({ row, action: "saltado: el disco ya no existe (fusionado)" }); continue; }
        if (!current.rows[0].cover_url?.startsWith("/crv/media/album/")) { list.push({ row, action: "saltado: la portada cambió" }); continue; }
        const written = await updateEntity(context, "album", row.albumId, { cover_url: row.best!.url });
        list.push({ row, action: written.fields[0]?.action ?? "?" });
      }
      if (!confirm) throw new DryRun(list);
      return list;
    });
    runId = done.runId;
    outcomes = done.result;
    const ids = outcomes.filter(({ action }) => !action.startsWith("saltado")).map(({ row }) => row.albumId);
    writeFileSync(`${DIR}/aplicados-run${runId}.json`, JSON.stringify(ids));
  } catch (error) {
    if (!(error instanceof DryRun)) throw error;
    outcomes = error.outcomes;
  }
  const mode = confirm ? "confirm" : "dry-run";
  const bySource = new Map<string, number>();
  for (const { row } of outcomes) bySource.set(row.best!.source, (bySource.get(row.best!.source) ?? 0) + 1);
  const step = Math.max(1, Math.floor(outcomes.length / SAMPLE));
  const sample = outcomes.filter((_, index) => index % step === 0).slice(0, SAMPLE);
  const lines = [
    `# Mejora de portadas pequeñas (${mode}${runId ? `, run ${runId}` : ""})`, "", NOTE, "",
    `${outcomes.length} discos · ${[...bySource].map(([source, count]) => `${source} ${count}`).join(" · ")}`, "",
    `## Muestra de ${sample.length}`, "",
    ...sample.map(({ row, action }) => `- ${row.artist} — «${row.title}» (${row.albumId}) · ${row.best!.source} ${row.best!.size.join("×")} · parecido ${row.best!.score} · ${action} · ${row.best!.page}`), "",
  ];
  const file = `reports/portadas-mejora-2026-10-03-${mode}${runId ? `-run${runId}` : ""}.md`;
  writeFileSync(file, lines.join("\n"));
  console.log(`${lines[4]} → ${file}`);
}

main().finally(() => closeDb()).catch((error) => { console.error(error); process.exitCode = 1; });
