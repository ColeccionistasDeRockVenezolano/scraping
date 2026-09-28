// CRV · Confirma los secundarios que Discogs dejó como sugerencia en discos que
// ya tenían principal (Brian, 2026-09-28: «una fuente basta» también para ellos).
// `crv genres external accept` los salta porque la ficha ya tiene principal;
// aquí solo se confirman como secundarios, sin tocar el principal.
//
// No entra: una familia cuyo hijo ya está asignado (confirmGenre la rechaza) ni
// una ficha con decisión de una persona (herra:* o crv-operador).
//
// Uso: tsx scripts/confirm-discogs-secondaries.ts [--confirm]
// Todo en un run reversible. Sin --confirm corre entero y se deshace.
import { writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";
import { confirmGenre } from "../src/genres/human.js";
import { lockGenres } from "../src/genres/store.js";

const PERSON_ACTOR = `(decided_by LIKE 'herra:%' OR decided_by = 'auto:crv-operador')`;

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const client = await getPool().connect();
  const report = {
    mode: confirm ? "confirm" : "dry-run", runId: 0, candidates: 0,
    confirmed: [] as Array<{ albumId: number; title: string; slug: string }>,
    skipped: [] as Array<{ albumId: number; title: string; slug: string; reason: string }>,
  };
  try {
    await client.query("BEGIN");
    await lockGenres(client);
    const run = await client.query<{ id: string }>(
      `INSERT INTO ingest.scrape_runs(kind, status, params) VALUES('merge_run','running',$1::jsonb) RETURNING id::text`,
      [JSON.stringify({ action: "genres_discogs_secondaries", confirm })]);
    report.runId = Number(run.rows[0]!.id);
    const { rows } = await client.query<{ album_id: string; title: string; slug: string; person: boolean }>(`
      SELECT g.album_id::text, a.title, t.slug,
             EXISTS (SELECT 1 FROM ingest.album_genres h WHERE h.album_id = g.album_id AND ${PERSON_ACTOR}) AS person
        FROM ingest.album_genres g
        JOIN ingest.genres t ON t.id = g.genre_id
        JOIN public.albums a ON a.id = g.album_id
       WHERE g.decided_by = 'externa:discogs' AND g.status = 'suggested' AND t.active
       ORDER BY g.album_id, g.id`);
    report.candidates = rows.length;
    const reason = `Discogs nombra el género; una fuente basta (Brian, 2026-09-28) (run ${report.runId})`;
    for (const row of rows) {
      const albumId = Number(row.album_id);
      if (row.person) {
        report.skipped.push({ albumId, title: row.title, slug: row.slug, reason: "ficha decidida por una persona" });
        continue;
      }
      await client.query("SAVEPOINT row");
      try {
        await confirmGenre(client, {
          kind: "album", entityId: albumId, genreSlug: row.slug, actor: "auto:discogs", reason, role: "secondary", runId: report.runId,
        });
        await client.query("RELEASE SAVEPOINT row");
        report.confirmed.push({ albumId, title: row.title, slug: row.slug });
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT row");
        report.skipped.push({ albumId, title: row.title, slug: row.slug, reason: (error as Error).message });
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
  const out = `reports/genres-discogs-secondaries-${report.mode}-2026-09-28.json`;
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`Discogs secundarios (${report.mode}, run ${report.runId}): ${report.candidates} sugerencias · ${report.confirmed.length} confirmadas · ${report.skipped.length} saltadas`);
  for (const item of report.skipped) console.log(`  album:${item.albumId} ${item.slug}: ${item.reason}`);
  await closeDb();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
