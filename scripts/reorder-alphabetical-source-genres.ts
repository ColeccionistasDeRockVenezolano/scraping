// Laya elige el principal de listas que la fuente ordenó alfabéticamente.
// --export produce expedientes; sin --confirm ensaya la aplicación y revierte.
import { readFileSync, writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";
import { revertGenreDecision } from "../src/genres/human.js";
import type { GenreEntityKind } from "../src/genres/rules.js";
import { GENRE_COLUMN, GENRE_TABLE, loadTaxonomy, lockGenres } from "../src/genres/store.js";
import { applySourceRow, inAlphabeticalOrder, ledgerIndex, ledgerRowFor, rawValues, sourceSlugs } from "./genre-source-rows.js";

const CASES = "reports/genre-source-alphabetical-cases-2026-09-27.jsonl";
const PREDICTIONS = "reports/genre-source-alphabetical-predictions-2026-09-27.jsonl";

async function main(): Promise<void> {
  const client = await getPool().connect();
  const exportOnly = process.argv.includes("--export");
  const confirm = process.argv.includes("--confirm");
  const index = ledgerIndex();
  const cases: Array<{ caseId: string; kind: GenreEntityKind; entityId: number; title: string; source: string; current: string; raw: string[]; candidates: Array<{ slug: string; name: string; family: string | null }> }> = [];
  const rowsById = new Map<string, ReturnType<typeof ledgerRowFor>>();
  try {
    const taxonomy = await loadTaxonomy(client);
    for (const kind of ["artist", "album"] as const) {
      const rows = (await client.query<{ entity_id: string; slug: string; decided_by: string; decision_note: string; title: string }>(`
        SELECT x.${GENRE_COLUMN[kind]}::text AS entity_id, g.slug, x.decided_by, x.decision_note,
               ${kind === "artist" ? "ar.name" : "ar.name || ' — ' || al.title"} AS title
          FROM ${GENRE_TABLE[kind]} x JOIN ingest.genres g ON g.id=x.genre_id
          ${kind === "artist" ? "JOIN public.artists ar ON ar.id=x.artist_id" : "JOIN public.albums al ON al.id=x.album_id JOIN public.artists ar ON ar.id=al.artist_id"}
         WHERE x.role='primary' AND x.status='confirmed' AND x.decided_by LIKE 'auto:%' AND x.decided_by<>'auto:laya'
           AND x.decision_note LIKE '%una fuente basta%'`)).rows;
      for (const item of rows) {
        const caseId = `${kind}:${item.entity_id}`;
        const row = ledgerRowFor(index, caseId, item.decided_by, item.decision_note);
        if (!row || !inAlphabeticalOrder(row)) continue;
        const slugs = sourceSlugs(taxonomy, row).slugs;
        if (slugs.length < 2 || !slugs.includes(item.slug)) continue;
        cases.push({ caseId, kind, entityId: Number(item.entity_id), title: item.title,
          source: row.source, current: item.slug, raw: rawValues(row),
          candidates: slugs.map((slug) => { const g = taxonomy.bySlug.get(slug)!;
            return { slug, name: g.name, family: g.parentId === null ? null : taxonomy.genres.get(g.parentId)?.name ?? null }; }) });
        rowsById.set(caseId, row);
      }
    }
    if (exportOnly) {
      writeFileSync(CASES, cases.map((row) => JSON.stringify(row)).join("\n") + (cases.length ? "\n" : ""));
      console.log(`${cases.length} expedientes → ${CASES}`);
      return;
    }
    const predictions = readFileSync(PREDICTIONS, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { caseId: string; primaryGenre: string | null; status: string });
    const selected = new Map(predictions.map((row) => [row.caseId, row]));
    const report = { mode: confirm ? "confirm" : "dry-run", runId: 0, cases: cases.length,
      changed: [] as Array<{ caseId: string; before: string; after: string }>, abstained: 0, unchanged: 0,
      errors: [] as Array<{ caseId: string; error: string }> };
    await client.query("BEGIN");
    await lockGenres(client);
    const run = await client.query<{ id: string }>(`INSERT INTO ingest.scrape_runs(kind,status,params) VALUES('merge_run','running',$1::jsonb) RETURNING id::text`,
      [JSON.stringify({ action: "genres_alphabetical_order", confirm, predictions: PREDICTIONS })]);
    report.runId = Number(run.rows[0]!.id);
    for (const item of cases) {
      const prediction = selected.get(item.caseId);
      if (!prediction || prediction.status !== "suggested" || !prediction.primaryGenre) { report.abstained++; continue; }
      if (!item.candidates.some((candidate) => candidate.slug === prediction.primaryGenre)) {
        report.errors.push({ caseId: item.caseId, error: `opción ajena: ${prediction.primaryGenre}` }); continue;
      }
      if (prediction.primaryGenre === item.current) { report.unchanged++; continue; }
      const row = rowsById.get(item.caseId)!;
      await client.query("SAVEPOINT ficha");
      try {
        const mine = (await client.query<{ slug: string }>(`
          SELECT g.slug FROM ${GENRE_TABLE[item.kind]} x JOIN ingest.genres g ON g.id=x.genre_id
           WHERE x.${GENRE_COLUMN[item.kind]}=$1 AND x.decided_by=$2 AND x.status IN ('confirmed','superseded')`,
          [item.entityId, `auto:${item.source}`])).rows;
        for (const genre of mine) await revertGenreDecision(client, { kind: item.kind, entityId: item.entityId,
          genreSlug: genre.slug, actor: "auto:orden-alfabetico", reason: `Laya eligió ${prediction.primaryGenre} entre los géneros de ${item.source} (run ${report.runId})`, runId: report.runId });
        const outcome = await applySourceRow(client, taxonomy, row, report.runId, "principal elegido por Laya entre la lista alfabética", prediction.primaryGenre);
        if (outcome.kind !== "accepted") throw new Error(`fila no aplicable: ${outcome.kind}`);
        await client.query("RELEASE SAVEPOINT ficha");
        report.changed.push({ caseId: item.caseId, before: item.current, after: outcome.primary });
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT ficha");
        report.errors.push({ caseId: item.caseId, error: (error as Error).message });
      }
    }
    await client.query(`UPDATE ingest.scrape_runs SET status=$2::ingest.run_status, finished_at=now() WHERE id=$1`,
      [report.runId, report.errors.length ? "partial" : "ok"]);
    await client.query(confirm ? "COMMIT" : "ROLLBACK");
    const out = `reports/genres-source-alphabetical-${report.mode}-2026-09-27.json`;
    writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(`${report.mode}: ${report.changed.length} reordenadas, ${report.unchanged} iguales, ${report.abstained} abstenciones, ${report.errors.length} errores → ${out}`);
  } catch (error) {
    if (!exportOnly) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await closeDb();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
