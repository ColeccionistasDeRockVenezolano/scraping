// CRV · Separar fichas que juntaban a varias personas (Brian, 2026-10-02:
// «separa las fichas 360 y 6387»).
//
// El importador de Metal Archives emparejó perfiles solo por el nombre de pila:
// cinco perfiles distintos («Daniel» 240301, 124378, 343091; «Fernando» 303901,
// 573020) cayeron sobre la ficha de Sincopa del mismo nombre, que es otra
// persona: 360 es el baterista de Skatz (All Stars, mezcla de «6101» de Ohmio) y
// 6387 el diseñador gráfico de «Déjala! ...Está Triste» de Retrovértigo. La
// extracción de integrantes (run 10993) colgó además a 360 el «Daniel» de Los
// Riff, de Porlamar.
//
// `split` de `crv review persons` copia la trayectoria completa a cada parte;
// aquí cada integración tiene dueño conocido, así que se MUEVE: cada perfil de
// Metal Archives nace como ficha propia con su integración, sus claims de nombre
// real y sus alias; la ficha original conserva lo suyo y pierde el nombre real
// y el alias que no eran suyos. Los pares que solo comparten nombre van a la
// mesa como `person_duplicate` (regla de Brian del 2026-09-28).
//
// Previsualiza por defecto; --confirm escribe en una sola run.
import { writeFileSync } from "node:fs";
import type { PoolClient } from "pg";
import { closeDb, getPool } from "../src/db/client.js";
import { withOperatorRun } from "../src/merge/operator.js";
import { normalizeEntityName } from "../src/normalization/entity-name.js";
import { rejectReview } from "../src/review/operator-review.js";

const OPERATOR = "claude-code (pedido por Brian)";
const CONFIRM = process.argv.includes("--confirm");
const MA = "https://www.metal-archives.com/artists";

type Part = {
  name: string;
  realName?: string;
  aliases: string[];
  memberships: number[];
  claims: number[];
  note: string;
  reviewWith?: { id: number; why: string };
};

const SPLITS: Array<{ from: number; dropAliases: number[]; why: string; parts: Part[]; dismiss: Array<{ review: number; why: string }> }> = [
  {
    from: 360,
    dropAliases: [22336],
    why: "la ficha de Sincopa (baterista de Skatz) recibió por nombre de pila tres perfiles de Metal Archives y el Daniel de Los Riff",
    parts: [
      { name: "Daniel Díaz", realName: "Daniel Díaz", aliases: ["Daniel"], memberships: [1672], claims: [664083, 664086],
        note: `Metal Archives: ${MA}/Daniel/240301 (Secta Canibal, voz y guitarra 2002–2009).` },
      { name: "Daniel", aliases: ["Lord Cruz"], memberships: [1764], claims: [],
        note: `Metal Archives: ${MA}/Daniel/124378 («As Lord Cruz», guitarra de Demonical Rites).` },
      { name: "Daniel", aliases: [], memberships: [4031], claims: [],
        note: `Metal Archives: ${MA}/Daniel/343091 (guitarra de Aria).` },
      { name: "Daniel", aliases: [], memberships: [5844], claims: [],
        note: "Baterista y corista de Los Riff (Porlamar); https://rockdevzla.blogspot.com/2011/02/los-riff-banda-de-margarita-estado.html",
        reviewWith: { id: 360, why: "los dos son «Daniel», baterista; Los Riff es de Porlamar y Skatz de Caracas, sin proyecto común" } },
    ],
    dismiss: [{ review: 1171514, why: "el par salió del nombre real «Daniel Díaz» de Metal Archives, que era de otro perfil (Secta Canibal); 360 es el baterista de Skatz" }],
  },
  {
    from: 6387,
    dropAliases: [22380],
    why: "la ficha de Sincopa (diseño gráfico de Retrovértigo) recibió por nombre de pila dos perfiles de Metal Archives con nombres reales distintos",
    parts: [
      { name: "Fernando Guillén", realName: "Fernando Guillén", aliases: ["Fernando", "Fernando Guillen"], memberships: [2191], claims: [666597],
        note: `Metal Archives: ${MA}/Fernando/303901 (batería de Ritual; la biografía de Ritual lo nombra «Fernando Guillén»).` },
      { name: "Fernando Villa", realName: "Fernando Villa", aliases: ["Fernando"], memberships: [2733], claims: [666593, 666601],
        note: `Metal Archives: ${MA}/Fernando/573020 (voz de Optofobia).`,
        reviewWith: { id: 17033, why: "mismo nombre que «Fernando villa» de Disentir (Mérida); sin proyecto común" } },
    ],
    dismiss: [{ review: 1171515, why: "el par salió del nombre real «Fernando Villa» de Metal Archives, que era de otro perfil (Optofobia); 6387 es el diseñador gráfico de Retrovértigo. El par se reabre con la ficha nueva" }],
  },
];

async function audit(client: PoolClient, runId: number, target: { person?: number; membership?: number }, field: string,
  oldValue: unknown, newValue: unknown, reason: string, claims: number[]): Promise<void> {
  const row = await client.query<{ id: string }>(`
    INSERT INTO ingest.merge_audit(run_id,entity_kind,person_id,artist_membership_id,field,old_value,new_value,reason,confidence,performed_by)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,'high','human') RETURNING id::text`,
  [runId, target.membership === undefined ? "person" : "artist_membership", target.person ?? null, target.membership ?? null,
    field, JSON.stringify(oldValue), JSON.stringify(newValue), `Separación de fichas mezcladas: ${reason}`]);
  await client.query(`
    INSERT INTO ingest.merge_audit_claims(merge_audit_id,claim_id)
    SELECT $1::bigint, unnest($2::bigint[]) ON CONFLICT DO NOTHING`, [Number(row.rows[0]!.id), claims]);
}

async function addAlias(client: PoolClient, personId: number, alias: string, note: string): Promise<void> {
  await client.query(`
    INSERT INTO ingest.person_aliases(person_id,alias,alias_type,normalized_alias,is_primary,confidence,notes)
    SELECT $1::bigint,$2::text,'name_variant',$3::text,false,'high',$4::text
     WHERE NOT EXISTS (SELECT 1 FROM ingest.person_aliases WHERE person_id=$1::bigint AND normalized_alias=$3::text)`,
  [personId, alias, normalizeEntityName(alias).primaryKey, note]);
}

async function main(): Promise<void> {
  const pool = getPool();
  const before = await pool.query(`
    SELECT m.id, m.person_id, a.name AS artist, m.role FROM public.artist_members m JOIN public.artists a ON a.id=m.artist_id
     WHERE m.id = ANY($1::bigint[]) ORDER BY m.id`, [SPLITS.flatMap((split) => split.parts.flatMap((part) => part.memberships))]);
  const out: Record<string, unknown> = { splits: SPLITS, membershipsBefore: before.rows, confirm: CONFIRM };
  for (const split of SPLITS) {
    for (const part of split.parts) {
      for (const id of part.memberships) {
        const row = before.rows.find((candidate) => Number(candidate.id) === id);
        if (row === undefined || Number(row.person_id) !== split.from) throw new Error(`la integración ${id} ya no es de ${split.from}`);
      }
    }
  }
  if (!CONFIRM) { console.log(JSON.stringify(out, null, 2)); await closeDb(); return; }

  const created: Array<{ from: number; id: number; name: string; memberships: number[] }> = [];
  const reviews: number[] = [];
  out["runId"] = (await withOperatorRun({
    name: "personas:separar-fichas-mezcladas", operator: OPERATOR,
    note: "Separar 360 «Daniel» y 6387 «Fernando»: perfiles de Metal Archives emparejados solo por nombre de pila (Brian, 2026-10-02).",
  }, async (context) => {
    const { client, runId } = context;
    for (const split of SPLITS) {
      const source = (await client.query<{ name: string; real_name: string | null; nationality: string | null; gender: string | null; is_venezuelan: boolean | null }>(
        "SELECT name, real_name, nationality, gender, is_venezuelan FROM public.persons WHERE id=$1 FOR UPDATE", [split.from])).rows[0]!;
      for (const part of split.parts) {
        const memberClaims = (await client.query<{ id: string }>(
          "SELECT id::text FROM ingest.claims WHERE artist_membership_id = ANY($1::bigint[])", [part.memberships])).rows.map((row) => Number(row.id));
        const linked = [...memberClaims, ...part.claims];
        // Metal Archives da nacionalidad venezolana y sexo masculino a los cinco perfiles.
        const id = Number((await client.query<{ id: string }>(`
          INSERT INTO public.persons(name, real_name, nationality, gender, is_venezuelan, notes)
          VALUES($1,$2,'Venezuela','male',true,$3) RETURNING id::text`, [part.name, part.realName ?? null, part.note])).rows[0]!.id);
        await audit(client, runId, { person: id }, "split_from", null, { from: split.from, fromName: source.name, name: part.name },
          split.why, linked);
        for (const alias of part.aliases) await addAlias(client, id, alias, `Separada de la ficha ${split.from} («${source.name}»)`);
        for (const membership of part.memberships) {
          await client.query("UPDATE public.artist_members SET person_id=$2 WHERE id=$1", [membership, id]);
          const claims = (await client.query<{ id: string }>("SELECT id::text FROM ingest.claims WHERE artist_membership_id=$1", [membership])).rows;
          await audit(client, runId, { membership }, "person_id", split.from, id, split.why, claims.map((row) => Number(row.id)));
        }
        if (part.claims.length > 0) {
          await client.query("UPDATE ingest.claims SET person_id=$2 WHERE id = ANY($1::bigint[])", [part.claims, id]);
        }
        if (part.reviewWith !== undefined) {
          const opened = await client.query(`
            INSERT INTO ingest.review_queue(kind,person_a_id,person_b_id,priority,status,payload,notes)
            SELECT 'person_duplicate',LEAST($1::bigint,$2::bigint),GREATEST($1::bigint,$2::bigint),6,'open',$3::jsonb,$4
             WHERE NOT EXISTS (SELECT 1 FROM ingest.review_queue q WHERE q.kind='person_duplicate' AND q.status IN ('open','in_progress')
                              AND q.person_a_id=LEAST($1::bigint,$2::bigint) AND q.person_b_id=GREATEST($1::bigint,$2::bigint))
            RETURNING id::text`,
          [id, part.reviewWith.id, JSON.stringify({ detector: "split-mixed-persons", version: 1, runId }), part.reviewWith.why]);
          reviews.push(...opened.rows.map((row) => Number(row.id)));
        }
        created.push({ from: split.from, id, name: part.name, memberships: part.memberships });
      }
      const sourceClaims = (await client.query<{ id: string }>("SELECT id::text FROM ingest.claims WHERE person_id=$1", [split.from])).rows.map((row) => Number(row.id));
      for (const aliasId of split.dropAliases) {
        const alias = (await client.query<{ alias: string }>("DELETE FROM ingest.person_aliases WHERE id=$1 AND person_id=$2 RETURNING alias", [aliasId, split.from])).rows[0];
        if (alias !== undefined) await audit(client, runId, { person: split.from }, "alias", alias.alias, null, `alias de otro perfil: ${split.why}`, sourceClaims);
      }
      if (source.real_name !== null) {
        await client.query("UPDATE public.persons SET real_name=NULL, updated_at=now() WHERE id=$1", [split.from]);
        await audit(client, runId, { person: split.from }, "real_name", source.real_name, null, `nombre real de otro perfil: ${split.why}`,
          split.parts.flatMap((part) => part.claims));
      }
    }
  })).runId;
  out["created"] = created;
  out["reviewsOpened"] = reviews;

  const dismissed: number[] = [];
  for (const split of SPLITS) {
    for (const item of split.dismiss) {
      await rejectReview(item.review, { operator: OPERATOR, note: `Par sin base tras separar la ficha ${split.from}: ${item.why}` });
      dismissed.push(item.review);
    }
  }
  out["dismissed"] = dismissed;
  const path = "reports/separar-fichas-mezcladas-2026-10-02.json";
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify({ report: path, runId: out["runId"], created, reviewsOpened: reviews, dismissed }, null, 2));
  await closeDb();
}

await main();
