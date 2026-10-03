// Pistas de Sincopa que la promoción no pudo crear porque su posición estaba
// ocupada (`tracks_position_uk` en los informes de promoción). Dos casos:
//
//  1. El disco del core ya tiene esa pista, con otro número: Sincopa reinicia
//     la cuenta en el CD 2 y el core numera corrido. El número de Sincopa queda
//     `superseded` y el resto de sus claims (título, duración) se aprueba sobre
//     la pista que ya existe.
//  2. La pista no está y otra ocupa su lugar (otra edición del disco): se
//     agrega al final del disco, con una nota del número que le da Sincopa.
//
// Lo que no tiene disco en el core (recopilaciones con título repetido entre
// artistas) se deja en la cola.
//
//   tsx scripts/fix-sincopa-position-collisions.ts reports/promocion-sincopa-*-run*.json            # ensayo
//   tsx scripts/fix-sincopa-position-collisions.ts --confirm --note="…" reports/…json …
import { readFileSync, writeFileSync } from "node:fs";
import { closeDb, getDb, getPool } from "../src/db/client.js";
import { bindRun, withRunScope } from "../src/db/run-binding.js";
import { scrapeRuns } from "../src/db/schema/ingest.js";
import { finishRun } from "../src/ingest/runs.js";
import { approveEntity } from "../src/review/approval.js";

const arg = (name: string) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const fold = (text: string) => text.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase().replace(/[^\p{L}\d]+/gu, " ").trim();

interface Row {
  identity_raw: string; identity_key: string; raw_page_id: string; url: string; title: string | null; num: string | null;
  num_claim_ids: string[]; album_ids: string[] | null;
}

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const note = arg("note") ?? "Sincopa: posición ocupada al promover la pista";
  const reports = process.argv.slice(2).filter((item) => !item.startsWith("--"));
  const identities = [...new Set(reports.flatMap((file) => (JSON.parse(readFileSync(file, "utf8")).errors as Array<{ kind: string; identityRaw: string; error: string }>)
    .filter((error) => error.kind === "track" && error.error.includes("tracks_position_uk")).map((error) => error.identityRaw)))];
  const pool = getPool();
  const { rows } = await pool.query<Row>(`
    SELECT c.identity_raw, c.identity_key, c.raw_page_id::text, r.url,
           max(c.raw_value #>> '{}') FILTER (WHERE c.field='title') AS title,
           max(c.raw_value #>> '{}') FILTER (WHERE c.field='track_number' AND c.status='candidate') AS num,
           array_agg(c.id::text) FILTER (WHERE c.field='track_number' AND c.status='candidate') AS num_claim_ids,
           (SELECT array_agg(DISTINCT a.album_id::text) FROM ingest.claims a
             WHERE a.raw_page_id=c.raw_page_id AND a.entity_kind='album' AND a.status='accepted' AND a.album_id IS NOT NULL) AS album_ids
      FROM ingest.claims c JOIN ingest.raw_pages r ON r.id=c.raw_page_id
     WHERE c.source_id=(SELECT id FROM ingest.sources WHERE slug='sincopa') AND c.entity_kind='track'
       AND c.identity_raw = ANY($1::text[]) AND c.status IN ('candidate','accepted')
     GROUP BY c.identity_raw, c.identity_key, c.raw_page_id, r.url`, [identities]);

  const linked: Array<Row & { trackId: number; coreNumber: number }> = [];
  const append: Array<Row & { albumId: number }> = [];
  const left: Array<{ identity: string; url: string; reason: string }> = [];
  for (const row of rows) {
    if (row.num === null) continue;
    if (row.album_ids?.length !== 1) { left.push({ identity: row.identity_raw, url: row.url, reason: "el disco no está resuelto en el core" }); continue; }
    if (row.title === null) { left.push({ identity: row.identity_raw, url: row.url, reason: "sin título" }); continue; }
    const albumId = Number(row.album_ids[0]);
    const { rows: tracks } = await pool.query<{ id: string; track_number: number; title: string }>(
      "SELECT id::text, track_number, title FROM public.tracks WHERE album_id=$1", [albumId]);
    const same = tracks.filter((track) => fold(track.title) === fold(row.title!));
    if (same.length === 1) linked.push({ ...row, trackId: Number(same[0]!.id), coreNumber: same[0]!.track_number });
    else if (same.length > 1) left.push({ identity: row.identity_raw, url: row.url, reason: "el disco tiene varias pistas con ese título" });
    else if (tracks.some((track) => track.track_number === Number(row.num))) append.push({ ...row, albumId });
    else left.push({ identity: row.identity_raw, url: row.url, reason: "la posición ya está libre: basta otra pasada" });
  }

  let runId: number | undefined;
  const done = { superseded: 0, approved: 0, appended: 0, failed: 0 };
  if (confirm && (linked.length > 0 || append.length > 0)) {
    const [run] = await getDb().insert(scrapeRuns).values({ kind: "manual", status: "running", params: { action: "fix-sincopa-position-collisions", note } }).returning();
    if (!run) throw new Error("no se pudo abrir el run");
    runId = run.id;
    const reason = `[run ${run.id}] ${note}`;
    await withRunScope(run.id, async () => {
      for (const row of linked) {
        // El número reiniciado no se aplica: el core ya numera corrido.
        await pool.query("UPDATE ingest.claims SET status='superseded', notes=$2, updated_at=now() WHERE id=ANY($1::bigint[])",
          [row.num_claim_ids.map(Number), `${reason}: la pista ya está en el disco como ${row.coreNumber}`]);
        await pool.query(`UPDATE ingest.review_queue SET status='dismissed', resolved_by='human', resolution_note=$2, resolved_at=now(), updated_at=now()
                           WHERE claim_a_id=ANY($1::bigint[]) AND status IN ('open','in_progress')`, [row.num_claim_ids.map(Number), reason]);
        done.superseded += row.num_claim_ids.length;
        try {
          const result = await approveEntity("track", row.identity_key, reason, { humanResolution: { verdict: "same", targetId: row.trackId, decidedBy: "brian", reference: `misma pista del disco (${row.url})` } });
          done.approved += result.applied;
        } catch (error) {
          if (!String((error as Error).message).startsWith("sin claims candidatos")) { done.failed += 1; left.push({ identity: row.identity_raw, url: row.url, reason: `error: ${(error as Error).message}` }); }
        }
      }
      for (const row of append) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await bindRun(client, run.id);
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`merge:album-append:${row.albumId}`]);
          const { rows: [last] } = await client.query<{ n: number }>("SELECT coalesce(max(track_number),0)::int AS n FROM public.tracks WHERE album_id=$1 AND disc_number=1", [row.albumId]);
          const { rows: [track] } = await client.query<{ id: string }>(`
            INSERT INTO public.tracks(album_id,disc_number,track_number,title,notes) VALUES($1,1,$2,$3,$4) RETURNING id::text`,
          [row.albumId, last!.n + 1, row.title, `Sincopa la numera ${Number(row.num)} en otra edición del disco (${row.url}).`]);
          const trackId = Number(track!.id);
          const { rows: claimIds } = await client.query<{ id: string }>(`
            UPDATE ingest.claims SET track_id=$1, updated_at=now()
             WHERE source_id=(SELECT id FROM ingest.sources WHERE slug='sincopa') AND entity_kind='track' AND identity_key=$2 AND raw_page_id=$3
             RETURNING id::text`, [trackId, row.identity_key, Number(row.raw_page_id)]);
          await client.query("UPDATE ingest.claims SET status='superseded', notes=$2, updated_at=now() WHERE id=ANY($1::bigint[])",
            [row.num_claim_ids.map(Number), `${reason}: la posición ${Number(row.num)} es de otra pista; va al final como ${last!.n + 1}`]);
          await client.query("UPDATE ingest.claims SET status='accepted', updated_at=now() WHERE id=ANY($1::bigint[]) AND status='candidate' AND id<>ALL($2::bigint[])",
            [claimIds.map((item) => Number(item.id)), row.num_claim_ids.map(Number)]);
          const { rows: [audit] } = await client.query<{ id: string }>(`
            INSERT INTO ingest.merge_audit(run_id,entity_kind,track_id,field,old_value,new_value,reason,confidence,performed_by)
            VALUES($1,'track',$2,'title',NULL,$3::jsonb,$4,'high','human') RETURNING id::text`,
          [run.id, trackId, JSON.stringify(row.title), `${reason}: pista agregada al final del disco`]);
          for (const item of claimIds) await client.query("INSERT INTO ingest.merge_audit_claims(merge_audit_id,claim_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [audit!.id, Number(item.id)]);
          await client.query(`UPDATE ingest.review_queue SET status='approved', resolved_by='human', resolution_note=$2, resolved_at=now(), updated_at=now()
                               WHERE claim_a_id=ANY($1::bigint[]) AND status IN ('open','in_progress')`, [claimIds.map((item) => Number(item.id)), reason]);
          await client.query("COMMIT");
          done.appended += 1;
        } catch (error) {
          await client.query("ROLLBACK");
          done.failed += 1;
          left.push({ identity: row.identity_raw, url: row.url, reason: `error: ${(error as Error).message}` });
        } finally {
          client.release();
        }
      }
    });
    await finishRun(run.id, done.failed > 0 ? "partial" : "ok", done);
  }
  const report = { dryRun: !confirm, runId, identities: identities.length, alreadyInAlbum: linked.length, appendAtEnd: append.length, left: left.length, ...done };
  const out = arg("out");
  if (out !== undefined) writeFileSync(out, `${JSON.stringify({ ...report, appendList: append.map((row) => ({ title: row.title, num: row.num, albumId: row.albumId, url: row.url })), leftList: left }, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().then(() => closeDb()).then(() => process.exit(0), async (error) => {
  console.error(error);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
