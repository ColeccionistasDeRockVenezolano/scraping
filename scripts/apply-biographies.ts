// CRV · Aplica las biografías y reseñas sintetizadas (docs/curation/BIOGRAFIAS_SINTESIS.md).
//
// Lee las salidas de la síntesis (reports/bio-synth/*.jsonl) junto con sus
// expedientes (reports/bio-dossiers/*.jsonl), valida cada texto y lo escribe
// en el core: artists.biography, persons.biography, organizations.biography y
// albums.description. Todo va en UN run (`merge_run`, acción
// `biography_synthesis`) ligado al diario de cambios, así que se deshace por
// run. Cada texto deja:
//  * un claim aceptado de la fuente interna `crv-sintesis` (nunca se raspa),
//    creado por `ai`, con una evidencia por cada fuente que la síntesis usó;
//  * su fila de merge_audit (valor anterior y nuevo) enlazada al claim.
// No pisa: fichas cuyo texto cambió desde que se exportó el expediente
// (alguien lo editó entretanto) ni fichas con corrección humana (el
// exportador ya no las envía). Sin --confirm corre entero y se deshace.
// Uso: tsx scripts/apply-biographies.ts [--confirm] [--only=artist-001,album-002]
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { closeDb, getPool } from "../src/db/client.js";

type Kind = "artist" | "album" | "person" | "organization";
interface Source { ref: string; source: string; url: string | null; text: string }
interface Dossier { caseId: string; kind: Kind; entityId: number; name: string; currentText: string | null; sources: Source[] }
interface Synth { caseId: string; text: string | null; sourcesUsed?: string[]; discarded?: Array<{ ref: string; reason: string }>; note?: string | null; model?: string }

const DOSSIERS = process.env["BIO_DOSSIERS_DIR"] ?? "reports/bio-dossiers";
const SYNTH = process.env["BIO_SYNTH_DIR"] ?? "reports/bio-synth";
const SOURCE_SLUG = "crv-sintesis";
const EXTRACTOR = "sintesis-biografia";
/** Modelo de las salidas sin campo `model` (las de los subagentes, 2026-09-27/28). */
const MODEL = "claude-sonnet-5";
const TARGET: Record<Kind, { table: string; column: string; idColumn: string; field: string; touch: boolean }> = {
  artist: { table: "public.artists", column: "biography", idColumn: "artist_id", field: "biography", touch: true },
  person: { table: "public.persons", column: "biography", idColumn: "person_id", field: "biography", touch: true },
  organization: { table: "public.organizations", column: "biography", idColumn: "organization_id", field: "biography", touch: false },
  album: { table: "public.albums", column: "description", idColumn: "album_id", field: "description", touch: true },
};

const confirm = process.argv.includes("--confirm");
const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice("--only=".length).split(",");
const sha = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const squash = (text: string | null) => (text ?? "").replace(/\s+/gu, " ").trim();

const ES = /\b(el|la|los|las|de|del|que|en|con|por|una?|fue|su|sus|banda|disco|para|como|entre|año)\b/giu;
const EN = /\b(the|and|was|with|his|her|their|band|album|which|from|released|were|has)\b/giu;

/** Motivo por el que el texto no se aplica, o null si pasa. */
function invalid(item: Synth, dossier: Dossier): string | null {
  if (typeof item.text !== "string") return "sin texto";
  const text = item.text.trim();
  if (text.length < 40) return "texto demasiado corto";
  if (text.length > 7000) return "texto demasiado largo";
  if (/^\s*(#|[-*•]\s|\d+\.\s)|\*\*|\]\(|https?:\/\//mu.test(text)) return "formato no permitido (Markdown, viñetas o enlaces)";
  if (/\b(expediente|currentText|sourcesUsed|seg[uú]n (?:el|la|los) (?:cat[aá]logo|fuentes?)|\bs\d+\b)/iu.test(text)) return "habla del expediente o del catálogo en vez de la ficha";
  const es = text.match(ES)?.length ?? 0;
  const en = text.match(EN)?.length ?? 0;
  if (en > es * 0.25 && en >= 4) return "no parece estar en español";
  const refs = new Set(["catalog", "current", ...dossier.sources.map((source) => source.ref)]);
  const unknown = (item.sourcesUsed ?? []).filter((ref) => !refs.has(ref));
  if (unknown.length) return `cita fuentes inexistentes: ${unknown.join(",")}`;
  if ((item.sourcesUsed ?? []).includes("current") && !dossier.currentText) return "dice partir de una biografía que no existe";
  return null;
}

/** Años que la biografía actual afirmaba y la nueva ya no nombra: se informa, no bloquea. */
function lostYears(before: string | null, after: string): string[] {
  const years = (text: string) => new Set(text.match(/\b(19[4-9]\d|20[0-2]\d)\b/gu) ?? []);
  const kept = years(after);
  return [...years(before ?? "")].filter((year) => !kept.has(year));
}

async function main(): Promise<void> {
  const dossiers = new Map<string, Dossier>();
  for (const file of readdirSync(DOSSIERS).filter((name) => name.endsWith(".jsonl"))) {
    for (const line of readFileSync(path.join(DOSSIERS, file), "utf8").split("\n")) {
      if (line.trim()) { const d = JSON.parse(line) as Dossier; dossiers.set(d.caseId, d); }
    }
  }
  const outputs: Array<{ batch: string; item: Synth }> = [];
  const badLines: Array<{ batch: string; line: number; error: string }> = [];
  for (const file of (existsSync(SYNTH) ? readdirSync(SYNTH) : []).filter((name) => /^(artist|album|person|organization)-\d+\.jsonl$/u.test(name)).sort()) {
    const batch = file.replace(/\.jsonl$/u, "");
    if (only && !only.includes(batch)) continue;
    readFileSync(path.join(SYNTH, file), "utf8").split("\n").forEach((line, index) => {
      if (!line.trim()) return;
      try { outputs.push({ batch, item: JSON.parse(line) as Synth }); }
      catch (error) { badLines.push({ batch, line: index + 1, error: String(error) }); }
    });
  }

  const report = {
    mode: confirm ? "confirm" : "dry-run", runId: 0, models: [...new Set(outputs.map((o) => o.item.model ?? MODEL))], outputs: outputs.length, badLines,
    applied: { artist: 0, album: 0, person: 0, organization: 0 } as Record<Kind, number>,
    enriched: 0, created: 0, unchanged: 0, noData: 0, changedSinceExport: [] as string[],
    rejected: [] as Array<{ caseId: string; batch: string; reason: string }>,
    unknownCase: [] as string[],
    lostYears: [] as Array<{ caseId: string; years: string[] }>,
    notes: [] as Array<{ caseId: string; note: string }>,
    discarded: 0,
  };

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      INSERT INTO ingest.sources(slug,name,site_type,trust_level,enabled,notes)
      VALUES($1,'Síntesis editorial de fuentes','database','medium',false,
             'Biografías y reseñas redactadas por un modelo a partir de las fuentes casadas de cada ficha (docs/curation/BIOGRAFIAS_SINTESIS.md). Nunca se raspa; cada claim guarda la evidencia de las fuentes usadas.')
      ON CONFLICT (slug) DO NOTHING`, [SOURCE_SLUG]);
    const sourceId = Number((await client.query<{ id: string }>("SELECT id::text FROM ingest.sources WHERE slug=$1", [SOURCE_SLUG])).rows[0]!.id);
    const run = await client.query<{ id: string }>(
      `INSERT INTO ingest.scrape_runs(kind, status, params) VALUES('merge_run','running',$1::jsonb) RETURNING id::text`,
      [JSON.stringify({ action: "biography_synthesis", models: report.models, batches: [...new Set(outputs.map((o) => o.batch))], confirm })]);
    report.runId = Number(run.rows[0]!.id);

    for (const { batch, item } of outputs) {
      const dossier = dossiers.get(item.caseId);
      if (!dossier) { report.unknownCase.push(item.caseId); continue; }
      report.discarded += item.discarded?.length ?? 0;
      if (item.note && item.note !== "sin datos") report.notes.push({ caseId: item.caseId, note: item.note });
      if (item.text === null && item.note === "sin datos") { report.noData += 1; continue; }
      const reason = invalid(item, dossier);
      if (reason) { report.rejected.push({ caseId: item.caseId, batch, reason }); continue; }
      const text = item.text!.replace(/\r\n?/gu, "\n").split("\n").map((line) => line.trim()).join("\n").replace(/\n{3,}/gu, "\n\n").trim();
      const target = TARGET[dossier.kind];
      if (squash(text) === squash(dossier.currentText)) { report.unchanged += 1; continue; }

      const updated = await client.query(`
        UPDATE ${target.table} SET ${target.column}=$2${target.touch ? ", updated_at=now()" : ""}
         WHERE id=$1 AND ${target.column} IS NOT DISTINCT FROM $3 RETURNING id`,
      [dossier.entityId, text, dossier.currentText]);
      if (!updated.rowCount) { report.changedSinceExport.push(item.caseId); continue; }

      const used = item.sourcesUsed ?? [];
      const usedSlugs = [...new Set(dossier.sources.filter((source) => used.includes(source.ref)).map((source) => source.source))];
      const note = `síntesis ${item.model ?? MODEL}; fuentes: ${usedSlugs.join(", ") || "catálogo"}`;
      const claim = await client.query<{ id: string }>(`
        INSERT INTO ingest.claims(source_id,entity_kind,${target.idColumn},field,raw_value,normalized_value,raw_hash,extractor,
                                  extractor_version,confidence,status,created_by,run_id,notes,identity_key)
        VALUES($1,$2,$3,$4,to_jsonb($5::text),to_jsonb($5::text),$6,$7,'1','medium','accepted','ai',$8,$9,$10)
        ON CONFLICT DO NOTHING RETURNING id::text`,
      [sourceId, dossier.kind, dossier.entityId, target.field, text, sha([EXTRACTOR, item.caseId, text]), EXTRACTOR,
        report.runId, note, `sintesis:${item.caseId}`]);
      const claimId = claim.rows[0]?.id;
      if (claimId) {
        await client.query(`
          UPDATE ingest.claims SET status='superseded', updated_at=now()
           WHERE source_id=$1 AND entity_kind=$2 AND ${target.idColumn}=$3 AND field=$4 AND status='accepted' AND id<>$5`,
        [sourceId, dossier.kind, dossier.entityId, target.field, claimId]);
        const evidence = [
          ...(used.includes("catalog") ? [{ url: `crv-catalogo://${item.caseId}`, excerpt: "datos del catálogo CRV" }] : []),
          ...(used.includes("current") ? [{ url: `crv-catalogo://${item.caseId}#${target.column}`, excerpt: (dossier.currentText ?? "").slice(0, 500) }] : []),
          ...dossier.sources.filter((source) => used.includes(source.ref))
            .map((source) => ({ url: source.url ?? `crv-fuente://${source.source}`, excerpt: `[${source.source}] ${source.text.slice(0, 480)}` })),
        ];
        for (const [position, row] of evidence.entries()) {
          await client.query(`
            INSERT INTO ingest.claim_evidence(claim_id,url,excerpt,position,evidence_hash) VALUES($1,$2,$3,$4,$5)
            ON CONFLICT DO NOTHING`, [claimId, row.url, row.excerpt, position, sha([row.url, row.excerpt])]);
        }
        const audit = await client.query<{ id: string }>(`
          INSERT INTO ingest.merge_audit(run_id,entity_kind,${target.idColumn},field,old_value,new_value,reason,confidence,performed_by)
          VALUES($1,$2,$3,$4,to_jsonb($5::text),to_jsonb($6::text),$7,'medium','ai') RETURNING id::text`,
        [report.runId, dossier.kind, dossier.entityId, target.field, dossier.currentText, text, note]);
        await client.query("INSERT INTO ingest.merge_audit_claims(merge_audit_id,claim_id) VALUES($1,$2)", [audit.rows[0]!.id, claimId]);
      }
      report.applied[dossier.kind] += 1;
      if (dossier.currentText?.trim()) {
        report.enriched += 1;
        const years = lostYears(dossier.currentText, text);
        if (years.length) report.lostYears.push({ caseId: item.caseId, years });
      } else report.created += 1;
    }

    const total = Object.values(report.applied).reduce((sum, value) => sum + value, 0);
    await client.query(`UPDATE ingest.scrape_runs SET status=$2::ingest.run_status, finished_at=now(), counters=$3::jsonb WHERE id=$1`,
      [report.runId, "ok", JSON.stringify({ applied: report.applied, enriched: report.enriched, created: report.created,
        rejected: report.rejected.length, changedSinceExport: report.changedSinceExport.length })]);
    await client.query(confirm ? "COMMIT" : "ROLLBACK");
    const out = `reports/apply-biographies-${new Date().toISOString().slice(0, 10)}${confirm ? "" : "-dry-run"}.json`;
    writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(`biografías (${report.mode}, run ${report.runId}): ${total} aplicadas`, JSON.stringify({
      applied: report.applied, enriched: report.enriched, created: report.created, unchanged: report.unchanged, noData: report.noData,
      rejected: report.rejected.length, changedSinceExport: report.changedSinceExport.length, unknownCase: report.unknownCase.length,
      lostYears: report.lostYears.length, notes: report.notes.length, badLines: badLines.length,
    }), `→ ${out}`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await closeDb();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
