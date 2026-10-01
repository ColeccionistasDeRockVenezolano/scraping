// CRV · Aplica el tipo de disco que eligió Laya (scripts/run-laya-album-types.py)
// para los discos que siguen en `other`, en UN run reversible.
//
// Guardas de la cosecha por reglas (scripts/harvest-album-types.py): un sencillo
// solo con ≤3 pistas y un EP solo con ≤8 (si el disco tiene pistas cargadas);
// y, tras la muestra, un álbum de estudio solo con 5 pistas o más.
// Cada cambio deja un claim de la fuente `crv-tipo-disco` (extractor
// `tipo-disco-laya`) con la probabilidad y las opciones, y su merge_audit.
//
//   npx tsx scripts/apply-laya-album-types.ts [--min=0.5] [--exclude=1,2] [--confirm]
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";

const DATE = "2026-09-28";
const PREDICTIONS = `reports/album-type-laya-predictions-${DATE}.jsonl`;
const SOURCE_SLUG = "crv-tipo-disco";
const EXTRACTOR = "tipo-disco-laya";
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

interface Prediction { caseId: string; albumId: number; trackCount: number | null; status: string; type: string | null; probability: number | null; options?: string[] }
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const min = Number(arg("min") ?? "0");
  const exclude = new Set((arg("exclude") ?? "").split(",").filter(Boolean).map(Number));
  const predictions = readFileSync(PREDICTIONS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Prediction);
  const report = { mode: confirm ? "confirm" : "dry-run", runId: 0, min, applied: {} as Record<string, number>, belowMin: 0, abstained: 0, noOptions: 0,
    guarded: [] as Array<{ albumId: number; type: string; tracks: number }>, excluded: 0, notOther: 0 };
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const sourceId = Number((await client.query<{ id: string }>("SELECT id::text FROM ingest.sources WHERE slug=$1", [SOURCE_SLUG])).rows[0]!.id);
    const run = await client.query<{ id: string }>(
      `INSERT INTO ingest.scrape_runs(kind, status, params) VALUES('merge_run','running',$1::jsonb) RETURNING id::text`,
      [JSON.stringify({ action: "album_types_laya", predictions: PREDICTIONS, min, confirm })]);
    report.runId = Number(run.rows[0]!.id);
    for (const p of predictions) {
      if (p.status === "abstained") { report.abstained += 1; continue; }
      if (p.status === "no_options" || !p.type) { report.noOptions += 1; continue; }
      if (exclude.has(p.albumId)) { report.excluded += 1; continue; }
      if ((p.probability ?? 0) < min) { report.belowMin += 1; continue; }
      const tracks = Number((await client.query<{ n: string }>("SELECT count(*)::text n FROM public.tracks WHERE album_id=$1", [p.albumId])).rows[0]!.n);
      // Muestra de 40 (2026-09-28): las reseñas llaman «álbum» a discos de 4 pistas.
      if ((p.type === "single" && tracks > 3) || (p.type === "ep" && tracks > 8) || (p.type === "studio_album" && tracks > 0 && tracks < 5)) { report.guarded.push({ albumId: p.albumId, type: p.type, tracks }); continue; }
      const updated = await client.query(`UPDATE public.albums SET album_type=$2::album_type, updated_at=now() WHERE id=$1 AND album_type='other' RETURNING id`, [p.albumId, p.type]);
      if (!updated.rowCount) { report.notOther += 1; continue; }
      const note = `Laya (p=${(p.probability ?? 0).toFixed(2)}) entre ${(p.options ?? []).join(", ")}; expediente reports/album-type-laya-dossiers-${DATE}.jsonl`;
      const claim = await client.query<{ id: string }>(`
        INSERT INTO ingest.claims(source_id,entity_kind,album_id,field,raw_value,normalized_value,raw_hash,extractor,
                                  extractor_version,confidence,status,created_by,run_id,notes,identity_key)
        VALUES($1,'album',$2,'album_type',to_jsonb($3::text),to_jsonb($3::text),$4,$5,'2','low','accepted','ai',$6,$7,$8)
        ON CONFLICT DO NOTHING RETURNING id::text`,
      [sourceId, p.albumId, p.type, sha([EXTRACTOR, p.albumId, p.type]), EXTRACTOR, report.runId, note, `tipo-disco:album:${p.albumId}`]);
      const claimId = claim.rows[0]?.id;
      const audit = await client.query<{ id: string }>(`
        INSERT INTO ingest.merge_audit(run_id,entity_kind,album_id,field,old_value,new_value,reason,confidence,performed_by)
        VALUES($1,'album',$2,'album_type',to_jsonb('other'::text),to_jsonb($3::text),$4,'low','system') RETURNING id::text`,
      [report.runId, p.albumId, p.type, note]);
      if (claimId) await client.query("INSERT INTO ingest.merge_audit_claims(merge_audit_id,claim_id) VALUES($1,$2)", [audit.rows[0]!.id, claimId]);
      report.applied[p.type] = (report.applied[p.type] ?? 0) + 1;
    }
    await client.query(`UPDATE ingest.scrape_runs SET status='ok', finished_at=now(), counters=$2::jsonb WHERE id=$1`,
      [report.runId, JSON.stringify({ applied: report.applied })]);
    await client.query(confirm ? "COMMIT" : "ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const out = `reports/apply-laya-album-types-${report.mode}-${DATE}.json`;
  writeFileSync(out, JSON.stringify(report, null, 2));
  const total = Object.values(report.applied).reduce((s, v) => s + v, 0);
  console.log(`tipos Laya (${report.mode}, run ${report.runId}): ${total} aplicados ${JSON.stringify(report.applied)} · ${report.belowMin} bajo ${min} · ${report.abstained} abstenciones · ${report.noOptions} sin opciones · ${report.guarded.length} frenados por pistas · ${report.notOther} ya tenían tipo → ${out}`);
  await closeDb();
}

main().catch(async (error: unknown) => { console.error(error); await closeDb(); process.exit(1); });
