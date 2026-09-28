// CRV · Cuando una fuente nombra exactamente el principal que eligió Laya, la
// decisión pasa a nombre de la fuente (Brian, 2026-09-28): la ficha deja de
// mostrarse como «Género por Laya» porque ya no es una predicción.
//
// Solo cuenta el principal de la fuente (su primer género resuelto, con el
// orden de scripts/genre-source-rows.ts). Si la fuente solo nombra la familia
// («Rock» frente a «Crust punk») o pone el género de Laya en otro puesto, la
// ficha sigue a nombre de Laya. El género no cambia: solo el autor y la nota.
//
// Uso: tsx scripts/source-endorses-laya.ts [--confirm]
// Todo en un run reversible. Sin --confirm corre entero y se deshace.
import { writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";
import { confirmGenre } from "../src/genres/human.js";
import type { GenreEntityKind } from "../src/genres/rules.js";
import { GENRE_COLUMN, GENRE_TABLE, loadTaxonomy, lockGenres } from "../src/genres/store.js";
import { ledgerIndex, rawValues, sourceSlugs, type LedgerRow } from "./genre-source-rows.js";

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const byCase = new Map<string, LedgerRow[]>();
  for (const row of ledgerIndex().values()) {
    const list = byCase.get(row.caseId) ?? [];
    list.push(row);
    byCase.set(row.caseId, list);
  }
  const client = await getPool().connect();
  const report = {
    mode: confirm ? "confirm" : "dry-run", runId: 0, layaPrimaries: 0,
    moved: [] as Array<{ caseId: string; slug: string; source: string; raw: string[] }>,
    familyOnly: 0, notFirst: 0, noSource: 0,
  };
  try {
    await client.query("BEGIN");
    await lockGenres(client);
    const taxonomy = await loadTaxonomy(client);
    const run = await client.query<{ id: string }>(
      `INSERT INTO ingest.scrape_runs(kind, status, params) VALUES('merge_run','running',$1::jsonb) RETURNING id::text`,
      [JSON.stringify({ action: "genres_source_endorses_laya", confirm })]);
    report.runId = Number(run.rows[0]!.id);
    for (const kind of ["artist", "album"] as GenreEntityKind[]) {
      const { rows } = await client.query<{ entity_id: string; slug: string; parent: string | null }>(`
        SELECT x.${GENRE_COLUMN[kind]}::text AS entity_id, g.slug, p.slug AS parent
          FROM ${GENRE_TABLE[kind]} x JOIN ingest.genres g ON g.id = x.genre_id LEFT JOIN ingest.genres p ON p.id = g.parent_genre_id
         WHERE x.decided_by = 'auto:laya' AND x.role = 'primary' AND x.status = 'confirmed'`);
      for (const laya of rows) {
        report.layaPrimaries += 1;
        const caseId = `${kind}:${laya.entity_id}`;
        const candidates = (byCase.get(caseId) ?? []).map((row) => ({ row, slugs: sourceSlugs(taxonomy, row).slugs }));
        const match = candidates.find((item) => item.slugs[0] === laya.slug);
        if (!match) {
          if (candidates.some((item) => item.slugs.includes(laya.slug))) report.notFirst += 1;
          else if (candidates.some((item) => laya.parent !== null && item.slugs.includes(laya.parent))) report.familyOnly += 1;
          else report.noSource += 1;
          continue;
        }
        const raw = rawValues(match.row);
        await confirmGenre(client, {
          kind, entityId: Number(laya.entity_id), genreSlug: laya.slug, role: "primary", runId: report.runId,
          actor: `auto:${match.row.source}`,
          reason: `${match.row.source} nombra «${raw.join(" | ")}» en ${match.row.url ?? match.row.pages?.[0]?.url} (la fuente respalda lo que eligió Laya; run ${report.runId})`,
        });
        report.moved.push({ caseId, slug: laya.slug, source: match.row.source, raw });
      }
    }
    await client.query(`UPDATE ingest.scrape_runs SET status='ok', finished_at=now() WHERE id=$1`, [report.runId]);
    await client.query(confirm ? "COMMIT" : "ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  writeFileSync(`reports/genres-source-endorses-laya-${report.mode}-2026-09-28.json`, JSON.stringify(report, null, 2));
  const bySource = new Map<string, number>();
  for (const item of report.moved) bySource.set(item.source, (bySource.get(item.source) ?? 0) + 1);
  console.log(`fuente respalda a Laya (${report.mode}, run ${report.runId}): ${report.layaPrimaries} principales de Laya · ${report.moved.length} pasan a la fuente · ${report.familyOnly} solo familia · ${report.notFirst} no es el primero · ${report.noSource} sin fuente`);
  console.log(`  ${[...bySource].map(([source, count]) => `${source} ${count}`).join(" · ")}`);
  await closeDb();
}

main().catch(async (error) => { console.error(error); await closeDb(); process.exit(1); });
