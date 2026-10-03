// CRV · Extracción de integrantes con DeepSeek flash (Brian, 2026-10-01).
//
// Una llamada por expediente (scripts/export-member-dossiers.mts). El modelo
// clasifica la ficha (banda, solista, proyecto personal, no-artista) y extrae
// el titular o los integrantes SOLO de los textos del expediente, con una cita
// literal por persona. El código valida: la cita tiene que estar en el texto
// citado y contener el nombre; lo que no pasa se descarta (un reintento con la
// lista de errores). Solo propone: escribir es trabajo del aplicador.
//
// Reanudable: lo ya escrito en la salida no se vuelve a pedir; cada llamada
// queda en `ingest.ai_runs` (caché por hash de prompt).
// Uso: tsx scripts/extract-members-deepseek.mts --in=<member-dossiers.jsonl> --out=<salida.jsonl> [--concurrency=20] [--limit=N] [--ids=1,2]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { createDeepSeekGateway } from "../src/ai/gateway.js";
import { closeDb, getPool } from "../src/db/client.js";
import type { MemberDossier } from "./export-member-dossiers.mjs";

const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const IN = arg("in") ?? "reports/member-dossiers/member-dossiers.jsonl";
const OUT = arg("out") ?? "reports/member-dossiers/member-extraction.jsonl";
const CONCURRENCY = Number(arg("concurrency") ?? 20);
const LIMIT = Number(arg("limit") ?? Infinity);
const ONLY = arg("ids")?.split(",").map(Number);
export const SCHEMA_VERSION = "crv-member-extraction.v1";

const evidenceSchema = z.object({ quote: z.string(), sourceRef: z.string() });
const responseSchema = z.object({
  caseId: z.string(),
  kind: z.enum(["banda", "solista", "proyecto_personal", "no_artista", "desconocido"]),
  // El modelo a veces manda el titular como texto suelto: se acepta sin cita y la validación pide la cita en el reintento.
  titular: z.preprocess(
    (value) => {
      if (typeof value === "string") return { name: value, personId: null, evidence: { quote: "", sourceRef: "" } };
      if (!value || typeof value !== "object") return value;
      const titular = value as { personId?: unknown; evidence?: unknown };
      const personId = typeof titular.personId === "string" && /^\d+$/u.test(titular.personId) ? Number(titular.personId)
        : typeof titular.personId === "number" ? titular.personId : null;
      return { ...titular, personId, evidence: titular.evidence ?? { quote: "", sourceRef: "" } };
    },
    z.object({ name: z.string(), personId: z.number().int().nullable(), evidence: evidenceSchema }).nullable(),
  ),
  members: z.array(z.object({
    name: z.string(),
    personId: z.number().int().nullable(),
    role: z.string(),
    fromYear: z.number().int().nullable(),
    toYear: z.number().int().nullable(),
    current: z.boolean().nullable(),
    evidence: evidenceSchema,
  })),
  note: z.string().nullable(),
});
export type MemberExtraction = z.infer<typeof responseSchema>;

const INSTRUCTIONS = `Tarea: decidir qué es la ficha de artista y extraer su titular o sus integrantes, SOLO con los textos del expediente.
Entrada: {caseId, name, bio, catalog, credited:[{personId,name,roles,guestOnly,years}], sources:[{ref,source,url,text,facts}]}.
La bio se cita con sourceRef "bio"; cada fuente, con su ref (s1, s2…).

kind:
- "banda": grupo con varios integrantes (banda, dúo, trío, orquesta, colectivo).
- "solista": la ficha lleva el nombre de UNA persona, real o artístico (Ilan Chester, Rudy Márquez, Cecilia Todd).
- "proyecto_personal": la ficha es de UNA persona pero con un nombre que no es de persona (Zardonic, Ashwave, «Chulius & The Filarmónicos»).
- "no_artista": recopilatorio, serie de discos, sello, festival, programa o similar.
- "desconocido": los textos no permiten decidirlo.

titular (solo para solista y proyecto_personal): un OBJETO {name, personId, evidence:{quote, sourceRef}} (nunca un texto suelto). Para solista: la persona con el nombre de la ficha tal como lo escriben los textos. Para proyecto_personal: la PERSONA detrás del proyecto (su nombre real o con el que firma, p. ej. «Federico Ágreda» para Zardonic), NUNCA el nombre del proyecto; si los textos no la nombran, titular = null. En banda, no_artista o desconocido: null.

members (solo para banda): personas que los textos presentan como integrantes de ESTA banda en cualquier época (fundadores, formación, alineación, «integrada por», «X en la guitarra», «el bajista X», «se unió», «salió»).
NO incluyas: invitados, músicos de sesión, productores, ingenieros, managers, ni integrantes de OTRAS bandas que el texto nombra. Para solista o proyecto_personal, members = [] (sus músicos acompañantes no son integrantes).
Cada integrante:
- name: tal como aparece en el texto (cópialo; con apodo entre comillas si el texto lo trae, p. ej. José «Pingüino» Echezuría). No inventes apellidos. Si el texto solo da un nombre de pila o un apodo, cópialo así.
- personId: el de credited si es claramente la misma persona; si no, null.
- role: instrumento(s) o función en español (voz, guitarra, bajo, batería, teclados…); «integrante» si el texto no lo dice.
- fromYear / toYear / current: solo si el texto lo dice; si no, null.
- evidence: {quote: fragmento LITERAL copiado del texto (máximo 200 caracteres) que contiene el nombre, sourceRef}.
No dupliques personas: una entrada por persona aunque toque varios instrumentos o aparezca en varias fuentes.
Si las fuentes hablan de una banda homónima distinta (otro país, otra época u otro género que no encaja con catalog/bio), ignóralas y explícalo en note.
note: dudas para revisión humana o null. Devuelve {caseId, kind, titular, members, note}.`;

const normalize = (text: string) => text.normalize("NFKD").replace(/[̀-ͯ]/gu, "").toLowerCase()
  .replace(/[«»"“”'’`´]/gu, "").replace(/\s+/gu, " ").trim();
const tokens = (text: string) => normalize(text).replace(/[^a-z0-9 ]/gu, " ").split(" ").filter((token) => token.length > 1);

function sourceText(dossier: MemberDossier, ref: string): string | null {
  if (ref === "bio") return dossier.bio;
  const source = dossier.sources.find((item) => item.ref === ref);
  if (!source) return null;
  return `${source.text}\n${source.facts ? JSON.stringify(source.facts) : ""}`;
}

/** Errores de una persona extraída: la cita debe estar en la fuente y nombrarla. */
function evidenceProblems(dossier: MemberDossier, name: string, evidence: { quote: string; sourceRef: string }): string | null {
  const text = sourceText(dossier, evidence.sourceRef);
  if (text === null) return `«${name}»: sourceRef ${evidence.sourceRef} no existe`;
  const quote = normalize(evidence.quote);
  if (!quote || !normalize(text).includes(quote)) return `«${name}»: la cita no está literal en ${evidence.sourceRef}`;
  const quoteTokens = new Set(tokens(evidence.quote));
  const nameTokens = tokens(name);
  if (!nameTokens.length || !nameTokens.every((token) => quoteTokens.has(token))) return `«${name}»: el nombre no aparece completo en la cita`;
  return null;
}

function validate(dossier: MemberDossier, answer: MemberExtraction): { clean: MemberExtraction; problems: string[] } {
  const problems: string[] = [];
  if (answer.caseId !== dossier.caseId) problems.push(`caseId devuelto ${answer.caseId}`);
  let titular = answer.titular;
  if (titular) {
    const problem = evidenceProblems(dossier, titular.name, titular.evidence);
    if (problem) { problems.push(`titular ${problem}`); titular = null; }
  }
  const seen = new Set<string>();
  const members = answer.members.filter((member) => {
    const problem = evidenceProblems(dossier, member.name, member.evidence);
    if (problem) { problems.push(problem); return false; }
    const key = normalize(member.name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const credited = new Set(dossier.credited.map((person) => person.personId));
  for (const member of members) if (member.personId !== null && !credited.has(member.personId)) member.personId = null;
  if (titular?.personId != null && !credited.has(titular.personId)) titular = { ...titular, personId: null };
  return { clean: { ...answer, titular, members }, problems };
}

const readJsonl = <T,>(file: string): T[] => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as T) : []);

interface OutputRow extends MemberExtraction { artistId: number; name: string; model: string; dropped: string[] }

async function main(): Promise<void> {
  const dossiers = readJsonl<MemberDossier>(IN)
    .filter((dossier) => dossier.bio || dossier.sources.length || dossier.credited.length)
    .filter((dossier) => !ONLY || ONLY.includes(dossier.artistId));
  const done = new Map(readJsonl<OutputRow>(OUT).map((row) => [row.caseId, row]));
  const pending = dossiers.filter((dossier) => !done.has(dossier.caseId)).slice(0, LIMIT);
  const gateway = createDeepSeekGateway();
  const stats = { pending: pending.length, written: 0, retried: 0, cached: 0, failed: [] as Array<{ caseId: string; error: string }>, hashes: [] as string[] };
  // Escribe TODO lo hecho, también lo que quedó fuera de --ids/--limit (antes una corrida parcial borraba el resto).
  const flush = () => writeFileSync(OUT, [...done.values()].map((row) => JSON.stringify(row)).join("\n") + "\n");

  const queue = [...pending];
  const worker = async () => {
    for (let dossier = queue.shift(); dossier; dossier = queue.shift()) {
      try {
        const ask = (fix?: string) => gateway.propose({
          taskKind: "narrative_extraction", modelClass: "fast", schemaVersion: SCHEMA_VERSION, instructions: INSTRUCTIONS, responseSchema,
          input: fix ? { ...dossier, correccion: fix } : dossier,
        });
        let result = await ask();
        let checked = validate(dossier, result.proposal);
        if (checked.problems.length) {
          stats.retried += 1;
          result = await ask(`Tu respuesta anterior tuvo estos errores: ${checked.problems.slice(0, 15).join("; ")}. Corrige: copia citas literales que contengan el nombre completo, o quita a la persona.`);
          checked = validate(dossier, result.proposal);
        }
        done.set(dossier.caseId, { ...checked.clean, artistId: dossier.artistId, name: dossier.name, model: result.model, dropped: checked.problems });
        flush();
        stats.written += 1;
        if (result.cached) stats.cached += 1;
        stats.hashes.push(result.promptHash);
        if (stats.written % 100 === 0) console.error(`${stats.written}/${pending.length}`);
      } catch (error) {
        stats.failed.push({ caseId: dossier.caseId, error: (error as Error).message.slice(0, 300) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
  const usage = (await getPool().query<{ tin: string | null; tout: string | null }>(
    "SELECT sum(tokens_in)::text tin, sum(tokens_out)::text tout FROM ingest.ai_runs WHERE prompt_hash = ANY($1)", [stats.hashes])).rows[0];
  const { hashes: _hashes, ...summary } = stats;
  console.log(JSON.stringify({ ...summary, tokensIn: Number(usage?.tin ?? 0), tokensOut: Number(usage?.tout ?? 0) }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => closeDb());
