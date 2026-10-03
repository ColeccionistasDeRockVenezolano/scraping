// Rótulos y conversiones que quedaron en reports/sincopa-revision-manual-2026-10-02.md,
// con las decisiones de Brian (2026-10-03):
//
//  * rol: rótulo con iniciales, una sola palabra o sigla («Arr: A. Lauro»). El
//    rótulo pasa a rol del crédito y la ficha queda con el nombre limpio, sin
//    enlazar a nadie.
//  * homonimo: el nombre tiene 2–3 personas en el core. El crédito pasa a la
//    única que comparte disco o artista con la obra (fusionar solo con proyecto
//    común); si ninguna o más de una, queda en revisión.
//  * grupo: el grupo pasa a artista (nuevo si no existe) con el rótulo como
//    rol; un dúo se parte en dos créditos. Se crea aunque el ER vea un parecido:
//    los cuatro nombres se miraron a mano.
//  * convertir: Acoustic Recording Service → organización y La Otra Gente →
//    artista, ambas nuevas aunque el ER vea un parecido (decisión humana).
//
//   tsx scripts/resolve-sincopa-manual-review.ts --out=reports/…json                       # ensayo
//   tsx scripts/resolve-sincopa-manual-review.ts --confirm --note="…" --out=reports/…json
//   --only=30938,31247   repite solo esas fichas
import { writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";
import { convertPerson } from "../src/review/person-corrections.js";
import { createEntity, createRelation, deleteEntity, deleteRelation, updateEntity, updateRelation, withOperatorRun, type OperatorContext } from "../src/merge/operator.js";
import type { Pool, PoolClient } from "pg";

const arg = (name: string) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const fold = (text: string) => text.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase().replace(/[^\p{L}\d]+/gu, " ").trim();

type Queryable = Pick<Pool | PoolClient, "query">;
type Role = { creditType: string; role: string };
// Los mismos rótulos que scripts/cleanup-sincopa-junk-persons.ts.
const PREFIXES: Array<{ re: RegExp; role: Role }> = [
  { re: /^(?:featuring|feat|ft)\.?\s+(.+)$/iu, role: { creditType: "guest", role: "Invitado" } },
  { re: /^(?:arreglos?|arr)\s*[.:]\s*(.+)$/iu, role: { creditType: "other", role: "Arreglos" } },
  { re: /^comp\s*[.:]\s*(.+)$/iu, role: { creditType: "composer", role: "composer" } },
  { re: /^(?:recopilaci[oó]n|compilaci[oó]n|compilation|recop|recp|rec)\s*[.:]\s*(?:de\s+)?(.+)$/iu, role: { creditType: "other", role: "Recopilación" } },
  { re: /^(?:lyrics|letra)\s*:\s*(.+)$/iu, role: { creditType: "writer", role: "Letra" } },
];

type Decision =
  | { id: number; op: "rol"; into?: number }
  | { id: number; op: "enlazar"; target: number; why: string }
  | { id: number; op: "retirar"; why: string }
  | { id: number; op: "homonimo" }
  | { id: number; op: "grupo"; name: string; also?: number[] }
  | { id: number; op: "duo"; keepAs: string; partner: string }
  | { id: number; op: "convertir"; to: "artist" | "organization"; name: string; organizationType?: string };

const DECISIONS: Decision[] = [
  // Iniciales, una palabra o sigla: rótulo a rol, sin enlazar.
  { id: 18822, op: "rol" }, { id: 19780, op: "rol" }, { id: 19787, op: "rol" }, { id: 27460, op: "rol" },
  { id: 31248, op: "rol" }, { id: 32201, op: "rol" }, { id: 32205, op: "rol" },
  { id: 32206, op: "rol", into: 32205 }, // «Recop: UDAF» y «Comp: UDAF» son la misma sigla: una sola ficha.
  { id: 36374, op: "rol" }, { id: 36375, op: "rol" }, { id: 36376, op: "rol" },
  // Homónimos: enlace por proyecto común.
  { id: 30938, op: "homonimo" },
  { id: 31426, op: "homonimo" }, { id: 31574, op: "homonimo" }, { id: 31670, op: "homonimo" }, { id: 31770, op: "homonimo" },
  { id: 32491, op: "homonimo" },
  // Los cuatro sin proyecto común (Brian, 2026-10-03; fusiones previas en el run 11594).
  { id: 28490, op: "retirar", why: "ficha vacía: su crédito es de un disco que aún no está en el core; 911 y 20644 ya fusionados" },
  { id: 31028, op: "enlazar", target: 32526, why: "el compositor Jesús Rosas Marcano (79 créditos); no hay otro que componga" },
  { id: 31379, op: "rol" }, // Juan Estévez: ninguno de los homónimos encaja, ficha propia.
  { id: 32176, op: "rol" }, // José Antonio Calcaño, no los rockeros homónimos: ficha propia.
  // Grupos: a artista. 31232 «Los Araucanos» es el mismo grupo mal tipado como persona.
  { id: 31247, op: "grupo", name: "Los Araucanos", also: [31232] },
  { id: 31335, op: "grupo", name: "Los Golperos Del Tocuyo" },
  { id: 31980, op: "grupo", name: "Experimental Barlovento" },
  { id: 31674, op: "duo", keepAs: "Guillermina", partner: "Gualberto Ibarreto" },
  // Conversiones que el ER detuvo.
  { id: 19843, op: "convertir", to: "organization", name: "Acoustic Recording Service", organizationType: "recording_studio" },
  { id: 37813, op: "convertir", to: "artist", name: "La Otra Gente" },
];

interface Link { target?: number; review?: string; candidates: Array<{ id: number; evidence: string[] }> }
type PlanItem = Decision & { name?: string; person?: string; credits?: number; skip?: string; bare?: string; role?: Role } & Partial<Link> & { partnerLink?: Link };

interface Credit { kind: "track_credit" | "album_credit"; id: number; workId: number }

async function creditsOf(queryable: Queryable, personId: number): Promise<Credit[]> {
  const { rows } = await queryable.query<{ kind: Credit["kind"]; id: string; work_id: string }>(`
    SELECT 'track_credit' AS kind, id::text, track_id::text AS work_id FROM public.track_credits WHERE person_id=$1
    UNION ALL
    SELECT 'album_credit', id::text, album_id::text FROM public.album_credits WHERE person_id=$1 ORDER BY 1, 2`, [personId]);
  return rows.map((row) => ({ kind: row.kind, id: Number(row.id), workId: Number(row.work_id) }));
}

function parseLabel(name: string): { bare: string; role: Role } {
  for (const prefix of PREFIXES) {
    const hit = prefix.re.exec(name.trim());
    if (hit) return { bare: hit[1]!.trim(), role: prefix.role };
  }
  throw new Error(`«${name}» no trae un rótulo conocido`);
}

/** Personas con ese nombre (o alias), fuera de las fichas con rótulo. */
async function homonyms(queryable: Queryable, name: string, exclude: Set<number>): Promise<number[]> {
  const { rows } = await queryable.query<{ id: string; name: string }>(
    "SELECT id::text, name FROM public.persons UNION ALL SELECT person_id::text, alias FROM ingest.person_aliases");
  const key = fold(name);
  return [...new Set(rows.filter((row) => fold(row.name) === key).map((row) => Number(row.id)))].filter((id) => !exclude.has(id)).sort((a, b) => a - b);
}

/** Qué comparte cada candidato con las obras de la ficha: disco, o artista (sin recopilatorios de varios). */
async function projectEvidence(queryable: Queryable, personId: number, candidates: number[]): Promise<Map<number, string[]>> {
  const { rows } = await queryable.query<{ id: string; evidence: string[] }>(`
    WITH works AS (
      SELECT t.album_id FROM public.track_credits tc JOIN public.tracks t ON t.id=tc.track_id WHERE tc.person_id=$1
      UNION SELECT album_id FROM public.album_credits WHERE person_id=$1),
    artists AS (
      SELECT DISTINCT a.artist_id FROM public.albums a JOIN works w ON w.album_id=a.id JOIN public.artists r ON r.id=a.artist_id
       WHERE r.name !~* '^(various|varios)'),
    candidate_albums AS (
      SELECT tc.person_id, t.album_id FROM public.track_credits tc JOIN public.tracks t ON t.id=tc.track_id WHERE tc.person_id = ANY($2::bigint[])
      UNION SELECT person_id, album_id FROM public.album_credits WHERE person_id = ANY($2::bigint[]))
    SELECT c.id::text, array_remove(ARRAY[
      CASE WHEN EXISTS (SELECT 1 FROM candidate_albums x WHERE x.person_id=c.id AND x.album_id IN (SELECT album_id FROM works)) THEN 'mismo disco' END,
      CASE WHEN EXISTS (SELECT 1 FROM public.artist_members m WHERE m.person_id=c.id AND m.artist_id IN (SELECT artist_id FROM artists)) THEN 'miembro del artista' END,
      CASE WHEN EXISTS (SELECT 1 FROM candidate_albums x JOIN public.albums a ON a.id=x.album_id
                         WHERE x.person_id=c.id AND a.artist_id IN (SELECT artist_id FROM artists)) THEN 'mismo artista' END
    ], NULL) AS evidence
    FROM unnest($2::bigint[]) AS c(id)`, [personId, candidates]);
  return new Map(rows.map((row) => [Number(row.id), row.evidence]));
}

async function linkByProject(queryable: Queryable, personId: number, name: string, exclude: Set<number>): Promise<Link> {
  const candidates = await homonyms(queryable, name, exclude);
  const evidence = await projectEvidence(queryable, personId, candidates);
  const sharing = candidates.filter((id) => (evidence.get(id) ?? []).length > 0);
  const detail = candidates.map((id) => ({ id, evidence: evidence.get(id) ?? [] }));
  if (sharing.length === 1) return { target: sharing[0]!, candidates: detail };
  return { review: sharing.length === 0 ? "ningún homónimo comparte disco ni artista" : `${sharing.length} homónimos comparten proyecto`, candidates: detail };
}

async function findOrCreate(context: OperatorContext, kind: "artist" | "organization", name: string, organizationType?: string, allowSimilar = false) {
  const table = kind === "artist" ? "artists" : "organizations";
  const found = (await context.client.query<{ id: string; name: string }>(`SELECT id::text, name FROM public.${table}`)).rows
    .filter((row) => fold(row.name) === fold(name));
  if (found.length > 1) throw new Error(`hay ${found.length} ${table} llamados «${name}»`);
  if (found.length === 1) return { id: Number(found[0]!.id), created: false };
  const values = kind === "artist" ? { name, artist_type: "group" } : { name, organization_type: organizationType ?? "other" };
  return { id: (await createEntity(context, kind, values, { allowSimilar })).id, created: true };
}

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const note = arg("note") ?? "Sincopa: revisión manual de rótulos y conversiones (decisiones de Brian 2026-10-03)";
  const labelled = new Set(DECISIONS.map((decision) => decision.id));
  const only = arg("only")?.split(",").map(Number);
  const pool = getPool();
  const names = new Map((await pool.query<{ id: string; name: string }>(
    "SELECT id::text, name FROM public.persons WHERE id = ANY($1::bigint[])", [[...labelled]])).rows.map((row) => [Number(row.id), row.name]));

  // Ensayo: lo que se haría con el core de ahora.
  const plan: PlanItem[] = [];
  for (const decision of DECISIONS.filter((item) => only === undefined || only.includes(item.id))) {
    const name = names.get(decision.id);
    if (name === undefined) { plan.push({ ...decision, skip: "la ficha ya no existe" }); continue; }
    const credits = (await creditsOf(pool, decision.id)).length;
    if (decision.op === "rol") plan.push({ ...decision, name, credits, ...parseLabel(name) });
    else if (decision.op === "enlazar") plan.push({ ...decision, name, credits, ...parseLabel(name) });
    else if (decision.op === "retirar") plan.push({ ...decision, name, credits, ...(credits > 0 ? { skip: "la ficha tiene créditos" } : {}) });
    else if (decision.op === "homonimo") {
      const { bare, role } = parseLabel(name);
      plan.push({ ...decision, name, credits, bare, role, ...(await linkByProject(pool, decision.id, bare, labelled)) });
    } else if (decision.op === "duo") {
      const { role } = parseLabel(name);
      plan.push({ ...decision, name, credits, role, partnerLink: await linkByProject(pool, decision.id, decision.partner, labelled) });
    } else if (decision.op === "grupo") plan.push({ ...decision, name: decision.name, person: name, credits, role: parseLabel(name).role });
    else plan.push({ ...decision, person: name, credits });
  }

  const outcome = { applied: 0, review: 0, failed: 0, creditsMoved: 0, creditsDropped: 0, created: [] as string[], errors: [] as Array<{ id: number; error: string }> };
  let runId: number | undefined;
  if (confirm) {
    const result = await withOperatorRun({ name: "resolve-sincopa-manual-review", operator: "brian", note, params: { decisions: DECISIONS.length } }, async (context) => {
      const reason = (why: string) => `[run ${context.runId}] ${note}: ${why}`;
      const setRole = async (credits: Credit[], role: Role, endpoint: Record<string, number> = {}) => {
        for (const credit of credits) {
          // Si el destino ya tiene ese mismo crédito en la obra, el de la ficha con rótulo sobra.
          if (endpoint["person_id"] !== undefined) {
            const work = credit.kind === "track_credit" ? "track_id" : "album_id";
            const twin = await context.client.query(
              `SELECT 1 FROM public.${credit.kind}s WHERE person_id=$1 AND ${work}=$2 AND credit_type::text=$3 AND lower(role)=lower($4)`,
              [endpoint["person_id"], credit.workId, role.creditType, role.role]);
            if (twin.rowCount) {
              await deleteRelation(context, credit.kind, credit.id);
              outcome.creditsDropped += 1;
              continue;
            }
          }
          await updateRelation(context, credit.kind, credit.id, { credit_type: role.creditType, role: role.role, ...endpoint });
          outcome.creditsMoved += 1;
        }
      };
      for (const item of plan) {
        if (item.skip || item.review || item.partnerLink?.review) { outcome.review += 1; continue; }
        await context.client.query("SAVEPOINT manual_review");
        try {
          const credits = await creditsOf(context.client, item.id);
          if (item.op === "retirar") {
            await deleteEntity(context, "person", item.id);
          } else if (item.op === "enlazar") {
            await setRole(credits, item.role!, { person_id: item.target });
            await deleteEntity(context, "person", item.id);
          } else if (item.op === "rol") {
            const { bare, role } = parseLabel(item.name!);
            if (item.into !== undefined) {
              await setRole(credits, role, { person_id: item.into });
              await deleteEntity(context, "person", item.id);
            } else {
              await setRole(credits, role);
              await updateEntity(context, "person", item.id, { name: bare });
            }
          } else if (item.op === "homonimo") {
            await setRole(credits, item.role!, { person_id: item.target! });
            await deleteEntity(context, "person", item.id);
          } else if (item.op === "duo") {
            const partner = item.partnerLink!.target!;
            for (const credit of credits) {
              await createRelation(context, credit.kind, credit.kind === "track_credit" ? { trackId: credit.workId, personId: partner } : { albumId: credit.workId, personId: partner },
                { credit_type: item.role!.creditType, credit_role: item.role!.role });
            }
            await setRole(credits, item.role!);
            await updateEntity(context, "person", item.id, { name: item.keepAs });
          } else if (item.op === "grupo") {
            // «Los Araucanos» no es «Los Anauco» (3980), el parecido que ve el ER.
            const artist = await findOrCreate(context, "artist", item.name!, undefined, true);
            if (artist.created) outcome.created.push(`artista ${artist.id} «${item.name}»`);
            await setRole(credits, item.role!);
            await convertPerson(context.client, item.id, { kind: "artist", id: artist.id }, false, reason(`grupo «${item.name}»`), context.runId);
            for (const twin of item.also ?? []) {
              if (names.has(twin) || (await context.client.query("SELECT 1 FROM public.persons WHERE id=$1", [twin])).rowCount) {
                await convertPerson(context.client, twin, { kind: "artist", id: artist.id }, false, reason(`grupo «${item.name}» tipado como persona`), context.runId);
              }
            }
          } else if (item.op === "convertir") {
            const target = await findOrCreate(context, item.to, item.name, item.organizationType, true);
            if (target.created) outcome.created.push(`${item.to === "artist" ? "artista" : "organización"} ${target.id} «${item.name}»`);
            await convertPerson(context.client, item.id, { kind: item.to, id: target.id }, false, reason(`no es persona: ${item.name}`), context.runId);
          }
          await context.client.query("RELEASE SAVEPOINT manual_review");
          outcome.applied += 1;
        } catch (error) {
          await context.client.query("ROLLBACK TO SAVEPOINT manual_review");
          outcome.failed += 1;
          outcome.errors.push({ id: item.id, error: (error as Error).message });
        }
      }
      return outcome;
    });
    runId = result.runId;
  }
  const report = { dryRun: !confirm, runId, decisions: plan.length, ...(confirm ? outcome : {}) };
  const out = arg("out");
  if (out !== undefined) writeFileSync(out, `${JSON.stringify({ ...report, plan }, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, plan: confirm ? undefined : plan }, null, 2));
}

main().then(() => closeDb()).then(() => process.exit(0), async (error) => {
  console.error(error);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
