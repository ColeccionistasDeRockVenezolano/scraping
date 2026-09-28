// CRV · Síntesis de biografías y reseñas con DeepSeek flash, UNA llamada por
// ficha (Brian, 2026-09-28: los subagentes consumían demasiado porque cada paso
// reenvía todo el contexto acumulado).
//
// Lee los expedientes de reports/bio-dossiers/<lote>.jsonl, salta los que ya
// tienen salida y escribe en reports/bio-synth/<lote>.jsonl el mismo formato que
// bio-batch-tool.py (más `model`), en el orden del lote. Las reglas son las de
// docs/curation/BIOGRAFIAS_SINTESIS.md, copiadas tal cual al prompt. Cada
// llamada queda en ingest.ai_runs (caché por prompt, tokens); nada toca el
// core: eso lo hace scripts/apply-biographies.ts en un run reversible.
//
// Uso: tsx scripts/synth-biographies-deepseek.ts --batches=album-025,person-031 [--limit=10] [--concurrency=8]
//      tsx scripts/synth-biographies-deepseek.ts --kinds=artist
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { createDeepSeekGateway } from "../src/ai/gateway.js";
import { closeDb, getPool } from "../src/db/client.js";

interface Dossier { caseId: string; kind: string; sources: Array<{ ref: string }>; [key: string]: unknown }
interface Output { caseId: string; text: string | null; sourcesUsed: string[]; discarded: Array<{ ref: string; reason: string }>; note: string | null; model: string }

const DOSSIERS = process.env["BIO_DOSSIERS_DIR"] ?? "reports/bio-dossiers";
const SYNTH = process.env["BIO_SYNTH_DIR"] ?? "reports/bio-synth";
const GUIDE = "docs/curation/BIOGRAFIAS_SINTESIS.md";
const SCHEMA_VERSION = "crv-bio-synth.v1";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const batchesArg = arg("batches")?.split(",");
const kindsArg = arg("kinds")?.split(",");
const limit = Number(arg("limit") ?? Infinity);
const concurrency = Number(arg("concurrency") ?? 8);

const responseSchema = z.object({
  caseId: z.string(),
  text: z.string().nullable(),
  sourcesUsed: z.array(z.string()).default([]),
  // flash a veces deja `ref` o `reason` en null al descartar: no invalida el texto.
  discarded: z.array(z.object({ ref: z.string().nullable().transform((v) => v ?? "?"), reason: z.string().nullable().transform((v) => v ?? "") })).default([]),
  note: z.string().nullable().default(null),
});

/** Reglas de la guía: de «Instrucciones para el subagente» hasta antes de «Procedimiento del subagente». */
function rules(): string {
  const guide = readFileSync(GUIDE, "utf8");
  const start = guide.indexOf("## Instrucciones para el subagente de síntesis");
  const end = guide.indexOf("## Procedimiento del subagente");
  if (start < 0 || end < 0) throw new Error(`no encuentro las reglas en ${GUIDE}`);
  return [
    "Redactas la biografía (artista, persona, organización) o la reseña (disco) de UNA ficha del catálogo de rock venezolano.",
    "El INPUT JSON es un único expediente. Devuelve UN objeto JSON con las claves caseId, text, sourcesUsed, discarded y note,",
    "tal como se describe abajo (una línea por expediente = tu objeto). caseId debe ser el del expediente.",
    "",
    guide.slice(start, end).trim(),
    "",
    // Fallos que se repitieron en el piloto (2026-09-28) aunque la guía ya los prohíbe.
    "## Comprobación final antes de responder",
    "- Como mucho 3 temas nombrados en todo el texto y como mucho 5 nombres propios (personas, bandas o artistas) por párrafo.",
    "  En un recopilatorio nombra como mucho 5 artistas participantes EN TODO EL TEXTO y resume el resto («entre otros»).",
    "  Nunca copies la lista de temas, de artistas ni de créditos.",
    "- Una banda, un disco o un crédito del catálogo YA son datos: con eso escribe una o dos frases.",
    "  `text: null` con `note: \"sin datos\"` solo cuando no hay NADA aparte del nombre.",
    "- No escribas «venezolano/a» de una persona salvo que `catalog.nacionalidad` lo diga o una fuente lo afirme expresamente.",
    "  `venezolano: true` NO basta. Sin nacionalidad, empieza por el rol: «Guitarrista que participó en…».",
    "- No escribas «según los créditos», «según la fuente» ni nombres de fuentes.",
  ].join("\n");
}

const compact = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined && v !== ""
      && !(Array.isArray(v) && v.length === 0) && !(typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0))
      .map(([k, v]) => [k, compact(v)]));
  }
  return value;
};

/**
 * Fallos de reglas que flash repite aunque el prompt los prohíba; se piden
 * corregidos en una segunda llamada (el campo `correccion` cambia el hash).
 */
function violations(dossier: Dossier, text: string | null): string | null {
  if (!text) return null;
  const problems: string[] = [];
  const catalog = (dossier["catalog"] ?? {}) as Record<string, unknown>;
  const sourceSays = JSON.stringify(dossier["sources"] ?? []).toLowerCase().includes("venezol");
  if (dossier.kind === "person" && /venezolan[oa]/iu.test(text) && !catalog["nacionalidad"] && !sourceSays) {
    problems.push("El texto llama venezolana a la persona y nada en el expediente lo afirma: quita esa nacionalidad.");
  }
  // Solo en reseñas: en personas y artistas las comillas también marcan discos, que la guía permite nombrar.
  const titles = text.match(/«[^»]+»/gu)?.length ?? 0;
  if (dossier.kind === "album" && titles > 4) problems.push(`El texto nombra ${titles} títulos entre comillas: deja como mucho 3 temas y resume el resto.`);
  // Años que no salen del expediente: flash a veces completa con conocimiento
  // propio. Se admiten décadas («década de 1970») y años escritos con dos cifras («el 96»).
  const blob = JSON.stringify(dossier);
  const invented = [...text.matchAll(/\b(1[89]\d\d|20[0-2]\d)\b/gu)].filter((match) => {
    const year = match[1]!;
    if (blob.includes(year)) return false;
    if (year.endsWith("0") && /d[ée]cada|años/iu.test(text.slice(Math.max(0, match.index! - 40), match.index))) return false;
    return !new RegExp(`(?:año|del|el|en|de|['’])\\s*${year.slice(2)}(?!\\d)`, "iu").test(blob);
  }).map((match) => match[1]);
  if (invented.length) problems.push(`Estos años no aparecen en el expediente: ${[...new Set(invented)].join(", ")}. Quítalos o usa solo los del expediente.`);
  return problems.length ? `Tu respuesta anterior incumplió reglas. ${problems.join(" ")} Reescribe el texto completo.` : null;
}

const readJsonl =<T,>(file: string): T[] => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T) : []);

async function main(): Promise<void> {
  const batches = batchesArg ?? readdirSync(DOSSIERS)
    .filter((name) => /^(artist|album|person|organization)-\d+\.jsonl$/u.test(name) && (!kindsArg || kindsArg.includes(name.split("-")[0]!)))
    .map((name) => name.replace(/\.jsonl$/u, "")).sort();
  const instructions = rules();
  const gateway = createDeepSeekGateway();
  const stats = { batches: 0, cases: 0, written: 0, noData: 0, cached: 0, retried: 0, failed: [] as Array<{ caseId: string; error: string }>, promptHashes: [] as string[] };
  let budget = limit;

  for (const batch of batches) {
    if (budget <= 0) break;
    const dossiers = readJsonl<Dossier>(path.join(DOSSIERS, `${batch}.jsonl`));
    const outFile = path.join(SYNTH, `${batch}.jsonl`);
    const done = new Map(readJsonl<Output>(outFile).map((row) => [row.caseId, row]));
    const pending = dossiers.filter((d) => !done.has(d.caseId)).slice(0, budget);
    if (!pending.length) continue;
    budget -= pending.length;
    stats.batches += 1;
    // Reescribe la salida entera en el orden del lote, como bio-batch-tool.py.
    const flush = () => writeFileSync(outFile, dossiers.filter((d) => done.has(d.caseId)).map((d) => JSON.stringify(done.get(d.caseId)) + "\n").join(""));

    const queue = [...pending];
    const worker = async () => {
      for (let dossier = queue.shift(); dossier; dossier = queue.shift()) {
        stats.cases += 1;
        try {
          const ask = (fix?: string) => gateway.propose({
            taskKind: "biography", schemaVersion: SCHEMA_VERSION, instructions, responseSchema,
            input: fix ? { ...(compact(dossier) as object), correccion: fix } : compact(dossier),
          });
          const refs = new Set(["catalog", "current", ...dossier.sources.map((s) => s.ref)]);
          const unknownRefs = (used: string[]) => used.filter((ref) => !refs.has(ref));
          let result = await ask();
          const wrongRefs = unknownRefs(result.proposal.sourcesUsed);
          const fix = violations(dossier, result.proposal.text)
            ?? (wrongRefs.length ? `Tu respuesta anterior citó refs que no existen (${wrongRefs.join(", ")}). En sourcesUsed usa solo catalog, current o los ref de sources.` : null);
          if (fix) { result = await ask(fix); stats.retried += 1; }
          const answer = result.proposal;
          if (answer.caseId !== dossier.caseId) throw new Error(`caseId devuelto ${answer.caseId}`);
          const bad = unknownRefs(answer.sourcesUsed);
          if (bad.length) throw new Error(`cita refs inexistentes ${bad.join(",")}`);
          done.set(dossier.caseId, { ...answer, model: result.model });
          flush();
          stats.written += 1;
          if (answer.text === null) stats.noData += 1;
          if (result.cached) stats.cached += 1;
          stats.promptHashes.push(result.promptHash);
        } catch (error) {
          stats.failed.push({ caseId: dossier.caseId, error: (error as Error).message.slice(0, 300) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
    console.error(`${batch}: ${[...done.keys()].length}/${dossiers.length} escritas`);
  }

  const usage = (await getPool().query<{ tin: string | null; tout: string | null }>(
    "SELECT sum(tokens_in)::text tin, sum(tokens_out)::text tout FROM ingest.ai_runs WHERE prompt_hash = ANY($1)", [stats.promptHashes])).rows[0];
  const { promptHashes: _hashes, ...summary } = stats;
  console.log(JSON.stringify({ ...summary, tokensIn: Number(usage?.tin ?? 0), tokensOut: Number(usage?.tout ?? 0) }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => closeDb());
