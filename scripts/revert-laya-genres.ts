// CRV · Deshace lo que Laya decidió en fichas concretas cuya elección resultó
// mal fundada (p. ej. «power trio» leído como power metal), sin tocar el resto
// de su run. La ficha vuelve a quedar sin principal y la próxima fuente o pasada
// de Laya la puede clasificar. Nunca toca decisiones de personas ni de fuentes.
// `--actor=auto:<fuente>` deshace en cambio lo de esa fuente (p. ej. Last.fm
// cuando la página resultó ser de un homónimo extranjero).
//
// Uso: tsx scripts/revert-laya-genres.ts --case=album:553 [--case=…] --reason="…" [--actor=auto:laya] [--confirm]
// Todo en un run reversible. Sin --confirm corre entero y se deshace.
import { writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";
import { revertGenreDecision } from "../src/genres/human.js";
import type { GenreEntityKind } from "../src/genres/rules.js";
import { GENRE_COLUMN, GENRE_TABLE, lockGenres } from "../src/genres/store.js";

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const cases = process.argv.filter((arg) => arg.startsWith("--case=")).map((arg) => arg.slice("--case=".length));
  const reason = process.argv.find((arg) => arg.startsWith("--reason="))?.slice("--reason=".length).trim() ?? "";
  const actor = process.argv.find((arg) => arg.startsWith("--actor="))?.slice("--actor=".length).trim() ?? "auto:laya";
  if (!/^auto:[a-z0-9-]+$/u.test(actor) || actor === "auto:crv-operador") throw new Error(`--actor debe ser una decisión automática: ${actor}`);
  if (!cases.length || !reason) throw new Error("uso: --case=<album|artist>:<id> (repetible) --reason=\"…\" [--confirm]");
  const client = await getPool().connect();
  const report = { mode: confirm ? "confirm" : "dry-run", runId: 0, reason, reverted: [] as Array<{ caseId: string; genres: string[] }>, untouched: [] as string[] };
  try {
    await client.query("BEGIN");
    await lockGenres(client);
    const run = await client.query<{ id: string }>(
      `INSERT INTO ingest.scrape_runs(kind, status, params) VALUES('merge_run','running',$1::jsonb) RETURNING id::text`,
      [JSON.stringify({ action: "genres_laya_revert", actor, cases, reason, confirm })]);
    report.runId = Number(run.rows[0]!.id);
    for (const caseId of cases) {
      const [kind, id] = caseId.split(":") as [GenreEntityKind, string];
      if (!(kind in GENRE_TABLE) || !/^\d+$/u.test(id)) throw new Error(`ficha inválida: ${caseId}`);
      const laya = (await client.query<{ slug: string }>(`
        SELECT g.slug FROM ${GENRE_TABLE[kind]} x JOIN ingest.genres g ON g.id=x.genre_id
         WHERE x.${GENRE_COLUMN[kind]}=$1 AND x.decided_by=$2 AND x.status IN ('confirmed','superseded') ORDER BY x.role`, [Number(id), actor])).rows;
      if (!laya.length) { report.untouched.push(caseId); continue; }
      for (const item of laya) {
        await revertGenreDecision(client, { kind, entityId: Number(id), genreSlug: item.slug, actor: `${actor}-revision`,
          reason: `${reason} (run ${report.runId})`, runId: report.runId });
      }
      report.reverted.push({ caseId, genres: laya.map((item) => item.slug) });
    }
    await client.query(`UPDATE ingest.scrape_runs SET status='ok', finished_at=now() WHERE id=$1`, [report.runId]);
    await client.query(confirm ? "COMMIT" : "ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  writeFileSync(`reports/genres-${actor.slice("auto:".length)}-revert-${report.mode}-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(report, null, 2));
  console.log(`${actor} deshecho (${report.mode}, run ${report.runId}): ${report.reverted.length} fichas · ${report.untouched.length} sin decisión de ${actor}`);
  for (const item of report.reverted) console.log(`  ${item.caseId}: ${item.genres.join(",")}`);
  await closeDb();
}

main().catch(async (error) => { console.error(error); await closeDb(); process.exit(1); });
