// Aplica años de formación cosechados de RYM (ficha del artista) a artistas sin
// formed_year, en un run reversible con claim + evidencia + journal por campo.
// Uso: tsx apply-rym-formed.mts reports/rym-formed-2026-10-01.jsonl [--confirm]
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";
import { withFieldJournal } from "../src/merge/field-undo.js";
import { updateEntity, withOperatorRun } from "../src/merge/operator.js";

interface Row { artistId: number; name: string; year: number; source: string; url: string; note?: string; }

const planArg = process.argv.slice(2).find((value) => !value.startsWith("--"));
const LEDGER = planArg ?? "reports/rym-formed-2026-10-01.jsonl";
const confirm = process.argv.includes("--confirm");
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function main(): Promise<void> {
  const rows = readFileSync(LEDGER, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as Row);
  const pool = getPool();
  const candidates: Array<Row & { sourceId: number }> = [];
  for (const row of rows) {
    const { rows: current } = await pool.query<{ year: number | null }>("SELECT formed_year AS year FROM public.artists WHERE id=$1", [row.artistId]);
    if (!current[0] || current[0].year !== null) continue;
    const source = await pool.query<{ id: string }>("SELECT id::text AS id FROM ingest.sources WHERE slug='rateyourmusic'");
    if (!source.rows[0]) continue;
    candidates.push({ ...row, sourceId: Number(source.rows[0].id) });
  }
  if (!confirm) {
    for (const row of candidates) console.log(`artista ${row.artistId} «${row.name}» → formado ${row.year}`);
    console.log(`dry-run: ${candidates.length} de ${rows.length}; ejecuta con --confirm`);
    await closeDb();
    return;
  }
  const { runId, result } = await withOperatorRun({
    name: "hermes:rym-formacion",
    operator: "hermes-curaduria (delegado por Brian)",
    note: "Años de formación de artistas sin formed_year, tomados de su ficha de Rate Your Music (navegación asistida autorizada por el propietario).",
  }, async (context) => {
    const log: string[] = [];
    for (const row of candidates) {
      await withFieldJournal(context, { kind: "artist", id: row.artistId, fields: ["formed_year"] }, async () => {
        await updateEntity(context, "artist", row.artistId, { formed_year: row.year });
      });
      const note = row.note ?? `ficha de Rate Your Music (${row.url})`;
      const claim = await context.client.query<{ id: string }>(`
        INSERT INTO ingest.claims(source_id,entity_kind,artist_id,field,raw_value,normalized_value,raw_hash,extractor,
                                  extractor_version,confidence,status,created_by,run_id,notes,identity_key)
        VALUES($1,'artist',$2,'formed_year',to_jsonb($3::int),to_jsonb($3::int),$4,'ficha-rym','1','medium','accepted','human',$5,$6,$7)
        ON CONFLICT DO NOTHING RETURNING id::text`,
      [row.sourceId, row.artistId, row.year, sha(["ficha-rym", row.artistId, row.year, row.url]), context.runId, note, `artist_formed:artist:${row.artistId}`]);
      const claimId = claim.rows[0]?.id;
      if (claimId) {
        await context.client.query(
          "INSERT INTO ingest.claim_evidence(claim_id,url,excerpt,position,evidence_hash) VALUES($1,$2,$3,0,$4) ON CONFLICT DO NOTHING",
          [claimId, row.url, note.slice(0, 500), sha([row.url, note])]);
      }
      const audit = await context.client.query<{ id: string }>(`
        INSERT INTO ingest.merge_audit(run_id,entity_kind,artist_id,field,old_value,new_value,reason,confidence,performed_by)
        VALUES($1,'artist',$2,'formed_year','null'::jsonb,to_jsonb($3::int),$4,'high','human') RETURNING id::text`,
      [context.runId, row.artistId, row.year, note]);
      if (claimId) await context.client.query("INSERT INTO ingest.merge_audit_claims(merge_audit_id,claim_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [audit.rows[0]!.id, claimId]);
      log.push(`artista ${row.artistId} → ${row.year}`);
    }
    return log;
  });
  writeFileSync(`reports/apply-rym-formed-run${runId}.json`, JSON.stringify({ runId, aplicados: result.length }, null, 2));
  console.log(`run ${runId}: ${result.length} formaciones aplicadas`);
  await closeDb();
}
main().catch(async (error: unknown) => { console.error(error); await closeDb(); process.exit(1); });
