// CRV · La fuente manda sobre Laya (regla de Brian, 2026-09-26/27: Laya es el
// último recurso). Si una ficha quedó con principal elegido por Laya y después
// apareció una fuente que nombra un género reconocido, se deshace lo de Laya
// para que scripts/apply-source-genres.ts aplique el de la fuente.
//
// Uso: tsx scripts/source-over-laya.ts --ledger=<ruta> [--ledger=…] [--confirm]
// Todo en un run reversible. Sin --confirm corre entero y se deshace.
import { readFileSync, writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";
import { revertGenreDecision } from "../src/genres/human.js";
import type { GenreEntityKind } from "../src/genres/rules.js";
import { GENRE_COLUMN, GENRE_TABLE, loadTaxonomy, lockGenres } from "../src/genres/store.js";
import { resolveGenreValue } from "../src/genres/taxonomy.js";
import { SKIP_SOURCE_ROWS } from "./genre-source-skip.js";

/** Revisados a mano el 2026-09-27: King Changó es ska latino; «Latin» y el ska de Laya dicen lo mismo. */
const KEEP_LAYA = new Set(["album:208", "album:209"]);

interface Row { caseId: string; kind: GenreEntityKind; entityId: number; source: string; rawGenre?: string; rawGenres?: string[]; genres?: Array<{ label: string }> }

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const ledgers = process.argv.filter((arg) => arg.startsWith("--ledger=")).map((arg) => arg.slice(9));
  if (!ledgers.length) throw new Error("falta --ledger=<ruta>");
  const rows = new Map<string, Row>();
  for (const path of ledgers) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as Row;
      if (row.kind && row.entityId && !rows.has(row.caseId) && !SKIP_SOURCE_ROWS.has(`${row.source}|${row.caseId}`)) rows.set(row.caseId, row);
    }
  }
  const client = await getPool().connect();
  const report = { mode: confirm ? "confirm" : "dry-run", runId: 0, compatible: 0, reverted: [] as Array<{ caseId: string; source: string; laya: string[]; raw: string[] }> };
  try {
    await client.query("BEGIN");
    await lockGenres(client);
    const taxonomy = await loadTaxonomy(client);
    const run = await client.query<{ id: string }>(
      `INSERT INTO ingest.scrape_runs(kind, status, params) VALUES('merge_run','running',$1::jsonb) RETURNING id::text`,
      [JSON.stringify({ action: "genres_source_over_laya", ledgers, confirm })]);
    report.runId = Number(run.rows[0]!.id);
    for (const row of rows.values()) {
      const laya = (await client.query<{ slug: string; role: string }>(`
        SELECT g.slug, x.role FROM ${GENRE_TABLE[row.kind]} x JOIN ingest.genres g ON g.id=x.genre_id
         WHERE x.${GENRE_COLUMN[row.kind]}=$1 AND x.decided_by='auto:laya' AND x.status='confirmed' ORDER BY x.role`, [row.entityId])).rows;
      if (!laya.some((item) => item.role === "primary") || KEEP_LAYA.has(row.caseId)) continue;
      const raw = row.rawGenre ? [row.rawGenre] : row.rawGenres ?? (row.genres ?? []).map((genre) => genre.label);
      const named = new Set(raw.flatMap((value) => resolveGenreValue(taxonomy, value.replace(/\bpop\s*\/\s*rock\b/giu, "pop rock"))
        .items.flatMap((item) => item.kind === "genre" ? [item.genreId] : [])));
      if (!named.size) continue;
      // Sin contradicción no se toca: la fuente nombra lo mismo que Laya, o solo
      // su familia («Rock» y Laya eligió indie rock, que es más preciso).
      const primary = [...taxonomy.genres.values()].find((genre) => genre.slug === laya.find((item) => item.role === "primary")!.slug)!;
      if (named.has(primary.id) || (primary.parentId !== null && named.has(primary.parentId))) { report.compatible += 1; continue; }
      for (const item of laya) {
        await revertGenreDecision(client, {
          kind: row.kind, entityId: row.entityId, genreSlug: item.slug, actor: "auto:fuente-sobre-laya",
          reason: `${row.source} nombra «${raw.join(" | ")}»: la fuente manda sobre Laya (run ${report.runId})`, runId: report.runId,
        });
      }
      report.reverted.push({ caseId: row.caseId, source: row.source, laya: laya.map((item) => item.slug), raw });
    }
    await client.query(`UPDATE ingest.scrape_runs SET status='ok', finished_at=now() WHERE id=$1`, [report.runId]);
    await client.query(confirm ? "COMMIT" : "ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const out = `reports/genres-source-over-laya-${report.mode}-2026-09-27.json`;
  const payload = JSON.stringify(report, null, 2);
  writeFileSync(out, payload);
  writeFileSync(out.replace(/\.json$/u, `-run-${report.runId}.json`), payload);
  console.log(`fuente sobre Laya (${report.mode}, run ${report.runId}): ${report.reverted.length} fichas contradicen a Laya · ${report.compatible} compatibles (se deja a Laya)`);
  for (const item of report.reverted) console.log(`  ${item.caseId} ${item.source}: ${item.laya.join(",")} ← «${item.raw.join(" | ")}»`);
  await closeDb();
}

main().catch(async (error) => { console.error(error); await closeDb(); process.exit(1); });
