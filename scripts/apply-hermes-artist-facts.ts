// CRV · Aplica el país, la ciudad y el año de formación que Hermes citó para
// los artistas que solo aparecen en recopilatorios (reports/hermes-bio-2026-09-29/
// hechos.jsonl, de tmp-analysis/hermes-bio-preparar.py), en UN run reversible.
//
// Solo llena lo vacío, con una excepción que decidió Brian (2026-09-30):
// `origin_country` es NOT NULL con DEFAULT 'Venezuela', así que «Venezuela» sin
// ningún claim aceptado detrás es el valor por defecto, no un dato; si Hermes
// cita otro país literalmente, se reemplaza. Cada cambio deja un claim de la
// fuente `crv-hermes` con la URL y la cita literal como evidencia, y su
// merge_audit. Un país que coincide con el actual solo deja el claim.
//
//   npx tsx scripts/apply-hermes-artist-facts.ts [--confirm]
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";

const LEDGER = "reports/hermes-bio-2026-09-29/hechos.jsonl";
const SOURCE_SLUG = "crv-hermes";
const EXTRACTOR = "hermes-citas";

type Field = "origin_country" | "origin_city" | "formed_year";
interface Fact { artistId: number; name: string; field: Field; value: string | number; url: string; cita: string }
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const facts = readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Fact);
  const report = {
    mode: confirm ? "confirm" : "dry-run", runId: 0, candidates: facts.length,
    applied: {} as Record<string, number>, confirmedOnly: 0, countryReplaced: [] as Array<{ artistId: number; name: string; from: string; to: string }>,
    skipped: [] as Array<{ artistId: number; field: Field; value: unknown; current: unknown; why: string }>,
  };
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      INSERT INTO ingest.sources(slug,name,site_type,trust_level,enabled,notes)
      VALUES($1,'Hermes (agente con navegador)','database','medium',false,
             'Datos que el agente Hermes (DeepSeek flash + navegador local) citó literalmente de páginas que abrió: país, ciudad, año de formación. La cita y la URL van como evidencia (scripts/apply-hermes-artist-facts.ts). Nunca se raspa.')
      ON CONFLICT (slug) DO NOTHING`, [SOURCE_SLUG]);
    const sourceId = Number((await client.query<{ id: string }>("SELECT id::text FROM ingest.sources WHERE slug=$1", [SOURCE_SLUG])).rows[0]!.id);
    const run = await client.query<{ id: string }>(
      `INSERT INTO ingest.scrape_runs(kind, status, params) VALUES('merge_run','running',$1::jsonb) RETURNING id::text`,
      [JSON.stringify({ action: "hermes_artist_facts", ledger: LEDGER, confirm })]);
    report.runId = Number(run.rows[0]!.id);

    for (const fact of facts) {
      const current = (await client.query<{ value: string | number | null }>(
        `SELECT ${fact.field} AS value FROM public.artists WHERE id=$1`, [fact.artistId])).rows[0];
      if (!current) { report.skipped.push({ artistId: fact.artistId, field: fact.field, value: fact.value, current: null, why: "artista inexistente" }); continue; }
      let write = current.value === null;
      let confirmOnly = false;
      if (fact.field === "origin_country") {
        if (current.value === fact.value) confirmOnly = true;
        else {
          const backed = await client.query(
            "SELECT 1 FROM ingest.claims WHERE artist_id=$1 AND field='origin_country' AND status='accepted' LIMIT 1", [fact.artistId]);
          write = current.value === "Venezuela" && !backed.rowCount;
          if (!write) { report.skipped.push({ artistId: fact.artistId, field: fact.field, value: fact.value, current: current.value, why: "país respaldado por otra fuente" }); continue; }
        }
      } else if (!write) {
        if (String(current.value) === String(fact.value)) confirmOnly = true;
        else { report.skipped.push({ artistId: fact.artistId, field: fact.field, value: fact.value, current: current.value, why: "campo ya lleno" }); continue; }
      }
      if (write && !confirmOnly) {
        await client.query(`UPDATE public.artists SET ${fact.field}=$2, updated_at=now() WHERE id=$1`, [fact.artistId, fact.value]);
        if (fact.field === "origin_country") report.countryReplaced.push({ artistId: fact.artistId, name: fact.name, from: String(current.value), to: String(fact.value) });
      }
      const note = `Hermes cita en ${fact.url}: «${fact.cita.slice(0, 300)}»`;
      const claim = await client.query<{ id: string }>(`
        INSERT INTO ingest.claims(source_id,entity_kind,artist_id,field,raw_value,normalized_value,raw_hash,extractor,
                                  extractor_version,confidence,status,created_by,run_id,notes,identity_key)
        VALUES($1,'artist',$2,$3,to_jsonb($4::text),to_jsonb($4::text),$5,$6,'1','medium','accepted','ai',$7,$8,$9)
        ON CONFLICT DO NOTHING RETURNING id::text`,
      [sourceId, fact.artistId, fact.field, String(fact.value), sha([EXTRACTOR, fact.artistId, fact.field, fact.value]), EXTRACTOR,
        report.runId, note, `hermes:${fact.field}:artist:${fact.artistId}`]);
      const claimId = claim.rows[0]?.id;
      if (claimId) {
        await client.query(`INSERT INTO ingest.claim_evidence(claim_id,url,excerpt,position,evidence_hash) VALUES($1,$2,$3,0,$4) ON CONFLICT DO NOTHING`,
          [claimId, fact.url, fact.cita.slice(0, 500), sha([fact.url, fact.cita])]);
      }
      if (confirmOnly) { report.confirmedOnly += 1; continue; }
      const toJson = fact.field === "formed_year" ? "to_jsonb($5::int)" : "to_jsonb($5::text)";
      const audit = await client.query<{ id: string }>(`
        INSERT INTO ingest.merge_audit(run_id,entity_kind,artist_id,field,old_value,new_value,reason,confidence,performed_by)
        VALUES($1,'artist',$2,$3,COALESCE(to_jsonb($4::text),'null'::jsonb),${toJson},$6,'medium','ai') RETURNING id::text`,
      [report.runId, fact.artistId, fact.field, current.value === null ? null : String(current.value), fact.value, note]);
      if (claimId) await client.query("INSERT INTO ingest.merge_audit_claims(merge_audit_id,claim_id) VALUES($1,$2)", [audit.rows[0]!.id, claimId]);
      report.applied[fact.field] = (report.applied[fact.field] ?? 0) + 1;
    }
    await client.query(`UPDATE ingest.scrape_runs SET status='ok', finished_at=now(), counters=$2::jsonb WHERE id=$1`,
      [report.runId, JSON.stringify({ applied: report.applied, confirmedOnly: report.confirmedOnly, skipped: report.skipped.length })]);
    await client.query(confirm ? "COMMIT" : "ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const out = `reports/apply-hermes-artist-facts-${report.mode}-run${report.runId}-2026-09-30.json`;
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`hechos Hermes (${report.mode}, run ${report.runId}): ${JSON.stringify(report.applied)} · ${report.countryReplaced.length} países reemplazados · ${report.confirmedOnly} solo confirmados · ${report.skipped.length} omitidos → ${out}`);
  await closeDb();
}

main().catch(async (error: unknown) => { console.error(error); await closeDb(); process.exit(1); });
