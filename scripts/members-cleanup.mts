// CRV · Limpieza de personas tras `apply-members.mts` (extracción de integrantes, 2026-10-01).
//
//   dedupe     Personas duplicadas DENTRO de una misma banda tocada por los runs dados: mismo nombre, errata
//              («Vincenzo»/«Vicenzo»; «Claudia»/«Claudio» NO cuenta) o nombre corto/largo («Ezequiel Serrano» ⊂
//              «Ezequiel Serrano Valencia»). Comparten proyecto, así que se fusionan: queda la ficha de id menor y el
//              otro nombre pasa a alias.
//   homonyms   Personas nuevas que el aplicador reportó como «possibleDuplicates» (mismo nombre que una ficha previa
//              sin proyecto común probado). Si comparten colegas (otra persona en el mismo artista o disco) con UN
//              solo homónimo, se fusionan; si no, el par va a la cola `person_duplicate` (regla de Brian: la firma
//              parecida sola no basta).
//
// Sin --confirm solo escribe el dry-run en reports/.
// Uso: tsx scripts/members-cleanup.mts --phase=dedupe --runs=<id,id,…> [--confirm]
//      tsx scripts/members-cleanup.mts --phase=homonyms --reports=<apply-members-…-runsA-B.json,…> [--confirm]
import { readFileSync, writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";
import { withOperatorRun } from "../src/merge/operator.js";
import { mergeEntities, previewEntityMerge } from "../src/merge/entity-merge.js";
import { nameWithoutNickname } from "../src/review/person-names.js";

const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const PHASE = arg("phase");
const CONFIRM = process.argv.includes("--confirm");
const OPERATOR = "claude-code (delegado por Brian)";

const fold = (text: string) => nameWithoutNickname(text.replace(/[«»"“”'‘’]/gu, " "));
const tokens = (text: string) => fold(text).split(/\s+/u).filter((token) => token.length > 1);

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = saved;
    }
  }
  return row[b.length]!;
}

/** Por qué dos nombres de la MISMA banda son la misma persona, o null. */
function sameMember(left: string, right: string): string | null {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.length || !b.length) return null;
  if (a.join(" ") === b.join(" ")) return "mismo nombre";
  const gender = (x: string, y: string) => x.slice(0, -1) === y.slice(0, -1) && /[ao]/u.test(x.at(-1)!) && /[ao]/u.test(y.at(-1)!);
  if (a.length === b.length && a.length >= 2
    && a.every((token, index) => token === b[index] || (token.length > 3 && editDistance(token, b[index]!) <= 1 && !gender(token, b[index]!)))) return "errata";
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 2 && short.every((token) => long.includes(token)) && (short[0] === long[0] || short.at(-1) === long.at(-1))) return "nombre corto/largo";
  return null;
}

interface MergePair { keep: number; drop: number; keepName: string; dropName: string; artist: string; why: string }

async function mergePairs(name: string, note: string, pairs: MergePair[]) {
  const out = { runId: 0, merged: [] as MergePair[], failed: [] as Array<MergePair & { error: string }> };
  out.runId = (await withOperatorRun({ name, operator: OPERATOR, note }, async (context) => {
    for (const pair of pairs) {
      await context.client.query("SAVEPOINT pair");
      try {
        const preview = await previewEntityMerge(context.client, "person", pair.keep, pair.drop);
        await mergeEntities(context, { kind: "person", keepId: pair.keep, dropId: pair.drop, previewHash: preview.previewHash,
          keepDropNameAsAlias: fold(pair.keepName) !== fold(pair.dropName) });
        await context.client.query("RELEASE SAVEPOINT pair");
        out.merged.push(pair);
      } catch (error) {
        await context.client.query("ROLLBACK TO SAVEPOINT pair");
        out.failed.push({ ...pair, error: (error as Error).message.slice(0, 200) });
      }
    }
  })).runId;
  return out;
}

async function dedupe(): Promise<void> {
  const runs = (arg("runs") ?? "").split(",").map(Number).filter(Boolean);
  if (!runs.length) throw new Error("--runs=<id,id,…>");
  const { rows } = await getPool().query<{ artist_id: string; artist: string; person_id: string; name: string }>(`
    SELECT m.artist_id::text, a.name artist, m.person_id::text, p.name FROM public.artist_members m
      JOIN public.artists a ON a.id=m.artist_id JOIN public.persons p ON p.id=m.person_id
     WHERE m.artist_id IN (SELECT DISTINCT (new_data->>'artist_id')::bigint FROM ingest.change_journal
                            WHERE run_id = ANY($1) AND table_name='public.artist_members' AND op='I')
     ORDER BY m.artist_id, m.person_id`, [runs]);
  const byArtist = new Map<string, typeof rows>();
  for (const row of rows) byArtist.set(row.artist_id, [...(byArtist.get(row.artist_id) ?? []), row]);
  const pairs: MergePair[] = [];
  const dropped = new Set<number>();
  for (const members of byArtist.values()) {
    for (let i = 0; i < members.length; i += 1) for (let j = i + 1; j < members.length; j += 1) {
      const [a, b] = [members[i]!, members[j]!];
      if (a.person_id === b.person_id || dropped.has(Number(a.person_id)) || dropped.has(Number(b.person_id))) continue;
      const why = sameMember(a.name, b.name);
      if (!why) continue;
      pairs.push({ artist: a.artist, keep: Number(a.person_id), drop: Number(b.person_id), keepName: a.name, dropName: b.name, why });
      dropped.add(Number(b.person_id));
    }
  }
  console.log(`dedupe: ${byArtist.size} artistas, ${pairs.length} pares`);
  if (!CONFIRM) { writeFileSync("reports/members-cleanup-dedupe-dry-run.json", JSON.stringify(pairs, null, 2)); return; }
  const out = await mergePairs("miembros:duplicados-en-banda",
    "Personas duplicadas dentro de una misma banda tras la extracción de integrantes (comparten proyecto).", pairs);
  writeFileSync(`reports/members-cleanup-dedupe-run${out.runId}.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ runId: out.runId, merged: out.merged.length, failed: out.failed }, null, 2));
}

const COLLEAGUES = `
  WITH links AS (
    SELECT person_id, 'a'||artist_id AS ctx FROM public.artist_members
    UNION SELECT person_id, 'd'||album_id FROM public.album_credits
    UNION SELECT tc.person_id, 'd'||t.album_id FROM public.track_credits tc JOIN public.tracks t ON t.id=tc.track_id)
  SELECT array_agg(DISTINCT pb.name) AS shared
    FROM links a1 JOIN links a2 ON a2.ctx=a1.ctx AND a2.person_id<>a1.person_id
    JOIN links b2 ON b2.person_id=a2.person_id JOIN links b1 ON b1.ctx=b2.ctx AND b1.person_id<>b2.person_id
    JOIN public.persons pb ON pb.id=a2.person_id
   WHERE a1.person_id=$1 AND b1.person_id=$2 AND a2.person_id NOT IN ($1,$2)`;

async function homonyms(): Promise<void> {
  const files = (arg("reports") ?? "").split(",").filter(Boolean);
  if (!files.length) throw new Error("--reports=<apply-members-…-runsA-B.json,…>");
  const duplicates = files.flatMap((file) => (JSON.parse(readFileSync(file, "utf8")) as {
    possibleDuplicates: Array<{ artist: string; name: string; newPersonId: number; homonyms: number[] }>;
  }).possibleDuplicates);
  const pool = getPool();
  const alive = async (id: number) => Boolean((await pool.query("SELECT 1 FROM public.persons WHERE id=$1", [id])).rowCount);
  const merges: MergePair[] = [];
  const queue: Array<{ a: number; b: number; name: string; artist: string }> = [];
  for (const dup of duplicates) {
    if (!(await alive(dup.newPersonId))) continue;
    const withColleagues: Array<{ id: number; shared: string[] }> = [];
    for (const homonym of dup.homonyms) {
      if (homonym === dup.newPersonId || !(await alive(homonym))) continue;
      const shared = (await pool.query<{ shared: string[] | null }>(COLLEAGUES, [dup.newPersonId, homonym])).rows[0]?.shared ?? null;
      if (shared?.length) withColleagues.push({ id: homonym, shared });
      else queue.push({ a: dup.newPersonId, b: homonym, name: dup.name, artist: dup.artist });
    }
    // Un solo homónimo con colegas: es él. Varios: no se elige, todos a la cola.
    if (withColleagues.length === 1) {
      merges.push({ keep: withColleagues[0]!.id, drop: dup.newPersonId, keepName: dup.name, dropName: dup.name, artist: dup.artist,
        why: `colegas: ${withColleagues[0]!.shared.slice(0, 5).join(", ")}` });
    } else for (const item of withColleagues) queue.push({ a: dup.newPersonId, b: item.id, name: dup.name, artist: dup.artist });
  }
  console.log(`homonyms: ${merges.length} fusiones, ${queue.length} a la cola`);
  if (!CONFIRM) { writeFileSync("reports/members-cleanup-homonyms-dry-run.json", JSON.stringify({ merges, queue }, null, 2)); return; }
  const merged = await mergePairs("miembros:homonimos-fusion",
    "Personas creadas por la extracción de integrantes que comparten colegas con un homónimo previo (regla de proyecto común).", merges);
  for (const failed of merged.failed) queue.push({ a: failed.drop, b: failed.keep, name: failed.dropName, artist: failed.artist });
  let opened = 0;
  const queueRun = (await withOperatorRun({
    name: "miembros:homonimos-cola", operator: OPERATOR,
    note: "Homónimos sin proyecto común creados por la extracción de integrantes: a revisión (firma parecida sola no basta).",
  }, async (context) => {
    for (const pair of queue) {
      const inserted = await context.client.query(`
        INSERT INTO ingest.review_queue(kind,person_a_id,person_b_id,priority,status,payload,notes)
        SELECT 'person_duplicate',LEAST($1::bigint,$2::bigint),GREATEST($1::bigint,$2::bigint),6,'open',$3::jsonb,$4
         WHERE $1::bigint <> $2::bigint AND (SELECT count(*) FROM public.persons WHERE id IN ($1,$2)) = 2
        ON CONFLICT DO NOTHING`, [pair.a, pair.b,
        JSON.stringify({ detector: "member-extraction-homonym", version: 1, runId: context.runId, artist: pair.artist }),
        `Mismo nombre «${pair.name}»: la nueva es integrante de ${pair.artist} (extracción de integrantes); sin colegas en común`]);
      opened += inserted.rowCount ?? 0;
    }
  })).runId;
  const out = { mergeRun: merged.runId, queueRun, merged: merged.merged, failed: merged.failed, opened };
  writeFileSync(`reports/members-cleanup-homonyms-runs${merged.runId}-${queueRun}.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ...out, merged: out.merged.length, failed: out.failed.length }, null, 2));
}

async function main(): Promise<void> {
  if (PHASE === "dedupe") await dedupe();
  else if (PHASE === "homonyms") await homonyms();
  else throw new Error("--phase=dedupe|homonyms");
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => closeDb());
