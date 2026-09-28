// Importa sugerencias de Discogs para álbumes sin evidencia, en lotes
// reanudables. Usa el adaptador autorizado y no confirma ni publica géneros.
import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { closeDb, getPool } from "../src/db/client.js";
import { runExternalImport } from "../src/genres/external/import.js";

const ROOT = path.resolve("reports");
const INVENTORY = path.join(ROOT, "genre-laya-evidence-coverage-2026-09-26-inventory.jsonl");
const SINCOPA = path.join(ROOT, "genre-laya-evidence-sincopa-2026-09-26.jsonl");
const FIRST = path.join(ROOT, "genre-laya-evidence-discogs-radio-batch-1-2026-09-26.json");
const DIR = path.join(ROOT, "genre-laya-evidence-discogs-batches-2026-09-26");

interface InventoryRow {
  caseId: string; kind: "album" | "artist"; entityId: number; radio: boolean; trackCount: number;
  sourceLinks: Array<{ source: string; url: string }>;
}

function arg(name: string, fallback: number): number {
  const value = process.argv.slice(2).find((item) => item.startsWith(`--${name}=`))?.split("=")[1];
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 200) throw new Error(`--${name} debe estar entre 1 y 200`);
  return parsed;
}

async function main(): Promise<void> {
  const limit = arg("limit", 100);
  const batchSize = Math.min(arg("batch-size", 20), limit);
  const rows = (await readFile(INVENTORY, "utf8")).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as InventoryRow);
  const sincopa = new Set((await readFile(SINCOPA, "utf8")).split(/\r?\n/u).filter(Boolean)
    .map((line) => (JSON.parse(line) as { caseId: string }).caseId));
  const processed = new Set<number>();
  if (await stat(FIRST).then(() => true, () => false)) {
    const first = JSON.parse(await readFile(FIRST, "utf8")) as { targetIds: number[] };
    for (const id of first.targetIds) processed.add(id);
  }
  await mkdir(DIR, { recursive: true });
  for (const name of await readdir(DIR)) {
    if (!name.endsWith(".json")) continue;
    const report = JSON.parse(await readFile(path.join(DIR, name), "utf8")) as { targetIds: number[] };
    for (const id of report.targetIds) processed.add(id);
  }
  const client = await getPool().connect();
  let alreadySuggested: Set<number>;
  try {
    const { rows: suggestions } = await client.query<{ album_id: string }>(`
      SELECT DISTINCT album_id::text FROM ingest.album_genres
       WHERE source_kind = 'external' AND status = 'suggested' AND album_id IS NOT NULL`);
    alreadySuggested = new Set(suggestions.map((row) => Number(row.album_id)));
  } finally { client.release(); }
  const targets = rows.filter((row) => row.kind === "album" && !sincopa.has(row.caseId)
    && !processed.has(row.entityId) && !alreadySuggested.has(row.entityId))
    .sort((a, b) => Number(b.radio) - Number(a.radio) || b.trackCount - a.trackCount
      || b.sourceLinks.length - a.sourceLinks.length || a.entityId - b.entityId)
    .slice(0, limit);
  let matched = 0;
  let suggestions = 0;
  try {
    for (let at = 0; at < targets.length; at += batchSize) {
      const ids = targets.slice(at, at + batchSize).map((row) => row.entityId);
      const report = await runExternalImport({
        sourceSlug: "discogs", level: "album", scope: "targets", confirm: true,
        actor: "codex:laya-evidence", reason: "evidencia trazable de Discogs para álbumes sin género",
        entityIds: ids, limit: ids.length,
      });
      const filename = path.join(DIR, `run-${report.runId}.json`);
      await writeFile(filename, `${JSON.stringify({ targetIds: ids, ...report }, null, 2)}\n`, { flag: "wx" });
      matched += report.identities.matched;
      suggestions += report.coverageAdded;
      console.log(JSON.stringify({ file: filename, processed: at + ids.length, matched: report.identities.matched,
        evidenceAdded: report.coverageAdded, errors: report.errors.length, requests: report.network.requests }));
    }
  } finally { await closeDb(); }
  console.log(JSON.stringify({ selected: targets.length, matched, evidenceAdded: suggestions }));
}

main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  await closeDb();
  process.exitCode = 1;
});
