// CRV · Personas con nombre roto (Brian, 2026-10-04: «limpiar con la opción B»).
// Derivado de scripts/cleanup-sincopa-junk-persons.ts (rama sincopa-promocion,
// run 11460), con los casos del barrido del 2026-10-04:
//
//  * rótulos que faltaban: «Text: X» (letra), «Adapt: X» (adaptación),
//    «Ver: X» (versión), «M: X» (música), «(Director: X)» (dirección);
//  * signos sobrantes al principio («- Marco Martini», «: Orlando Chaparro»);
//  * «A/B» (dos personas en una) se parte SOLO si cada parte enlaza con una
//    única persona existente: el crédito queda en A y se crea otro igual para B;
//  * agrupaciones y empresas tipadas como persona pasan a artista u organización.
//
// Lo que no se decide sin mirar queda como `revisar` en el plan, para Brian.
//
//   tsx scripts/cleanup-personas-rotas-2026-10-04.ts --audit=… --out=…               # ensayo
//   tsx scripts/cleanup-personas-rotas-2026-10-04.ts --audit=… --confirm --note="…" --out=…
import { readFileSync, writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";
import { convertPerson } from "../src/review/person-corrections.js";
import { createEntity, createRelation, deleteEntity, deleteRelation, updateEntity, updateRelation, withOperatorRun, type OperatorContext } from "../src/merge/operator.js";
import { normalizeEntityName } from "../src/normalization/entity-name.js";

const arg = (name: string) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const fold = (text: string) => text.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase().replace(/[^\p{L}\d]+/gu, " ").trim();

type CreditType = "musician" | "guest" | "writer" | "composer" | "producer" | "recording" | "mixing" | "mastering" | "photography" | "artwork" | "other";
type Action =
  | { action: "borrar"; why: string }
  | { action: "reasignar"; target: string; role?: { creditType: CreditType; role: string }; alias?: string; why: string }
  | { action: "convertir"; to: "artist" | "organization"; name: string; organizationType?: string; why: string }
  | { action: "partir"; targets: string[]; why: string }
  | { action: "dejar" | "revisar"; why: string };

interface Person { id: number; name: string; rule: string }
interface Credit { kind: "track_credit" | "album_credit"; id: number; role: string; creditType: string; workId: number; workTitle: string; workNotes: string | null }

// Rol pegado al nombre → rol del crédito.
const PREFIXES: Array<{ re: RegExp; role?: { creditType: CreditType; role: string }; label: string }> = [
  { re: /^(?:featuring|feat|ft)\.?\s+(.+)$/iu, role: { creditType: "guest", role: "Invitado" }, label: "Feat." },
  { re: /^(?:arreglos?|arr)\s*[.:]\s*(.+)$/iu, role: { creditType: "other", role: "Arreglos" }, label: "Arr." },
  { re: /^comp\s*[.:]\s*(.+)$/iu, role: { creditType: "composer", role: "composer" }, label: "Comp." },
  { re: /^(?:recopilaci[oó]n|compilaci[oó]n|compilation|recop|recp|rec)\s*[.:]\s*(?:de\s+)?(.+)$/iu, role: { creditType: "other", role: "Recopilación" }, label: "Recop." },
  { re: /^(?:lyrics|letra)\s*:\s*(.+)$/iu, role: { creditType: "writer", role: "Letra" }, label: "Lyrics" },
  { re: /^detail by\s+(.+)$/iu, label: "Detail by" },
  { re: /^(?:text|texto)\s*:\s*(.+)$/iu, role: { creditType: "writer", role: "Letra" }, label: "Text" },
  { re: /^(?:adapt|adpt|adaptaci[oó]n)\s*[.:]\s*(.+)$/iu, role: { creditType: "other", role: "Adaptación" }, label: "Adapt." },
  { re: /^(?:spanish\s+)?(?:vers?|versi[oó]n)\s*[.:]\s*(.+)$/iu, role: { creditType: "other", role: "Versión" }, label: "Ver." },
  { re: /^(?:arrg|arranger)\s*[.:]\s*(.+)$/iu, role: { creditType: "other", role: "Arreglos" }, label: "Arr." },
  { re: /^recompilation\s*:\s*(.+)$/iu, role: { creditType: "other", role: "Recopilación" }, label: "Recop." },
  { re: /^(?:written|l)\s*:\s*(.+)$/iu, role: { creditType: "writer", role: "Letra" }, label: "Letra" },
  { re: /^loc\s*:\s*(.+)$/iu, role: { creditType: "other", role: "Locución" }, label: "Loc." },
  { re: /^(?:m|m[uú]sica)\s*:\s*(.+)$/iu, role: { creditType: "composer", role: "composer" }, label: "M:" },
  { re: /^\(?\s*director\s*:\s*([^)]+)\)?$/iu, role: { creditType: "other", role: "Dirección" }, label: "Director" },
  { re: /^[\s\-–—:.,;]+(.+)$/u, label: "signo sobrante" },
];
// Abreviaturas de un mismo nombre que la fuente usa sin coma.
const SAME_AS: Record<string, string> = {
  "v e sojo": "Vicente Emilio Sojo", "ve sojo": "Vicente Emilio Sojo", "vicente e sojo": "Vicente Emilio Sojo", "v emilio sojo": "Vicente Emilio Sojo",
};
const PLACE = /^(?:pueblo|costa|regi[oó]n|estado|isla|valle)\s+(?:de|del)\b/iu;
const GROUP = /^(?:los|las|grupo|conjunto|orquesta|ensamble|banda|coro|quinteto|cuarteto|trio|trío|dúo|duo)\s|(?<![\p{L}\d])(?:experimental|grupo|conjunto|ensamble|orquesta|coral|coro|banda|cultural|pueblo|fundaci[oó]n)(?![\p{L}\d])|\p{L}-\p{L}/iu;
const INITIALS = /(?:^|\s)\p{L}\.(?:\s|\p{L}|$)/u;

// Nombres entre comillas revisados uno por uno contra su evidencia.
const QUOTED: Record<number, Action> = {
  7456: { action: "borrar", why: "gira: «Recorded Live during Tour: “La Ultima Cruzada”»" },
  20023: { action: "borrar", why: "título de la obra de portada" }, 22716: { action: "borrar", why: "título de la obra de portada" },
  23475: { action: "borrar", why: "título de los dibujos de portada" }, 23476: { action: "borrar", why: "título de los dibujos de portada" },
  26590: { action: "borrar", why: "título de una edición anterior del disco" }, 31737: { action: "borrar", why: "título de la obra de portada" },
  31964: { action: "borrar", why: "título de la obra de portada" }, 32061: { action: "borrar", why: "subtítulo de la pista entre paréntesis" },
  33817: { action: "borrar", why: "título de la obra de portada" }, 33821: { action: "borrar", why: "título de la obra de portada" },
  34623: { action: "borrar", why: "disco de origen: «Musicians on: “Una Fan Enamorada”»" }, 36821: { action: "borrar", why: "disco de origen de las pistas" },
  36824: { action: "borrar", why: "disco de origen de la pista" }, 36827: { action: "borrar", why: "disco de origen de las pistas" },
  37902: { action: "borrar", why: "título de la obra de portada" },
  27859: { action: "convertir", to: "artist", name: "Los Cancilleres Del Sabor", why: "orquesta" },
  26619: { action: "convertir", to: "artist", name: "Los Hijos De Alfredo", why: "agrupación (acordeones)" },
  37813: { action: "convertir", to: "artist", name: "La Otra Gente", why: "agrupación (coros)" },
};
const NAMED: Record<string, Action> = {
  "ensamble gurrufio": { action: "convertir", to: "artist", name: "Ensamble Gurrufío", why: "agrupación ya catalogada" },
  "rios reyna concert hall": { action: "convertir", to: "organization", name: "Sala Ríos Reyna", organizationType: "other", why: "sala de conciertos del Teresa Carreño" },
  "ethnosonics lab": { action: "convertir", to: "organization", name: "Ethnosonics Lab", organizationType: "recording_studio", why: "estudio" },
  "acoustic recording service": { action: "convertir", to: "organization", name: "Acoustic Recording Service", organizationType: "recording_studio", why: "estudio" },
  "ollewood mix room": { action: "convertir", to: "organization", name: "Ollewood Mix Room", organizationType: "recording_studio", why: "estudio" },
  "design m design w": { action: "convertir", to: "organization", name: "Design M Design W", organizationType: "other", why: "estudio de diseño gráfico" },
  "folklore oriental": { action: "borrar", why: "origen de la pieza, no autor («Polo Margariteño (Folklore Oriental)»)" },
  "d r a": { action: "borrar", why: "rótulo de derechos («(D.R.A.)»), no autor" },
  "free": { action: "borrar", why: "rótulo («(free)», improvisación libre)" },
  "piano solo": { action: "borrar", why: "rótulo de la versión («(piano solo)»)" },
  "tan fredericks": { action: "dejar", why: "la ficha de Sincopa trae el nombre cortado; no hay otra fuente" },
  "mar oliveros": { action: "dejar", why: "la ficha de Sincopa trae el nombre cortado; no hay otra fuente" },
  "hijo": { action: "dejar", why: "apodo de un músico («Bass: hijo»)" },
};

interface Index { persons: Map<string, number[]>; artists: Map<string, number[]>; organizations: Map<string, number[]>; members: Set<string> }

async function loadIndex(): Promise<Index> {
  const pool = getPool();
  const add = (map: Map<string, number[]>, name: string, id: number) => {
    const key = fold(name);
    const list = map.get(key) ?? [];
    if (!list.includes(id)) list.push(id);
    map.set(key, list);
  };
  const index: Index = { persons: new Map(), artists: new Map(), organizations: new Map(), members: new Set() };
  for (const row of (await pool.query<{ id: string; name: string }>(
    "SELECT id::text, name FROM public.persons UNION ALL SELECT person_id::text, alias FROM ingest.person_aliases")).rows) add(index.persons, row.name, Number(row.id));
  for (const row of (await pool.query<{ id: string; name: string }>("SELECT id::text, name FROM public.artists")).rows) add(index.artists, row.name, Number(row.id));
  for (const row of (await pool.query<{ person_id: string; artist_id: string }>("SELECT person_id::text, artist_id::text FROM public.artist_members")).rows) index.members.add(`${row.person_id}:${row.artist_id}`);
  for (const row of (await pool.query<{ id: string; name: string }>("SELECT id::text, name FROM public.organizations")).rows) add(index.organizations, row.name, Number(row.id));
  return index;
}

function decide(person: Person): Action {
  if (QUOTED[person.id]) return QUOTED[person.id]!;
  const named = NAMED[fold(person.name)];
  if (named) return named;
  if (person.rule.endsWith("organizacion")) {
    const company = /\b(?:c\.?\s?a\.?|s\.?\s?a\.?|compa[nñ][ií]a|music|producciones|records|studios?)\b/iu.test(person.name) && !/\b(?:orquesta|orchestra|coro|banda|ensamble|ensemble|conjunto)\b/iu.test(person.name);
    return company
      ? { action: "convertir", to: "organization", name: person.name.trim(), organizationType: "other", why: "empresa tipada como persona" }
      : { action: "convertir", to: "artist", name: person.name.trim(), why: "agrupación tipada como persona" };
  }
  if (person.rule.endsWith("multiple_people")) {
    const parts = person.name.split(/\s*\/\s*/u).map((part) => part.trim()).filter(Boolean);
    if (parts.length >= 2 && parts.every((part) => part.includes(" "))) return { action: "partir", targets: parts, why: "dos personas en una («A/B»)" };
    return { action: "revisar", why: "«A/B» con apellidos o palabras sueltas: sin enlace seguro" };
  }
  if (person.rule.endsWith("parentesis-de-titulo")) return { action: "borrar", why: "título entre paréntesis de una pista" };
  const aka = /^(.+?)\s+a\.?\s?k\.?\s?a\.?\s+(.+)$/iu.exec(person.name);
  if (aka) return { action: "reasignar", target: aka[1]!.trim(), alias: aka[2]!.trim(), why: "nombre con su alias (a.k.a.)" };
  for (const prefix of PREFIXES) {
    const hit = prefix.re.exec(person.name);
    if (!hit) continue;
    const target = SAME_AS[fold(hit[1]!)] ?? hit[1]!.trim();
    if (/^d\.?\s?r\.?$/iu.test(target)) return { action: "borrar", why: `«${prefix.label} D.R.»: derechos reservados, no autor` };
    if (PLACE.test(target)) return { action: "borrar", why: `«${prefix.label}» de un lugar («${target}»): queda como nota` };
    return { action: "reasignar", target, ...(prefix.role ? { role: prefix.role } : {}), why: `rótulo «${prefix.label}» pegado al nombre` };
  }
  if (person.rule.endsWith("rotulo") || person.rule.endsWith("parece-un-titulo")) return { action: "borrar", why: "rótulo sin persona («Live», «Bonus Track», «3rd Mov»)" };
  if (person.rule.endsWith("numeros")) return { action: "dejar", why: "nombre con números legítimo (estudio, DJ, banda)" };
  return { action: "revisar", why: `regla ${person.rule} sin acción automática` };
}

/** Dónde cae una reasignación: persona existente, artista (grupos), o renombrar la ficha. */
function resolveTarget(index: Index, junkId: number, target: string): { kind: "person" | "artist"; id?: number; rename?: true } | { review: string } {
  const key = fold(target);
  const artists = index.artists.get(key) ?? [];
  const persons = (index.persons.get(key) ?? []).filter((id) => id !== junkId);
  if (artists.length > 1) return { review: `hay ${artists.length} artistas llamados «${target}»` };
  if (artists.length === 1) {
    // De un solista, el crédito va a su persona (titular del artista); una
    // «persona» homónima que no integra al artista es el grupo mal tipado
    // («Un Solo Pueblo»): el crédito va al artista.
    const titular = persons.filter((id) => index.members.has(`${id}:${artists[0]}`));
    if (titular.length === 1) return { kind: "person", id: titular[0]! };
    const memberCount = [...index.members].filter((pair) => pair.endsWith(`:${artists[0]}`)).length;
    if (GROUP.test(target) || memberCount >= 2 || persons.length === 0) return { kind: "artist", id: artists[0]! };
    if (persons.length === 1) return { kind: "person", id: persons[0]! };
    return { review: `hay ${persons.length} personas llamadas «${target}» y un artista homónimo` };
  }
  if (GROUP.test(target)) return { review: `«${target}» parece un grupo que no está catalogado como artista` };
  if (persons.length === 1) return { kind: "person", id: persons[0]! };
  if (persons.length > 1) return { review: `hay ${persons.length} personas llamadas «${target}»` };
  if (INITIALS.test(target)) return { review: `«${target}» lleva iniciales: no se crea sin enlace seguro` };
  if (!target.includes(" ")) return { review: `«${target}» es una sola palabra: no se crea sin enlace seguro` };
  return { kind: "person", rename: true };
}

async function creditsOf(context: OperatorContext | undefined, personId: number): Promise<Credit[]> {
  const queryable = context?.client ?? getPool();
  const { rows } = await queryable.query<{ kind: Credit["kind"]; id: string; role: string; credit_type: string; work_id: string; work_title: string; work_notes: string | null }>(`
    SELECT 'track_credit' AS kind, tc.id::text, tc.role, tc.credit_type::text, t.id::text AS work_id, t.title AS work_title, t.notes AS work_notes
      FROM public.track_credits tc JOIN public.tracks t ON t.id=tc.track_id WHERE tc.person_id=$1
    UNION ALL
    SELECT 'album_credit', ac.id::text, ac.role, ac.credit_type::text, a.id::text, a.title, a.notes
      FROM public.album_credits ac JOIN public.albums a ON a.id=ac.album_id WHERE ac.person_id=$1`, [personId]);
  return rows.map((row) => ({ kind: row.kind, id: Number(row.id), role: row.role, creditType: row.credit_type, workId: Number(row.work_id), workTitle: row.work_title, workNotes: row.work_notes }));
}

/** El texto retirado queda como nota de la obra, salvo que el título ya lo diga. */
async function keepAsNote(context: OperatorContext, credit: Credit, text: string, notedWorks: Set<string>): Promise<boolean> {
  const bare = text.replace(/^["“”«»']+|["“”«»']+$/gu, "").trim();
  if (fold(credit.workTitle).includes(fold(bare))) return false;
  const key = `${credit.kind}:${credit.workId}:${fold(bare)}`;
  if (notedWorks.has(key) || (credit.workNotes ?? "").includes(bare)) return false;
  notedWorks.add(key);
  const label = credit.kind === "album_credit" && !/^composer$/iu.test(credit.role) ? `${credit.role}: «${bare}»` : `«${bare}»`;
  const line = `Fuente: ${label}`;
  const current = (await context.client.query<{ notes: string | null }>(
    `SELECT notes FROM public.${credit.kind === "track_credit" ? "tracks" : "albums"} WHERE id=$1`, [credit.workId])).rows[0]?.notes ?? null;
  await updateEntity(context, credit.kind === "track_credit" ? "track" : "album", credit.workId, { notes: current ? `${current}\n${line}` : line });
  return true;
}

async function main(): Promise<void> {
  const auditFile = arg("audit");
  if (auditFile === undefined) throw new Error("--audit obligatorio");
  const confirm = process.argv.includes("--confirm");
  const note = arg("note") ?? "Personas con nombre roto: rótulo al rol, «A/B» con enlace seguro, agrupaciones y empresas a su tipo (opción B, Brian 2026-10-04)";
  const audited = (JSON.parse(readFileSync(auditFile, "utf8")).persons as Array<{ id: number; name: string; rule: string }>);
  const { rows: quoted } = await getPool().query<{ id: string; name: string }>(
    `SELECT id::text, name FROM public.persons WHERE name ~ '^\\s*["“”«].*["“”»]\\s*$'`);
  const people = new Map<number, Person>();
  for (const person of audited) people.set(person.id, { id: person.id, name: person.name, rule: person.rule });
  for (const row of quoted) if (!people.has(Number(row.id))) people.set(Number(row.id), { id: Number(row.id), name: row.name, rule: "entre-comillas" });

  const index = await loadIndex();
  const existing = new Set((await getPool().query<{ id: string }>("SELECT id::text FROM public.persons WHERE id = ANY($1::bigint[])", [[...people.keys()]])).rows.map((row) => Number(row.id)));
  const plan = [...people.values()].filter((person) => existing.has(person.id)).map((person) => {
    let action = decide(person);
    if (person.rule === "entre-comillas" && QUOTED[person.id] === undefined) action = { action: "dejar", why: "apodo entre comillas de una persona real" };
    let target: ReturnType<typeof resolveTarget> | undefined;
    if (action.action === "reasignar") {
      target = resolveTarget(index, person.id, action.target);
      if ("review" in target) action = { action: "revisar", why: target.review };
    }
    let parts: number[] | undefined;
    if (action.action === "partir") {
      const resolved = action.targets.map((name) => resolveTarget(index, person.id, name));
      if (resolved.every((item) => !("review" in item) && item.kind === "person" && item.id !== undefined)) {
        parts = resolved.map((item) => (item as { id: number }).id);
      } else {
        action = { action: "revisar", why: `«A/B»: alguna parte no enlaza con una única persona existente (${action.targets.join(" · ")})` };
      }
    }
    return { ...person, ...action, ...(target && !("review" in target) ? { resolved: target } : {}), ...(parts ? { parts } : {}) };
  });

  const tally: Record<string, number> = {};
  for (const item of plan) tally[item.action] = (tally[item.action] ?? 0) + 1;
  const outcome = { applied: 0, failed: 0, creditsMoved: 0, creditsRemoved: 0, notes: 0, errors: [] as Array<{ id: number; name: string; error: string }> };
  let runId: number | undefined;

  if (confirm) {
    const result = await withOperatorRun({ name: "cleanup-personas-rotas", operator: "brian", note, params: { audit: auditFile } }, async (context) => {
      const notedWorks = new Set<string>();
      for (const item of plan) {
        if (item.action === "dejar" || item.action === "revisar") continue;
        await context.client.query("SAVEPOINT junk_person");
        try {
          const credits = await creditsOf(context, item.id);
          if (item.action === "borrar") {
            for (const credit of credits) {
              if (await keepAsNote(context, credit, item.name, notedWorks)) outcome.notes += 1;
              await deleteRelation(context, credit.kind, credit.id);
              outcome.creditsRemoved += 1;
            }
            await deleteEntity(context, "person", item.id);
          } else if (item.action === "reasignar") {
            const resolved = (item as { resolved: { kind: "person" | "artist"; id?: number; rename?: true } }).resolved;
            const role = item.role === undefined ? {} : { credit_type: item.role.creditType, role: item.role.role };
            if (resolved.rename) {
              for (const credit of credits) if (Object.keys(role).length) await updateRelation(context, credit.kind, credit.id, role);
              await updateEntity(context, "person", item.id, { name: item.target });
            } else {
              const endpoint = resolved.kind === "artist" ? { artist_id: resolved.id } : { person_id: resolved.id };
              for (const credit of credits) {
                await updateRelation(context, credit.kind, credit.id, { ...role, ...endpoint });
                outcome.creditsMoved += 1;
              }
              await deleteEntity(context, "person", item.id);
            }
            const aliasOwner = resolved.rename ? item.id : resolved.kind === "person" ? resolved.id : undefined;
            if (item.alias && aliasOwner !== undefined) {
              await context.client.query(`
                INSERT INTO ingest.person_aliases(person_id,alias,alias_type,normalized_alias,is_primary,confidence,notes)
                SELECT $1::bigint,$2::text,'name_variant',$3::text,false,'high',$4::text
                 WHERE NOT EXISTS (SELECT 1 FROM ingest.person_aliases WHERE person_id=$1::bigint AND normalized_alias=$3::text)`,
              [aliasOwner, item.alias, normalizeEntityName(item.alias).primaryKey, `Alias de «${item.name}» en Sincopa (run ${context.runId})`]);
            }
          } else if (item.action === "partir") {
            const parts = (item as { parts: number[] }).parts;
            for (const credit of credits) {
              const values = { role: credit.role, credit_type: credit.creditType };
              const parent = credit.kind === "track_credit" ? { trackId: credit.workId } : { albumId: credit.workId };
              await updateRelation(context, credit.kind, credit.id, { person_id: parts[0] });
              for (const other of parts.slice(1)) await createRelation(context, credit.kind, { ...parent, personId: other }, values);
              outcome.creditsMoved += 1;
            }
            await deleteEntity(context, "person", item.id);
          } else if (item.action === "convertir") {
            const table = item.to === "artist" ? index.artists : index.organizations;
            const found = table.get(fold(item.name)) ?? [];
            if (found.length > 1) throw new Error(`hay ${found.length} fichas llamadas «${item.name}»`);
            const targetId = found[0] ?? (await createEntity(context, item.to, item.to === "artist"
              ? { name: item.name, artist_type: "group" }
              : { name: item.name, organization_type: item.organizationType ?? "other" })).id;
            const converted = await convertPerson(context.client, item.id, { kind: item.to, id: targetId }, false, `[run ${context.runId}] ${note}: ${item.why}`, context.runId);
            outcome.creditsMoved += converted.credits;
          }
          await context.client.query("RELEASE SAVEPOINT junk_person");
          outcome.applied += 1;
        } catch (error) {
          await context.client.query("ROLLBACK TO SAVEPOINT junk_person");
          outcome.failed += 1;
          outcome.errors.push({ id: item.id, name: item.name, error: (error as Error).message });
        }
      }
      return outcome;
    });
    runId = result.runId;
  }
  const out = arg("out");
  const report = { dryRun: !confirm, runId, persons: plan.length, byAction: tally, ...(confirm ? outcome : {}) };
  if (out !== undefined) writeFileSync(out, `${JSON.stringify({ ...report, plan }, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, errors: confirm ? outcome.errors.slice(0, 20) : undefined }, null, 2));
}

main().then(() => closeDb()).then(() => process.exit(0), async (error) => {
  console.error(error);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
