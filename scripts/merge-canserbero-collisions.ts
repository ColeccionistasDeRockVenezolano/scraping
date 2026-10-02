// CRV · Caso Canserbero extendido: cuando el nombre limpio o real de una ficha
// ya es el de otra («Pipi» → «Christian Estepa», y existe «Christian Estepa»).
//
// Regla de Brian (2026-09-28): dos personas se funden solas SOLO si comparten
// proyecto —misma banda, mismo disco que no sea recopilatorio, misma pista o
// mismo artista— o tienen al menos dos colegas en común. La ficha que queda es
// la ligada al artista (titular o integrante); la otra deja su nombre de alias
// y no se pierde nada (`mergeEntities`, el mismo servicio que la fusión de la
// web). Al final, la ficha se llama por el nombre real. Sin proyecto común, el
// par queda en la mesa como `person_duplicate` (lo abre el planificador con
// --open-reviews).
//
// Lee los informes de `plan-canserbero-extendido.ts` (los saltados por
// «el nombre nuevo ya es de otra ficha»). Previsualiza por defecto.
//   tsx scripts/merge-canserbero-collisions.ts --reports=<a.jsonl,b.jsonl> [--confirm]
import { readFileSync, writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";
import { withOperatorRun } from "../src/merge/operator.js";
import { mergeEntities, previewEntityMerge } from "../src/merge/entity-merge.js";
import { normalizeEntityName } from "../src/normalization/entity-name.js";

const TODAY = new Date().toISOString().slice(0, 10);
const OPERATOR = "claude-code (delegado por Brian)";
const CONFIRM = process.argv.includes("--confirm");
const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);

interface Collision { id: number; name: string; target: string; collidesWith: { id: number; name: string } }

/** Contextos de proyecto: banda/proyecto, disco (no recopilatorio) y pista. */
const SHARED = `
  WITH ctx AS (
    SELECT person_id, 'artist:'||artist_id AS c FROM public.artist_members
    UNION SELECT ac.person_id, 'album:'||ac.album_id FROM public.album_credits ac
      JOIN public.albums al ON al.id=ac.album_id
      JOIN public.artists ar ON ar.id=al.artist_id
     WHERE ac.person_id IS NOT NULL AND lower(ar.name) NOT IN ('various artists','varios artistas','v.a.','va')
    UNION SELECT tc.person_id, 'album:'||t.album_id FROM public.track_credits tc
      JOIN public.tracks t ON t.id=tc.track_id JOIN public.albums al ON al.id=t.album_id
      JOIN public.artists ar ON ar.id=al.artist_id
     WHERE tc.person_id IS NOT NULL AND lower(ar.name) NOT IN ('various artists','varios artistas','v.a.','va')
    UNION SELECT tc.person_id, 'artist:'||al.artist_id FROM public.track_credits tc
      JOIN public.tracks t ON t.id=tc.track_id JOIN public.albums al ON al.id=t.album_id
     WHERE tc.person_id IS NOT NULL)
  SELECT
    (SELECT array_agg(DISTINCT a.c) FROM ctx a JOIN ctx b ON b.c=a.c WHERE a.person_id=$1 AND b.person_id=$2) AS shared,
    (SELECT count(DISTINCT x.person_id) FROM ctx a JOIN ctx x ON x.c=a.c AND x.person_id NOT IN ($1,$2)
       WHERE a.person_id=$1 AND x.person_id IN (
         SELECT y.person_id FROM ctx b JOIN ctx y ON y.c=b.c WHERE b.person_id=$2)) AS colleagues`;

async function main(): Promise<void> {
  const files = (arg("reports") ?? "").split(",").filter(Boolean);
  if (!files.length) throw new Error("--reports=<informe.jsonl,…>");
  const collisions = files.flatMap((file) => readFileSync(file, "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Partial<Collision>))
    .filter((row): row is Collision => row.collidesWith !== undefined && typeof row.target === "string");
  const pool = getPool();
  const nameOf = async (id: number) => (await pool.query<{ name: string }>("SELECT name FROM public.persons WHERE id=$1", [id])).rows[0]?.name ?? null;
  const linked = async (id: number) => Number((await pool.query<{ n: string }>(
    "SELECT (count(*) FILTER (WHERE role='Titular del proyecto') * 10 + count(*))::text AS n FROM public.artist_members WHERE person_id=$1", [id])).rows[0]?.n ?? 0);

  const merges: Array<{ keep: number; drop: number; keepName: string; dropName: string; finalName: string; why: string }> = [];
  const queued: Array<Collision & { why: string }> = [];
  const used = new Set<number>();
  for (const row of collisions) {
    const [mine, theirs] = [await nameOf(row.id), await nameOf(row.collidesWith.id)];
    if (mine === null || theirs === null || used.has(row.id) || used.has(row.collidesWith.id)) continue;
    const { shared, colleagues } = (await pool.query<{ shared: string[] | null; colleagues: string }>(SHARED, [row.id, row.collidesWith.id])).rows[0]!;
    if (!shared?.length && Number(colleagues) < 2) { queued.push({ ...row, why: "sin proyecto común: a la mesa" }); continue; }
    // Queda la ficha ligada al artista; a igualdad, la que ya lleva el nombre real.
    const keepMine = (await linked(row.id)) > (await linked(row.collidesWith.id));
    const [keep, drop] = keepMine ? [row.id, row.collidesWith.id] : [row.collidesWith.id, row.id];
    merges.push({ keep, drop, keepName: keepMine ? mine : theirs, dropName: keepMine ? theirs : mine, finalName: row.target,
      why: shared?.length ? `proyecto común: ${shared.slice(0, 4).join(", ")}` : `${colleagues} colegas en común` });
    used.add(row.id).add(row.collidesWith.id);
  }

  const out: Record<string, unknown> = { merges, queued, confirm: CONFIRM };
  if (CONFIRM && merges.length) {
    const failed: Array<{ keep: number; drop: number; error: string }> = [];
    out["runId"] = (await withOperatorRun({
      name: "personas:canserbero-choques", operator: OPERATOR,
      note: "Caso Canserbero extendido (Brian, 2026-10-02): el nombre real o limpio de una ficha ya era el de otra con proyecto común; se funden y queda el nombre real.",
    }, async (context) => {
      for (const pair of merges) {
        await context.client.query("SAVEPOINT pair");
        try {
          const preview = await previewEntityMerge(context.client, "person", pair.keep, pair.drop);
          await mergeEntities(context, { kind: "person", keepId: pair.keep, dropId: pair.drop, previewHash: preview.previewHash, keepDropNameAsAlias: true });
          const current = (await context.client.query<{ name: string }>("SELECT name FROM public.persons WHERE id=$1", [pair.keep])).rows[0]!.name;
          if (normalizeEntityName(current).primaryKey !== normalizeEntityName(pair.finalName).primaryKey) {
            await context.client.query("UPDATE public.persons SET name=$2, updated_at=now() WHERE id=$1", [pair.keep, pair.finalName]);
            await context.client.query(`
              INSERT INTO ingest.person_aliases(person_id,alias,alias_type,normalized_alias,is_primary,confidence,notes)
              VALUES($1,$2,'name_variant',$3,false,'high','Nombre anterior a una corrección del propietario') ON CONFLICT DO NOTHING`,
            [pair.keep, current, normalizeEntityName(current).primaryKey]);
            const audit = await context.client.query<{ id: string }>(`
              INSERT INTO ingest.merge_audit(run_id,entity_kind,person_id,field,old_value,new_value,reason,confidence,performed_by)
              VALUES($1,'person',$2,'name',$3::jsonb,$4::jsonb,$5,'high','human') RETURNING id::text`,
            [context.runId, pair.keep, JSON.stringify(current), JSON.stringify(pair.finalName), `Caso Canserbero extendido: queda el nombre de la persona (${pair.why})`]);
            await context.client.query(`
              INSERT INTO ingest.merge_audit_claims(merge_audit_id,claim_id)
              SELECT $1::bigint, id FROM ingest.claims WHERE person_id=$2
              UNION SELECT $1::bigint, mac.claim_id FROM ingest.merge_audit ma
                JOIN ingest.merge_audit_claims mac ON mac.merge_audit_id=ma.id WHERE ma.person_id=$2
              ON CONFLICT DO NOTHING`, [Number(audit.rows[0]!.id), pair.keep]);
          }
          await context.client.query("RELEASE SAVEPOINT pair");
        } catch (error) {
          await context.client.query("ROLLBACK TO SAVEPOINT pair");
          failed.push({ keep: pair.keep, drop: pair.drop, error: (error as Error).message.slice(0, 200) });
        }
      }
    })).runId;
    out["failed"] = failed;
  }
  if (CONFIRM && queued.length) {
    out["reviewRunId"] = (await withOperatorRun({
      name: "personas:canserbero-choques-cola", operator: OPERATOR,
      note: "Caso Canserbero extendido: el nombre real o limpio ya es de otra ficha y no comparten proyecto (la firma parecida sola no basta).",
    }, async (context) => {
      let opened = 0;
      for (const row of queued) {
        const inserted = await context.client.query(`
          INSERT INTO ingest.review_queue(kind,person_a_id,person_b_id,priority,status,payload,notes)
          SELECT 'person_duplicate',LEAST($1::bigint,$2::bigint),GREATEST($1::bigint,$2::bigint),6,'open',$3::jsonb,$4
           WHERE (SELECT count(*) FROM public.persons WHERE id IN ($1,$2)) = 2
             AND NOT EXISTS (SELECT 1 FROM ingest.review_queue q WHERE q.kind='person_duplicate' AND q.status IN ('open','in_progress')
                              AND q.person_a_id=LEAST($1::bigint,$2::bigint) AND q.person_b_id=GREATEST($1::bigint,$2::bigint))`,
        [row.id, row.collidesWith.id, JSON.stringify({ detector: "canserbero-extendido", version: 1, runId: context.runId, target: row.target }),
          `«${row.name}» se llamaría «${row.target}», que ya es el nombre de ${row.collidesWith.id}; sin proyecto común`]);
        opened += inserted.rowCount ?? 0;
      }
      out["reviewsOpened"] = opened;
    })).runId;
  }
  const path = `reports/canserbero-choques-${TODAY}${CONFIRM ? "-confirm" : "-dry-run"}.json`;
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify({ report: path, merges: merges.length, queued: queued.length, runId: out["runId"] ?? null,
    failed: (out["failed"] as unknown[] | undefined)?.length ?? 0 }, null, 2));
}

main().then(() => closeDb()).catch(async (error) => { console.error(error); await closeDb(); process.exit(1); });
