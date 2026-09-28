// CRV · Confirma en bloque los géneros que una fuente de internet ya nombra
// (regla de Brian del 2026-09-26: si una fuente dice el género y la ficha no
// lo tiene, entra directo; sin umbral, sin Laya, sin revisión ficha a ficha).
//
// Lee los libros de evidencia de reports/ (Sincopa, Rock De Vzla, Rockzuela,
// Wikidata, La Venciclopedia), resuelve el texto crudo con la taxonomía y confirma: el primer
// género nombrado es el principal y el resto secundarios. Nunca toca una ficha
// que ya tenga principal confirmado. Todo queda en un run, a nombre de
// `auto:<fuente>`, reversible por run. Sin --confirm corre entero y se deshace.
import { existsSync, writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";
import { GENRE_COLUMN, GENRE_TABLE, loadTaxonomy, lockGenres } from "../src/genres/store.js";
import { applySourceRow, readLedger, type LedgerRow } from "./genre-source-rows.js";
import { SKIP_SOURCE_ROWS } from "./genre-source-skip.js";

const DATE = "2026-09-26";
// `--ledger=ruta` (repetible) aplica solo esos libros, en ese orden: el primero
// que nombra una ficha manda. Sin él, los libros de siempre.
const EXTRA = process.argv.filter((arg) => arg.startsWith("--ledger=")).map((arg) => arg.slice("--ledger=".length));
const LEDGERS = (EXTRA.length ? EXTRA : [
  "sincopa", "sincopa-albums-discovered", "sincopa-artists", "sincopa-artists-discovered",
  "rockdevzla-artists", "rockzuela-artists", "wikidata-artists", "venciclopedia", "sincopa-audit",
  "lobotoradio-artists", "claims-pending", "band-phrases", "local-recovered",
].map((name) => `reports/genre-laya-evidence-${name}-${DATE}.jsonl`)).filter((path) => existsSync(path));
const REPORT_DATE = EXTRA.length ? new Date().toISOString().slice(0, 10) : DATE;

async function main(): Promise<number> {
  const confirm = process.argv.includes("--confirm");
  const rows = new Map<string, LedgerRow>();
  for (const path of LEDGERS) {
    for (const row of readLedger(path)) {
      if (SKIP_SOURCE_ROWS.has(`${row.source}|${row.caseId}`) || rows.has(row.caseId)) continue;
      rows.set(row.caseId, row);
    }
  }

  const client = await getPool().connect();
  const report = {
    mode: confirm ? "confirm" : "dry-run", runId: 0, candidates: rows.size,
    accepted: [] as Array<{ caseId: string; title: string | undefined; source: string; raw: string[]; primary: string; secondaries: string[] }>,
    alreadyClassified: [] as string[],
    unresolved: [] as Array<{ caseId: string; source: string; raw: string[]; fragments: string[] }>,
    errors: [] as Array<{ caseId: string; error: string }>,
    moreSpecificExists: [] as Array<{ caseId: string; raw: string[] }>,
  };
  try {
    await client.query("BEGIN");
    await lockGenres(client);
    const taxonomy = await loadTaxonomy(client);
    const run = await client.query<{ id: string }>(
      `INSERT INTO ingest.scrape_runs(kind, status, params) VALUES('merge_run','running',$1::jsonb) RETURNING id::text`,
      [JSON.stringify({ action: "genres_source_accept", ledgers: LEDGERS, confirm })]);
    report.runId = Number(run.rows[0]!.id);

    for (const row of rows.values()) {
      const has = await client.query(
        `SELECT 1 FROM ${GENRE_TABLE[row.kind]} WHERE ${GENRE_COLUMN[row.kind]}=$1 AND role='primary' AND status='confirmed'`,
        [row.entityId]);
      if (has.rowCount) { report.alreadyClassified.push(row.caseId); continue; }

      await client.query("SAVEPOINT ficha");
      try {
        const outcome = await applySourceRow(client, taxonomy, row, report.runId);
        await client.query("RELEASE SAVEPOINT ficha");
        if (outcome.kind === "unresolved") report.unresolved.push({ caseId: row.caseId, source: row.source, raw: outcome.raw, fragments: outcome.fragments });
        else if (outcome.kind === "moreSpecificExists") report.moreSpecificExists.push({ caseId: row.caseId, raw: outcome.raw });
        else report.accepted.push({ caseId: row.caseId, title: row.title, source: row.source, raw: outcome.raw, primary: outcome.primary, secondaries: outcome.secondaries });
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT ficha");
        report.errors.push({ caseId: row.caseId, error: (error as Error).message });
      }
    }

    await client.query(`UPDATE ingest.scrape_runs SET status=$2::ingest.run_status, finished_at=now() WHERE id=$1`,
      [report.runId, report.errors.length ? "partial" : "ok"]);
    await client.query(confirm ? "COMMIT" : "ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const out = `reports/genres-source-accept-${report.mode}-${REPORT_DATE}${EXTRA.length ? "-ledgers" : ""}.json`;
  const payload = JSON.stringify(report, null, 2);
  writeFileSync(out, payload);
  writeFileSync(out.replace(/\.json$/u, `-run-${report.runId}.json`), payload);
  const bySource = new Map<string, number>();
  for (const entry of report.accepted) bySource.set(entry.source, (bySource.get(entry.source) ?? 0) + 1);
  console.log(`genres source-accept (${report.mode}, run ${report.runId}): ${report.candidates} fichas en los libros`);
  console.log(`  confirmadas: ${report.accepted.length} ${JSON.stringify(Object.fromEntries(bySource))}`);
  console.log(`  ya tenían principal: ${report.alreadyClassified.length} · sin término en la taxonomía: ${report.unresolved.length} · con hijo más preciso: ${report.moreSpecificExists.length} · errores: ${report.errors.length}`);
  console.log(`  detalle: ${out}`);
  return 0;
}

main().then((code) => closeDb().then(() => process.exit(code)), async (error) => {
  console.error(error);
  await closeDb();
  process.exit(1);
});
