// CRV · Rehace las fichas cuyo principal `auto:<fuente>` salió del orden
// defectuoso de apply-source-genres (corregido el 2026-09-27): cuando la fuente
// nombraba un género antes que su familia, otro término subía a principal
// («black metal | ambient | metal» → ambient).
//
// Recorre los principales confirmados por la regla «una fuente basta», busca
// en reports/ la fila del libro que los produjo (misma fuente, ficha y texto
// crudo) y rehace la ficha solo si el orden defectuoso da exactamente su
// principal actual y el corregido da otro: lo que cambió por términos nuevos de
// la taxonomía no es este fallo. Tampoco toca listas en orden alfabético
// (Deezer, Lobotoradio, MusicBrainz con votos empatados): ahí el primero no es
// el principal de la fuente y ningún orden lo mejora; se listan aparte.
// Rehacer = deshacer las decisiones de esa fuente en la ficha y volver a
// aplicarlas con scripts/genre-source-rows.ts.
// Nunca toca decisiones de personas ni de Laya. Todo en un run reversible.
// Uso: tsx scripts/fix-source-genre-order.ts [--confirm]
import { writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";
import { revertGenreDecision } from "../src/genres/human.js";
import type { GenreEntityKind } from "../src/genres/rules.js";
import { GENRE_COLUMN, GENRE_TABLE, loadTaxonomy, lockGenres } from "../src/genres/store.js";
import type { Taxonomy } from "../src/genres/taxonomy.js";
import { applySourceRow, inAlphabeticalOrder, ledgerIndex, ledgerRowFor, rawValues, resolvedSlugs, sourceSlugs } from "./genre-source-rows.js";

/** El orden defectuoso: movía el hijo al puesto de su familia aunque el hijo fuera antes. */
function defectiveOrder(taxonomy: Taxonomy, slugs: string[]): string[] {
  const idOf = (slug: string): number => [...taxonomy.genres.values()].find((g) => g.slug === slug)!.id;
  const out = [...slugs];
  for (let index = 0; index < out.length; index += 1) {
    const child = out.find((other) => taxonomy.genres.get(idOf(other))?.parentId === idOf(out[index]!));
    if (child) { out.splice(out.indexOf(child), 1); out[index] = child; index = -1; }
  }
  return out;
}

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const ledgerRows = ledgerIndex();

  const client = await getPool().connect();
  const report = { mode: confirm ? "confirm" : "dry-run", runId: 0, checked: 0, withoutLedgerRow: 0,
    alphabetical: [] as Array<{ caseId: string; source: string; current: string; corrected: string; raw: string[] }>,
    fixed: [] as Array<{ caseId: string; source: string; before: string; after: string; secondaries: string[]; raw: string[] }>,
    errors: [] as Array<{ caseId: string; error: string }> };
  try {
    await client.query("BEGIN");
    await lockGenres(client);
    const taxonomy = await loadTaxonomy(client);
    const run = await client.query<{ id: string }>(
      `INSERT INTO ingest.scrape_runs(kind, status, params) VALUES('merge_run','running',$1::jsonb) RETURNING id::text`,
      [JSON.stringify({ action: "genres_source_order_fix", confirm })]);
    report.runId = Number(run.rows[0]!.id);

    for (const kind of ["artist", "album"] as GenreEntityKind[]) {
      const primaries = (await client.query<{ entity_id: string; slug: string; decided_by: string; decision_note: string }>(`
        SELECT x.${GENRE_COLUMN[kind]}::text AS entity_id, g.slug, x.decided_by, x.decision_note
          FROM ${GENRE_TABLE[kind]} x JOIN ingest.genres g ON g.id=x.genre_id
         WHERE x.role='primary' AND x.status='confirmed' AND x.decided_by LIKE 'auto:%' AND x.decided_by<>'auto:laya'
           AND x.decision_note LIKE '%una fuente basta%'`)).rows;
      for (const primary of primaries) {
        report.checked += 1;
        const source = primary.decided_by.slice("auto:".length);
        const caseId = `${kind}:${primary.entity_id}`;
        const row = ledgerRowFor(ledgerRows, caseId, primary.decided_by, primary.decision_note);
        if (!row) { report.withoutLedgerRow += 1; continue; }
        const { slugs } = sourceSlugs(taxonomy, row);
        const after = slugs[0];
        if (!after || after === primary.slug || defectiveOrder(taxonomy, resolvedSlugs(taxonomy, row).slugs)[0] !== primary.slug) continue;
        if (inAlphabeticalOrder(row)) {
          report.alphabetical.push({ caseId, source, current: primary.slug, corrected: after, raw: rawValues(row) });
          continue;
        }

        await client.query("SAVEPOINT ficha");
        try {
          const mine = (await client.query<{ slug: string }>(`
            SELECT g.slug FROM ${GENRE_TABLE[kind]} x JOIN ingest.genres g ON g.id=x.genre_id
             WHERE x.${GENRE_COLUMN[kind]}=$1 AND x.decided_by=$2 AND x.status IN ('confirmed','superseded')
             ORDER BY x.role`, [row.entityId, primary.decided_by])).rows;
          for (const item of mine) {
            await revertGenreDecision(client, { kind, entityId: row.entityId, genreSlug: item.slug, actor: "auto:orden-fuente",
              reason: `orden corregido de ${source}: «${rawValues(row).join(" | ")}» da ${after} de principal, no ${primary.slug} (run ${report.runId})`, runId: report.runId });
          }
          const outcome = await applySourceRow(client, taxonomy, row, report.runId, "regla: una fuente basta; orden corregido");
          if (outcome.kind !== "accepted") throw new Error(`la fila ya no aplica (${outcome.kind})`);
          await client.query("RELEASE SAVEPOINT ficha");
          report.fixed.push({ caseId, source, before: primary.slug, after: outcome.primary, secondaries: outcome.secondaries, raw: outcome.raw });
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT ficha");
          report.errors.push({ caseId, error: (error as Error).message });
        }
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
  writeFileSync(`reports/genres-source-order-fix-${report.mode}-2026-09-27.json`, JSON.stringify(report, null, 2));
  console.log(`orden de fuentes (${report.mode}, run ${report.runId}): ${report.checked} principales revisados · ${report.withoutLedgerRow} sin fila de libro · ${report.fixed.length} rehechos · ${report.alphabetical.length} en lista alfabética (sin tocar) · ${report.errors.length} errores`);
  for (const item of report.fixed) console.log(`  ${item.caseId} ${item.source}: ${item.before} → ${item.after} (+${item.secondaries.join(",") || "—"}) ← «${item.raw.join(" | ")}»`);
  for (const item of report.alphabetical) console.log(`  alfabética, se deja ${item.caseId} ${item.source}: ${item.current} (el orden corregido daría ${item.corrected}) ← «${item.raw.join(" | ")}»`);
  for (const item of report.errors) console.log(`  ERROR ${item.caseId}: ${item.error}`);
  await closeDb();
}

main().catch(async (error) => { console.error(error); await closeDb(); process.exit(1); });
