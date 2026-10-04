// Revisiones del ER repetidas: cada reintento de merge abría otra revisión
// abierta para el mismo claim y tipo (una por decisión del ER). Deja abierta
// la más antigua, le copia la decisión más reciente y cierra las demás como
// `dismissed`, en un run del diario.
//
//   tsx scripts/dedupe-er-reviews.ts                         # ensayo
//   tsx scripts/dedupe-er-reviews.ts --confirm --note="…"
import { closeDb, getDb, getPool } from "../src/db/client.js";
import { bindRun } from "../src/db/run-binding.js";
import { scrapeRuns } from "../src/db/schema/ingest.js";
import { finishRun } from "../src/ingest/runs.js";

const arg = (name: string) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);

const DUPLICATES = `
  WITH open AS (
    SELECT id, claim_a_id, kind,
           first_value(id) OVER w AS keep_id,
           last_value(id) OVER (PARTITION BY claim_a_id, kind ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS newest_id
      FROM ingest.review_queue
     WHERE status IN ('open','in_progress') AND claim_a_id IS NOT NULL AND payload ? 'resolutionDecisionId'
    WINDOW w AS (PARTITION BY claim_a_id, kind ORDER BY id))
  SELECT id, keep_id, newest_id, kind::text FROM open WHERE id <> keep_id`;

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const note = arg("note") ?? "Revisión repetida: el reintento de promoción abrió otra para el mismo claim";
  const pool = getPool();
  const { rows } = await pool.query<{ id: string; keep_id: string; newest_id: string; kind: string }>(DUPLICATES);
  const byKind: Record<string, number> = {};
  for (const row of rows) byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
  const kept = new Set(rows.map((row) => row.keep_id)).size;
  let runId: number | undefined;
  if (confirm && rows.length > 0) {
    const [run] = await getDb().insert(scrapeRuns).values({ kind: "manual", status: "running", params: { action: "dedupe-er-reviews", note } }).returning();
    if (!run) throw new Error("no se pudo abrir el run");
    runId = run.id;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await bindRun(client, run.id);
      // La que queda abierta recibe la decisión más reciente del ER.
      await client.query(`
        UPDATE ingest.review_queue k
           SET payload=n.payload, priority=n.priority, person_a_id=n.person_a_id, organization_a_id=n.organization_a_id,
               album_id=n.album_id, track_id=n.track_id, artist_a_id=n.artist_a_id, updated_at=now()
          FROM (SELECT DISTINCT keep_id::bigint, newest_id::bigint FROM (${DUPLICATES}) d) d
          JOIN ingest.review_queue n ON n.id=d.newest_id
         WHERE k.id=d.keep_id AND k.payload IS DISTINCT FROM n.payload`);
      await client.query(`
        UPDATE ingest.review_queue SET status='dismissed', resolved_by='human', resolution_note=$2, resolved_at=now(), updated_at=now()
         WHERE id = ANY($1::bigint[])`, [rows.map((row) => Number(row.id)), `[run ${run.id}] ${note}`]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await finishRun(run.id, "ok", { closed: rows.length, kept });
  }
  console.log(JSON.stringify({ dryRun: !confirm, runId, duplicates: rows.length, claims: kept, byKind }, null, 2));
}

main().then(() => closeDb()).then(() => process.exit(0), async (error) => {
  console.error(error);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
