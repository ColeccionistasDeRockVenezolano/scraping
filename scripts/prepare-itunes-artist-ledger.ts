// Conserva la prioridad de Last.fm al aplicar iTunes por artista: iTunes
// aporta fichas nuevas, sin desplazar una fila anterior con género reconocido.
import { writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";
import { loadTaxonomy } from "../src/genres/store.js";
import { readLedger, sourceSlugs } from "./genre-source-rows.js";
import { SKIP_SOURCE_ROWS } from "./genre-source-skip.js";

const LASTFM = "reports/genre-laya-evidence-lastfm-2026-09-26.jsonl";
const ITUNES = "reports/genre-laya-evidence-itunes-artists-2026-09-27.jsonl";
const OUT = "reports/genre-laya-evidence-itunes-artists-new-2026-09-27.jsonl";

async function main(): Promise<void> {
  const client = await getPool().connect();
  try {
    const taxonomy = await loadTaxonomy(client);
    const prior = new Set(readLedger(LASTFM)
      .filter((row) => !SKIP_SOURCE_ROWS.has(`${row.source}|${row.caseId}`) && sourceSlugs(taxonomy, row).slugs.length)
      .map((row) => row.caseId));
    const rows = readLedger(ITUNES);
    const fresh = rows.filter((row) => !prior.has(row.caseId));
    writeFileSync(OUT, fresh.map((row) => JSON.stringify(row)).join("\n") + (fresh.length ? "\n" : ""));
    console.log(`${rows.length} filas de iTunes, ${rows.length - fresh.length} ya cubiertas por Last.fm, ${fresh.length} nuevas → ${OUT}`);
  } finally {
    client.release();
    await closeDb();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
