// CRV · Aplicador de integrantes (Brian, 2026-10-01: «apruebo todo»).
//
// Llena la pestaña Miembros de los artistas que no tenían ninguno, en runs del
// operador (diario de cambios: se deshacen por run). Tres fases:
//
//   structured  Listas de miembros ya cosechadas para las biografías
//               (Lobotoradio «miembros» si la ficha es banda, Discogs y
//               MusicBrainz). Rol «Integrante».
//   credits     Regla de Brian: quien figura como MÚSICO (no invitado) en los
//               discos propios de una BANDA (sin recopilatorios) es integrante;
//               rol = sus créditos; años = los de esos discos.
//   llm         Lo extraído por DeepSeek flash (scripts/extract-members-deepseek.mts):
//               integrantes de bandas con su cita, y el titular de solistas y
//               proyectos personales (rol «Titular del proyecto», caso Ashwave),
//               que además corrige `artist_type` (solo_artist / project).
//
// Personas (regla de Brian: solo con proyecto común): se reutiliza una persona
// existente si está acreditada en los discos de ese artista, o si su nombre
// coincide exacto y figura en otro artista que los textos de esta ficha
// nombran. Si no, se crea; cuando había homónimos sin vínculo, el par queda en
// el reporte como posible duplicado para revisión manual.
//
// Uso: tsx scripts/apply-members.mts --phase=structured|credits|llm --dossiers=<jsonl> [--extraction=<jsonl>] [--ids=…] [--confirm]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";
import { createEntity, createRelation, updateEntity, withOperatorRun, type OperatorContext } from "../src/merge/operator.js";
import { nameWithoutNickname } from "../src/review/person-names.js";
import type { MemberDossier } from "./export-member-dossiers.mjs";
import type { MemberExtraction } from "./extract-members-deepseek.mjs";

const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const PHASE = arg("phase") as "structured" | "credits" | "llm" | undefined;
const DOSSIERS = arg("dossiers") ?? "reports/member-dossiers/member-dossiers.jsonl";
const EXTRACTION = arg("extraction") ?? "reports/member-dossiers/member-extraction.jsonl";
const ONLY = arg("ids")?.split(",").map(Number);
const CONFIRM = process.argv.includes("--confirm");
const CHUNK = 150;
const OPERATOR = "claude-code (delegado por Brian)";
const TITULAR_ROLE = "Titular del proyecto";

interface Planned { name: string; personId: number | null; role: string; fromYear: number | null; toYear: number | null; current: boolean | null; evidence: string }
interface ArtistPlan { artistId: number; artistName: string; members: Planned[]; artistType?: "solo_artist" | "project" }
type ExtractionRow = MemberExtraction & { artistId: number };

const readJsonl = <T,>(file: string): T[] => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T) : []);
const fold = (text: string) => text.normalize("NFKD").replace(/[̀-ͯ]/gu, "").toLowerCase();
const key = (name: string) => nameWithoutNickname(name.replace(/\s*\(\d+\)\s*$/u, ""));
const tokens = (name: string) => key(name).split(/\s+/u).filter((token) => token.length > 1);
const clean = (name: string) => name.replace(/\s*\(\d+\)\s*$/u, "").replace(/\s+/gu, " ").trim();

/** Misma persona dentro de UNA ficha: clave igual, o los tokens de un nombre contenidos en el otro (≥2 y mismo apellido). */
function sameWithinArtist(left: string, right: string): boolean {
  if (key(left) === key(right)) return true;
  const a = tokens(left);
  const b = tokens(right);
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 2 && short.every((token) => long.includes(token)) && short[short.length - 1] === long[long.length - 1];
}

function dossierText(dossier: MemberDossier): string {
  return fold([dossier.bio ?? "", ...dossier.sources.map((source) => `${source.text} ${source.facts ? JSON.stringify(source.facts) : ""}`)].join("\n"));
}

function splitNames(value: unknown): string[] {
  return String(value ?? "").split(/\s*,\s*/u).map(clean).filter((name) => name.length > 1);
}

/** «Nombre (1998–2017)» de las listas de MusicBrainz → nombre y años aparte. */
function withYears(entry: string): { name: string; fromYear: number | null; toYear: number | null } {
  const match = /^(.*?)\s*\((\d{4})?\s*[-–]?\s*(\d{4})?\)\s*$/u.exec(entry);
  if (!match || (!match[2] && !match[3])) return { name: entry, fromYear: null, toYear: null };
  return { name: match[1]!.trim(), fromYear: match[2] ? Number(match[2]) : null, toYear: match[3] ? Number(match[3]) : null };
}

/**
 * Listas estructuradas (Lobotoradio, Discogs, MusicBrainz). Discogs y MusicBrainz confunden homónimos (Sangre,
 * Guarapita), así que una lista solo cuenta si la IA clasificó la ficha como banda Y confirmó con cita a alguien de
 * ESA lista: entonces la fuente habla de esta banda y se aplica entera.
 */
function structuredPlan(dossier: MemberDossier, row: ExtractionRow | undefined): Planned[] {
  const out: Planned[] = [];
  if (row?.kind !== "banda") return out;
  for (const source of dossier.sources) {
    const facts = source.facts ?? {};
    const lists: string[] = [];
    if (source.source === "lobotoradio" && facts["miembros"] && String(facts["tipo"] ?? "banda").toLowerCase() === "banda") lists.push(...splitNames(facts["miembros"]));
    if (facts["miembros (Discogs)"]) lists.push(...splitNames(facts["miembros (Discogs)"]));
    if (facts["miembros (MusicBrainz)"]) lists.push(...splitNames(facts["miembros (MusicBrainz)"]));
    const entries = lists.map(withYears);
    if (!entries.some((entry) => row.members.some((member) => sameWithinArtist(member.name, entry.name)))) continue;
    for (const entry of entries) {
      if (out.some((item) => sameWithinArtist(item.name, entry.name))) continue;
      out.push({ ...entry, personId: null, role: "Integrante", current: null, evidence: `Lista de miembros de ${source.source}: ${source.url ?? ""}` });
    }
  }
  return out;
}

function creditsPlan(dossier: MemberDossier): Planned[] {
  return dossier.credited.filter((person) => !person.guestOnly).map((person) => {
    const years = person.years.filter((year) => year > 0);
    return {
      name: person.name, personId: person.personId, role: person.roles.join(", ").slice(0, 200),
      fromYear: years.length ? Math.min(...years) : null, toYear: years.length ? Math.max(...years) : null, current: null,
      evidence: `Músico acreditado en sus discos propios (${years.join(", ") || "sin año"}); regla de Brian 2026-10-01`,
    };
  });
}

function llmPlan(dossier: MemberDossier, row: ExtractionRow): ArtistPlan | null {
  const source = (ref: string) => (ref === "bio" ? "biografía" : dossier.sources.find((item) => item.ref === ref)?.url ?? ref);
  if ((row.kind === "solista" || row.kind === "proyecto_personal") && row.titular) {
    return {
      artistId: dossier.artistId, artistName: dossier.name,
      artistType: row.kind === "solista" ? "solo_artist" : "project",
      members: [{ name: clean(row.titular.name), personId: row.titular.personId, role: TITULAR_ROLE, fromYear: null, toYear: null, current: null,
        evidence: `${source(row.titular.evidence.sourceRef)}: «${row.titular.evidence.quote}»` }],
    };
  }
  if (row.kind !== "banda") return null;
  return {
    artistId: dossier.artistId, artistName: dossier.name,
    members: row.members.map((member) => ({
      name: clean(member.name), personId: member.personId, role: member.role.slice(0, 200) || "Integrante",
      fromYear: member.fromYear, toYear: member.toYear, current: member.current,
      evidence: `${source(member.evidence.sourceRef)}: «${member.evidence.quote}»`,
    })),
  };
}

interface PersonIndex { byKey: Map<string, number[]> }

async function loadPersons(): Promise<PersonIndex> {
  const { rows } = await getPool().query<{ id: string; name: string }>(
    "SELECT id::text, name FROM public.persons UNION SELECT person_id::text, alias FROM ingest.person_aliases");
  const byKey = new Map<string, number[]>();
  for (const row of rows) {
    const k = key(row.name);
    if (!k) continue;
    const list = byKey.get(k) ?? [];
    if (!list.includes(Number(row.id))) list.push(Number(row.id));
    byKey.set(k, list);
  }
  return { byKey };
}

/** Artistas con los que la persona tiene membresía o crédito (para probar el proyecto común). */
async function linkedArtistNames(context: OperatorContext, personId: number): Promise<string[]> {
  const { rows } = await context.client.query<{ name: string }>(`
    SELECT ar.name FROM public.artist_members m JOIN public.artists ar ON ar.id=m.artist_id WHERE m.person_id=$1
    UNION SELECT ar.name FROM public.album_credits c JOIN public.albums al ON al.id=c.album_id JOIN public.artists ar ON ar.id=al.artist_id
     WHERE c.person_id=$1 AND ar.name <> 'Various Artists'
    UNION SELECT ar.name FROM public.track_credits tc JOIN public.tracks t ON t.id=tc.track_id JOIN public.albums al ON al.id=t.album_id
      JOIN public.artists ar ON ar.id=al.artist_id WHERE tc.person_id=$1 AND ar.name <> 'Various Artists'`, [personId]);
  return rows.map((row) => row.name);
}

interface Resolution { personId: number; how: "credited" | "proyecto-comun" | "homonimo-solista" | "nueva"; homonyms: number[] }

async function resolvePerson(
  context: OperatorContext, persons: PersonIndex, dossier: MemberDossier, planned: Planned, text: string, isTitular: boolean, created: Map<string, number>,
): Promise<Resolution> {
  if (planned.personId) return { personId: planned.personId, how: "credited", homonyms: [] };
  const credited = dossier.credited.find((person) => sameWithinArtist(person.name, planned.name));
  if (credited) return { personId: credited.personId, how: "credited", homonyms: [] };
  const candidates = persons.byKey.get(key(planned.name)) ?? [];
  // Un solista y su persona homónima (nombre de persona) son la misma ficha humana (caso Ashwave).
  if (isTitular && candidates.length === 1 && key(planned.name) === key(dossier.name)) return { personId: candidates[0]!, how: "homonimo-solista", homonyms: [] };
  const linked: number[] = [];
  for (const candidate of candidates) {
    const names = await linkedArtistNames(context, candidate);
    if (names.some((name) => fold(name).length >= 4 && fold(name) !== fold(dossier.name) && text.includes(fold(name)))) linked.push(candidate);
  }
  if (linked.length === 1) return { personId: linked[0]!, how: "proyecto-comun", homonyms: [] };
  const createdKey = `${dossier.artistId}:${key(planned.name)}`;
  const already = created.get(createdKey);
  if (already) return { personId: already, how: "nueva", homonyms: candidates };
  const person = await createEntity(context, "person", {
    name: planned.name,
    notes: `Alta 2026-10-01 como ${isTitular ? "titular" : "integrante"} de ${dossier.name}. ${planned.evidence}`.slice(0, 1000),
  }, { allowSimilar: true });
  created.set(createdKey, person.id);
  persons.byKey.set(key(planned.name), [...candidates, person.id]);
  return { personId: person.id, how: "nueva", homonyms: candidates };
}

async function main(): Promise<void> {
  if (!PHASE || !["structured", "credits", "llm"].includes(PHASE)) throw new Error("--phase=structured|credits|llm");
  const dossiers = readJsonl<MemberDossier>(DOSSIERS).filter((d) => !ONLY || ONLY.includes(d.artistId));
  const extraction = new Map(readJsonl<ExtractionRow>(EXTRACTION).map((row) => [row.artistId, row]));
  // La fase de créditos y la de la IA solo tocan BANDAS: los músicos de un solista no son integrantes.
  const isBand = (dossier: MemberDossier) => extraction.get(dossier.artistId)?.kind === "banda";

  const plans: ArtistPlan[] = [];
  for (const dossier of dossiers) {
    if (PHASE === "structured") {
      const members = structuredPlan(dossier, extraction.get(dossier.artistId));
      if (members.length) plans.push({ artistId: dossier.artistId, artistName: dossier.name, members });
    } else if (PHASE === "credits") {
      const members = creditsPlan(dossier);
      if (members.length && isBand(dossier)) plans.push({ artistId: dossier.artistId, artistName: dossier.name, members });
    } else {
      const row = extraction.get(dossier.artistId);
      const plan = row ? llmPlan(dossier, row) : null;
      if (plan?.members.length) plans.push(plan);
    }
  }
  const totalMembers = plans.reduce((sum, plan) => sum + plan.members.length, 0);
  console.log(`fase ${PHASE}: ${plans.length} artistas, ${totalMembers} integrantes propuestos`);
  if (!CONFIRM) {
    writeFileSync(`reports/apply-members-${PHASE}-dry-run.json`, JSON.stringify(plans, null, 2));
    console.log(`dry-run en reports/apply-members-${PHASE}-dry-run.json; ejecuta con --confirm`);
    await closeDb();
    return;
  }

  const persons = await loadPersons();
  const byId = new Map(dossiers.map((dossier) => [dossier.artistId, dossier]));
  const report = { phase: PHASE, runs: [] as number[], memberships: 0, alreadyMember: 0, personsCreated: 0, reused: {} as Record<string, number>,
    artistTypes: 0, possibleDuplicates: [] as unknown[], errors: [] as unknown[], applied: [] as unknown[] };
  for (let start = 0; start < plans.length; start += CHUNK) {
    const slice = plans.slice(start, start + CHUNK);
    const { runId } = await withOperatorRun({
      name: `miembros:${PHASE} (${start + 1}-${start + slice.length}/${plans.length})`,
      operator: OPERATOR,
      note: `Integrantes para artistas sin membresías (análisis 2026-10-01, aprobado por Brian), fase ${PHASE}.`,
    }, async (context) => {
      const created = new Map<string, number>();
      for (const plan of slice) {
        const dossier = byId.get(plan.artistId)!;
        const text = dossierText(dossier);
        await context.client.query("SAVEPOINT artist_plan");
        try {
          for (const planned of plan.members) {
            const isTitular = planned.role === TITULAR_ROLE;
            const resolved = await resolvePerson(context, persons, dossier, planned, text, isTitular, created);
            report.reused[resolved.how] = (report.reused[resolved.how] ?? 0) + 1;
            if (resolved.how === "nueva") report.personsCreated += 1;
            if (resolved.how === "nueva" && resolved.homonyms.length) {
              report.possibleDuplicates.push({ artistId: plan.artistId, artist: plan.artistName, name: planned.name, newPersonId: resolved.personId, homonyms: resolved.homonyms });
            }
            const exists = await context.client.query("SELECT 1 FROM public.artist_members WHERE artist_id=$1 AND person_id=$2", [plan.artistId, resolved.personId]);
            if (exists.rowCount) { report.alreadyMember += 1; continue; }
            await createRelation(context, "artist_membership", { artistId: plan.artistId, personId: resolved.personId }, {
              role: planned.role, from_year: planned.fromYear ?? undefined, to_year: planned.toYear ?? undefined,
              is_current: planned.current ? "true" : "false", notes: planned.evidence.slice(0, 500),
            });
            report.memberships += 1;
            report.applied.push({ artistId: plan.artistId, artist: plan.artistName, personId: resolved.personId, name: planned.name, role: planned.role, how: resolved.how });
          }
          if (plan.artistType) {
            await updateEntity(context, "artist", plan.artistId, { artist_type: plan.artistType });
            report.artistTypes += 1;
          }
          await context.client.query("RELEASE SAVEPOINT artist_plan");
        } catch (error) {
          await context.client.query("ROLLBACK TO SAVEPOINT artist_plan");
          report.errors.push({ artistId: plan.artistId, artist: plan.artistName, error: (error as Error).message.slice(0, 300) });
        }
      }
      return slice.length;
    });
    report.runs.push(runId);
    console.log(`run ${runId}: ${slice.length} artistas`);
  }
  writeFileSync(`reports/apply-members-${PHASE}-runs${report.runs[0]}-${report.runs.at(-1)}.json`, JSON.stringify(report, null, 2));
  const { applied: _applied, possibleDuplicates, errors, ...summary } = report;
  console.log(JSON.stringify({ ...summary, possibleDuplicates: possibleDuplicates.length, errors: errors.length }, null, 2));
  await closeDb();
}

main().catch(async (error: unknown) => { console.error(error); await closeDb(); process.exit(1); });
