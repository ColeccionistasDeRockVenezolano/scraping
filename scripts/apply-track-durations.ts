// CRV · Aplica las duraciones de pista cosechadas de Deezer e iTunes
// (scripts/harvest-track-durations.ts) en UN run reversible.
//
// Solo llena pistas que siguen sin duración. Si dos tiendas dan la misma pista,
// manda la primera del libro (Deezer se cosecha antes). Cada cambio deja un
// claim de la fuente `crv-duraciones` con la URL del disco en la tienda y el
// título externo como evidencia, y su fila de merge_audit.
//
//   npx tsx scripts/apply-track-durations.ts [--confirm]
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";

const DATE = "2026-09-28";
const LEDGER = `reports/track-durations-evidence-${DATE}.jsonl`;
const SOURCE_SLUG = "crv-duraciones";
const EXTRACTOR = "duracion-tienda";

interface Row { albumId: number; trackId: number; title: string; seconds: number; source: string; url: string; externalAlbum: string; externalTitle: string; shared: number }
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const byTrack = new Map<number, Row>();
  for (const line of readFileSync(LEDGER, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as Row;
    if (row.seconds > 0 && !byTrack.has(row.trackId)) byTrack.set(row.trackId, row);
  }
  const report = { mode: confirm ? "confirm" : "dry-run", runId: 0, candidates: byTrack.size, applied: 0, alreadySet: 0, bySource: {} as Record<string, number> };
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      INSERT INTO ingest.sources(slug,name,site_type,trust_level,enabled,notes)
      VALUES($1,'Duración de pista (tiendas)','database','medium',false,
             'Duraciones de Deezer e iTunes para el mismo disco (artista y título iguales y al menos dos pistas en común), emparejadas por título de pista único (scripts/apply-track-durations.ts). Nunca se raspa.')
      ON CONFLICT (slug) DO NOTHING`, [SOURCE_SLUG]);
    const sourceId = Number((await client.query<{ id: string }>("SELECT id::text FROM ingest.sources WHERE slug=$1", [SOURCE_SLUG])).rows[0]!.id);
    const run = await client.query<{ id: string }>(
      `INSERT INTO ingest.scrape_runs(kind, status, params) VALUES('merge_run','running',$1::jsonb) RETURNING id::text`,
      [JSON.stringify({ action: "track_durations", ledger: LEDGER, confirm })]);
    report.runId = Number(run.rows[0]!.id);
    for (const row of byTrack.values()) {
      const updated = await client.query(
        "UPDATE public.tracks SET duration_seconds=$2 WHERE id=$1 AND duration_seconds IS NULL RETURNING id", [row.trackId, row.seconds]);
      if (!updated.rowCount) { report.alreadySet += 1; continue; }
      const note = `${row.source}: «${row.externalTitle}» de «${row.externalAlbum}» (${row.shared} pistas en común)`;
      const claim = await client.query<{ id: string }>(`
        INSERT INTO ingest.claims(source_id,entity_kind,track_id,field,raw_value,normalized_value,raw_hash,extractor,
                                  extractor_version,confidence,status,created_by,run_id,notes,identity_key)
        VALUES($1,'track',$2,'duration_seconds',to_jsonb($3::int),to_jsonb($3::int),$4,$5,'1','medium','accepted','system',$6,$7,$8)
        ON CONFLICT DO NOTHING RETURNING id::text`,
      [sourceId, row.trackId, row.seconds, sha([EXTRACTOR, row.trackId, row.seconds, row.source]), EXTRACTOR, report.runId, note, `duracion:track:${row.trackId}`]);
      const claimId = claim.rows[0]?.id;
      if (claimId) {
        await client.query(`INSERT INTO ingest.claim_evidence(claim_id,url,excerpt,position,evidence_hash) VALUES($1,$2,$3,0,$4) ON CONFLICT DO NOTHING`,
          [claimId, row.url, note.slice(0, 500), sha([row.url, note])]);
      }
      const audit = await client.query<{ id: string }>(`
        INSERT INTO ingest.merge_audit(run_id,entity_kind,track_id,field,old_value,new_value,reason,confidence,performed_by)
        VALUES($1,'track',$2,'duration_seconds','null'::jsonb,to_jsonb($3::int),$4,'medium','system') RETURNING id::text`,
      [report.runId, row.trackId, row.seconds, note]);
      if (claimId) await client.query("INSERT INTO ingest.merge_audit_claims(merge_audit_id,claim_id) VALUES($1,$2)", [audit.rows[0]!.id, claimId]);
      report.applied += 1;
      report.bySource[row.source] = (report.bySource[row.source] ?? 0) + 1;
    }
    await client.query(`UPDATE ingest.scrape_runs SET status='ok', finished_at=now(), counters=$2::jsonb WHERE id=$1`,
      [report.runId, JSON.stringify({ applied: report.applied, bySource: report.bySource })]);
    await client.query(confirm ? "COMMIT" : "ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const out = `reports/apply-track-durations-${report.mode}-run${report.runId}-${DATE}.json`;
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`duraciones (${report.mode}, run ${report.runId}): ${report.applied} aplicadas de ${report.candidates}`, JSON.stringify(report.bySource), `· ${report.alreadySet} ya tenían → ${out}`);
  await closeDb();
}

main().catch(async (error: unknown) => { console.error(error); await closeDb(); process.exit(1); });
