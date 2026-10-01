// CRV · Reescritura con IA de los textos unidos al fusionar (Brian, 2026-10-01).
//
// Al fusionar dos fichas, sus biografías (o reseñas) se unen y la ficha queda
// marcada en `ingest.text_rewrites` (preserve.ts). Aquí DeepSeek flash
// convierte esos textos en uno solo, usando únicamente lo que ellos dicen:
//
//   * `rewriteTexts`: una llamada, validada (sin años inventados, sin formato,
//     en español, sin perder la longitud del más completo). La usan el botón
//     «Reescribir con IA ahora» del modal de fusión —que solo PROPONE: la
//     persona revisa el texto antes de fusionar— y la cola.
//   * `rewritePending`: recorre la cola, pide los textos en paralelo y escribe
//     los aprobados en un run propio (claim `crv-sintesis` creado por la IA,
//     auditoría y diario: el run se puede deshacer).
import { createHash } from "node:crypto";
import { z } from "zod";
import type { DeepSeekGateway } from "../ai/gateway.js";
import { getPool } from "../db/client.js";
import { invalidateSearchIndex } from "../api/search-index.js";
import { containsText, type PreserveKind, type TextSource } from "./preserve.js";

export const REWRITE_SCHEMA_VERSION = "crv-merge-rewrite.v3";
const SOURCE_SLUG = "crv-sintesis";
const EXTRACTOR = "reescritura-fusion";

const TARGET: Record<PreserveKind, { table: string; idColumn: string; touch: boolean }> = {
  artist: { table: "public.artists", idColumn: "artist_id", touch: true },
  person: { table: "public.persons", idColumn: "person_id", touch: true },
  organization: { table: "public.organizations", idColumn: "organization_id", touch: false },
  album: { table: "public.albums", idColumn: "album_id", touch: true },
};

const NOUN: Record<PreserveKind, string> = {
  artist: "la biografía de un artista o banda", person: "la biografía de una persona",
  organization: "la reseña de una organización (sello, estudio, medio…)", album: "la reseña de un disco",
};

const INSTRUCTIONS = [
  "Unes en UN SOLO TEXTO varios textos sobre la MISMA ficha del catálogo de rock venezolano.",
  "Las fichas se fusionaron porque eran la misma; cada texto venía de una de ellas.",
  "Reglas:",
  "- Usa SOLO lo que dicen los textos. No añadas datos, fechas, nombres ni valoraciones que no estén en ellos.",
  "- No pierdas ningún dato: cada hecho de cualquiera de los textos debe quedar en el resultado.",
  "- Si dos textos se contradicen (un año, una ciudad), conserva el del texto más completo y menciona el otro entre paréntesis",
  "  (p. ej. «formada en 1958 (otras fuentes dicen 1959)»).",
  "- Si un texto cuenta un hecho con una fecha que no encaja en la cronología del otro (p. ej. una gira antes de que la banda",
  "  existiera), no lo afirmes: preséntalo como versión distinta («según otra versión, la gira por Europa fue en 1959»).",
  "  «Según otra versión» es SOLO para contradicciones: un dato que aparece en un solo texto y no choca con nada se integra",
  "  como hecho, en el lugar que le corresponde del relato.",
  "- Quita lo repetido y ordena cronológicamente. Español neutro, tercera persona, tono enciclopédico.",
  "- Sin Markdown, sin viñetas, sin enlaces, sin títulos. Párrafos separados por una línea en blanco.",
  "- Usa el nombre de la ficha (`name`); el de la otra ficha puede aparecer como variante si los textos la usan.",
  "- No hables de «textos», «fuentes», «fichas», «el material» ni de la fusión. Integra cada dato en el relato;",
  "  nada de frases de cierre como «también se menciona» o «el material incluye».",
  "Devuelve un objeto JSON: {\"text\": \"<texto unido>\"}.",
].join("\n");

const responseSchema = z.object({ text: z.string() });

export interface RewriteInput { kind: PreserveKind; name: string; sources: readonly TextSource[] }
export interface RewriteResult { text: string; model: string; promptHash: string; retried: boolean }

const YEAR = /\b(1[89]\d\d|20[0-4]\d)\b/gu;

/** Problemas del texto propuesto; `null` si se puede usar. */
export function rewriteProblems(input: RewriteInput, text: string): string[] {
  const problems: string[] = [];
  const clean = text.trim();
  const longest = Math.max(...input.sources.map((source) => source.text.trim().length));
  if (clean.length < 40) problems.push("el texto es demasiado corto");
  // Unir no es resumir: el resultado no puede quedar muy por debajo del texto más largo.
  if (clean.length < longest * 0.8) problems.push(`el texto (${clean.length} caracteres) es mucho más corto que el texto más completo (${longest}): no resumas, conserva todos los datos`);
  if (/^\s*(#|[-*•]\s|\d+\.\s)|\*\*|\]\(|https?:\/\//mu.test(clean)) problems.push("lleva Markdown, viñetas o enlaces");
  // «Fusión» es también un género («fusión latina») y «el material» puede ser
  // el del disco: solo cuentan las frases que hablan de los textos o fichas.
  if (/(?<![\p{L}])(los textos|el texto \d|las fuentes|la fuente|las fichas|la ficha|ambas fichas|la fusi[oó]n de|el material (?:tambi[eé]n )?menciona|tambi[eé]n (?:se )?menciona)(?![\p{L}])/iu.test(clean)) {
    problems.push("habla de los textos, las fuentes o las fichas en vez de integrar los datos");
  }
  const blob = input.sources.map((source) => source.text).join("\n");
  const invented = [...new Set([...clean.matchAll(YEAR)].map((match) => match[1]!).filter((year) => !blob.includes(year)))];
  if (invented.length) problems.push(`usa años que no están en los textos: ${invented.join(", ")}`);
  const lostYears = [...new Set([...blob.matchAll(YEAR)].map((match) => match[1]!).filter((year) => !clean.includes(year)))];
  if (lostYears.length) problems.push(`pierde años que sí están en los textos: ${lostYears.join(", ")}`);
  return problems;
}

/**
 * Une los textos con DeepSeek flash. Si la primera respuesta incumple las
 * reglas, se pide corregida una vez; si vuelve a fallar, lanza el error.
 */
export async function rewriteTexts(gateway: DeepSeekGateway, input: RewriteInput): Promise<RewriteResult> {
  const payload = {
    tarea: NOUN[input.kind], name: input.name,
    textos: input.sources.map((source, index) => ({ n: index + 1, ficha: source.label, texto: source.text.trim() })),
  };
  const ask = (correccion?: string) => gateway.propose({
    taskKind: "biography", modelClass: "fast", schemaVersion: REWRITE_SCHEMA_VERSION,
    instructions: INSTRUCTIONS, responseSchema, input: correccion ? { ...payload, correccion } : payload,
  });
  let result = await ask();
  let problems = rewriteProblems(input, result.proposal.text);
  let retried = false;
  if (problems.length) {
    retried = true;
    result = await ask(`Tu respuesta anterior incumplió reglas: ${problems.join("; ")}. Reescribe el texto completo.`);
    problems = rewriteProblems(input, result.proposal.text);
  }
  if (problems.length) throw new Error(`la IA no dio un texto válido: ${problems.join("; ")}`);
  return { text: tidy(result.proposal.text), model: result.model, promptHash: result.promptHash, retried };
}

const tidy = (text: string) =>
  text.replace(/\r\n?/gu, "\n").split("\n").map((line) => line.trim()).join("\n").replace(/\n{3,}/gu, "\n\n").trim();

const sha = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");

interface PendingRow { id: string; entity_kind: PreserveKind; entity_id: string; field: string; sources: TextSource[] }

export interface RewritePendingOptions {
  gateway: DeepSeekGateway;
  confirm: boolean;
  limit?: number;
  concurrency?: number;
  ids?: number[];
  note: string;
}

export interface RewritePendingReport {
  mode: "dry-run" | "confirm";
  runId: number | null;
  pending: number;
  written: number;
  unchanged: number;
  changedMeanwhile: number[];
  entityGone: number[];
  failed: Array<{ id: number; error: string }>;
  samples: Array<{ id: number; kind: string; entityId: number; name: string; text: string }>;
}

/**
 * Procesa la cola: pide cada texto a la IA (fuera de transacción, en
 * paralelo) y, con `confirm`, los escribe en UN run. Un texto que la ficha
 * cambió mientras tanto no se pisa. En seco solo informa.
 */
export async function rewritePending(options: RewritePendingOptions): Promise<RewritePendingReport> {
  const pool = getPool();
  const { rows } = await pool.query<PendingRow & { name: string | null; current: string | null }>(`
    SELECT t.id::text, t.entity_kind::text AS entity_kind, t.entity_id::text, t.field, t.sources,
           COALESCE(p.name, a.name, o.name, al.title) AS name,
           CASE t.entity_kind::text WHEN 'person' THEN p.biography WHEN 'artist' THEN a.biography
                                    WHEN 'organization' THEN o.biography ELSE al.description END AS current
      FROM ingest.text_rewrites t
      LEFT JOIN public.persons p ON t.entity_kind='person' AND p.id=t.entity_id
      LEFT JOIN public.artists a ON t.entity_kind='artist' AND a.id=t.entity_id
      LEFT JOIN public.organizations o ON t.entity_kind='organization' AND o.id=t.entity_id
      LEFT JOIN public.albums al ON t.entity_kind='album' AND al.id=t.entity_id
     WHERE t.status='pending' AND ($1::bigint[] IS NULL OR t.id=ANY($1::bigint[]))
     ORDER BY t.id
     LIMIT $2`, [options.ids?.length ? options.ids : null, options.limit ?? 100000]);

  const report: RewritePendingReport = {
    mode: options.confirm ? "confirm" : "dry-run", runId: null, pending: rows.length, written: 0, unchanged: 0,
    changedMeanwhile: [], entityGone: [], failed: [], samples: [],
  };
  const done = new Map<string, { row: (typeof rows)[number]; result: RewriteResult }>();
  const queue = rows.filter((row) => {
    if (row.name !== null) return true;
    report.entityGone.push(Number(row.id));
    return false;
  });
  const worker = async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      try {
        const result = await rewriteTexts(options.gateway, { kind: row.entity_kind, name: row.name!, sources: row.sources });
        done.set(row.id, { row, result });
        if (report.samples.length < 20) {
          report.samples.push({ id: Number(row.id), kind: row.entity_kind, entityId: Number(row.entity_id), name: row.name!, text: result.text });
        }
      } catch (error) {
        report.failed.push({ id: Number(row.id), error: (error as Error).message.slice(0, 300) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 8, queue.length)) }, worker));
  if (!options.confirm || done.size === 0) return report;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      INSERT INTO ingest.sources(slug,name,site_type,trust_level,enabled,notes)
      VALUES($1,'Síntesis editorial de fuentes','database','medium',false,
             'Biografías y reseñas redactadas por un modelo a partir de las fuentes casadas de cada ficha (docs/curation/BIOGRAFIAS_SINTESIS.md). Nunca se raspa; cada claim guarda la evidencia de las fuentes usadas.')
      ON CONFLICT (slug) DO NOTHING`, [SOURCE_SLUG]);
    const sourceId = Number((await client.query<{ id: string }>("SELECT id::text FROM ingest.sources WHERE slug=$1", [SOURCE_SLUG])).rows[0]!.id);
    const run = await client.query<{ id: string }>(
      "INSERT INTO ingest.scrape_runs(kind,status,params) VALUES('merge_run','running',$1::jsonb) RETURNING id::text",
      [JSON.stringify({ action: "merge_text_rewrite", note: options.note, rewrites: [...done.keys()].map(Number) })]);
    const runId = Number(run.rows[0]!.id);
    report.runId = runId;

    for (const { row, result } of done.values()) {
      const target = TARGET[row.entity_kind];
      const entityId = Number(row.entity_id);
      if (row.current !== null && containsText(row.current, result.text) && containsText(result.text, row.current)) {
        report.unchanged += 1;
      } else {
        const updated = await client.query(`
          UPDATE ${target.table} SET ${row.field}=$2${target.touch ? ", updated_at=now()" : ""}
           WHERE id=$1 AND ${row.field} IS NOT DISTINCT FROM $3`, [entityId, result.text, row.current]);
        if (!updated.rowCount) { report.changedMeanwhile.push(Number(row.id)); continue; }
        const note = `reescritura tras fusión (${result.model}); une ${row.sources.length} textos: ${row.sources.map((source) => source.label).join(" + ")}`;
        const claim = await client.query<{ id: string }>(`
          INSERT INTO ingest.claims(source_id,entity_kind,${target.idColumn},field,raw_value,normalized_value,raw_hash,extractor,
                                    extractor_version,confidence,status,created_by,run_id,notes,identity_key)
          VALUES($1,$2,$3,$4,to_jsonb($5::text),to_jsonb($5::text),$6,$7,'1','medium','accepted','ai',$8,$9,$10)
          ON CONFLICT DO NOTHING RETURNING id::text`,
        [sourceId, row.entity_kind, entityId, row.field, result.text, sha([EXTRACTOR, row.id, result.text]), EXTRACTOR,
          runId, note, `reescritura:${row.entity_kind}:${entityId}:${row.field}`]);
        const claimId = claim.rows[0]?.id;
        if (claimId) {
          await client.query(`
            UPDATE ingest.claims SET status='superseded', updated_at=now()
             WHERE source_id=$1 AND entity_kind=$2 AND ${target.idColumn}=$3 AND field=$4 AND status='accepted' AND id<>$5`,
          [sourceId, row.entity_kind, entityId, row.field, claimId]);
          for (const [position, source] of row.sources.entries()) {
            await client.query(`
              INSERT INTO ingest.claim_evidence(claim_id,url,excerpt,position,evidence_hash) VALUES($1,$2,$3,$4,$5)
              ON CONFLICT DO NOTHING`,
            [claimId, `crv-fusion://${row.entity_kind}/${entityId}#${position + 1}`, `[${source.label}] ${source.text.slice(0, 480)}`,
              position, sha([row.id, position, source.text])]);
          }
        }
        const audit = await client.query<{ id: string }>(`
          INSERT INTO ingest.merge_audit(run_id,entity_kind,${target.idColumn},field,old_value,new_value,reason,confidence,performed_by)
          VALUES($1,$2,$3,$4,to_jsonb($5::text),to_jsonb($6::text),$7,'medium','ai') RETURNING id::text`,
        [runId, row.entity_kind, entityId, row.field, row.current, result.text, note]);
        if (claimId) await client.query("INSERT INTO ingest.merge_audit_claims(merge_audit_id,claim_id) VALUES($1,$2)", [audit.rows[0]!.id, claimId]);
        report.written += 1;
      }
      await client.query(
        "UPDATE ingest.text_rewrites SET status='done', resolved_run_id=$2, resolved_at=now() WHERE id=$1 AND status='pending'",
        [row.id, runId]);
    }
    await client.query("UPDATE ingest.scrape_runs SET status='ok', finished_at=now() WHERE id=$1", [runId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  invalidateSearchIndex();
  return report;
}
