// CRV · Confirma el género principal que eligió Laya (Brian, 2026-09-27: lo
// que elija Laya se confirma directo, como las fuentes).
//
// Lee las predicciones de scripts/run-laya-dossiers.py y confirma solo las que
// superan el umbral de probabilidad (0,75 por omisión: en la muestra revisada
// a mano del 2026-09-27, ~93 % de acierto por encima y errores claros por
// debajo). Nunca toca una ficha que ya tenga principal confirmado ni una
// decisión humana. Todo queda en un run, a nombre de `auto:laya`, reversible.
// Sin --confirm corre entero y se deshace.
import { readFileSync, writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";
import { confirmGenre } from "../src/genres/human.js";
import type { GenreEntityKind } from "../src/genres/rules.js";
import { GENRE_COLUMN, GENRE_TABLE, lockGenres } from "../src/genres/store.js";

const PREDICTIONS = process.env["LAYA_OUTPUT"] ?? "reports/genre-laya-dossiers-predictions-2026-09-27.jsonl";
const DOSSIERS = process.env["LAYA_INPUT"] ?? "reports/genre-laya-dossiers-2026-09-27.jsonl";

interface Prediction { caseId: string; kind: GenreEntityKind; entityId: number; status: string; primaryGenre: string | null; probability: number | null; promptVersion?: string }

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const threshold = Number(process.argv.find((arg) => arg.startsWith("--min="))?.slice(6) ?? "0.75");
  const read = <T>(file: string): T[] => readFileSync(file, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as T);
  const dossiers = new Map(read<{ caseId: string; evidence: Array<{ ref: string; source: string; url: string | null }> }>(DOSSIERS).map((row) => [row.caseId, row]));
  const predictions = read<Prediction>(PREDICTIONS);

  const report = {
    mode: confirm ? "confirm" : "dry-run", threshold, runId: 0, predictions: predictions.length,
    accepted: [] as Array<{ caseId: string; genre: string; probability: number }>,
    belowThreshold: 0, abstained: 0, errors: 0, alreadyClassified: 0, failed: [] as Array<{ caseId: string; error: string }>,
  };
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await lockGenres(client);
    const run = await client.query<{ id: string }>(
      `INSERT INTO ingest.scrape_runs(kind, status, params) VALUES('merge_run','running',$1::jsonb) RETURNING id::text`,
      [JSON.stringify({ action: "genres_laya_accept", threshold, predictions: PREDICTIONS, confirm })]);
    report.runId = Number(run.rows[0]!.id);
    for (const row of predictions) {
      if (row.status === "abstained") { report.abstained += 1; continue; }
      if (row.status !== "suggested" || !row.primaryGenre) { report.errors += 1; continue; }
      if ((row.probability ?? 0) < threshold) { report.belowThreshold += 1; continue; }
      const has = await client.query(
        `SELECT 1 FROM ${GENRE_TABLE[row.kind]} WHERE ${GENRE_COLUMN[row.kind]}=$1 AND role='primary' AND status='confirmed'`, [row.entityId]);
      if (has.rowCount) { report.alreadyClassified += 1; continue; }
      const sources = (dossiers.get(row.caseId)?.evidence ?? []).filter((item) => item.url).map((item) => `${item.source} ${item.url}`);
      const reason = `Laya eligió ${row.primaryGenre} (p=${row.probability?.toFixed(2)}) con el texto propio: ${sources.slice(0, 2).join(" · ") || "biografía"} (último recurso; run ${report.runId})`;
      await client.query("SAVEPOINT ficha");
      try {
        await confirmGenre(client, { kind: row.kind, entityId: row.entityId, genreSlug: row.primaryGenre, actor: "auto:laya", reason, role: "primary", runId: report.runId });
        await client.query("RELEASE SAVEPOINT ficha");
        report.accepted.push({ caseId: row.caseId, genre: row.primaryGenre, probability: row.probability! });
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT ficha");
        report.failed.push({ caseId: row.caseId, error: (error as Error).message });
      }
    }
    await client.query(`UPDATE ingest.scrape_runs SET status=$2::ingest.run_status, finished_at=now() WHERE id=$1`,
      [report.runId, report.failed.length ? "partial" : "ok"]);
    await client.query(confirm ? "COMMIT" : "ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const out = `reports/genres-laya-accept-${report.mode}-${(PREDICTIONS.match(/-(v\d+)-/u)?.[1] ?? "v1") + "-"}2026-09-27.json`;
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`genres laya-accept (${report.mode}, run ${report.runId}, umbral ${threshold}): ${report.predictions} predicciones`);
  console.log(`  confirmadas: ${report.accepted.length} · bajo el umbral: ${report.belowThreshold} · abstenciones: ${report.abstained} · ya tenían principal: ${report.alreadyClassified} · errores: ${report.errors + report.failed.length}`);
  console.log(`  detalle: ${out}`);
  await closeDb();
}

main().catch(async (error) => { console.error(error); await closeDb(); process.exit(1); });
