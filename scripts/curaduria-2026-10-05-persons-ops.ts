// CRV · Curaduría 2026-10-05: retiros y renombres puntuales de personas, por el motor (auditados en un run).
//
//   --retire=<ids>          persona que no es nadie («Radio Edit», «Balada»): se retiran sus créditos y la ficha
//   --rename=<id>=<nombre>;…  nombre corregido
//   --split=<id>=<A>|<B>;…    varias personas en una ficha: se reparte en una por nombre
//   --alias=<id>=<alias>;…    alias de nombre (apodo final, seudónimo)
//   ./scripts/with-node22.sh npx tsx scripts/curaduria-2026-10-05-persons-ops.ts --retire=1,2 --rename="3=Ana" --note="…"
import { closeDb } from "../src/db/client.js";
import { deleteEntity, updateEntity, withOperatorRun } from "../src/merge/operator.js";
import { removeRelation } from "../src/merge/removals.js";
import { splitPerson } from "../src/review/person-corrections.js";
import { normalizeEntityName } from "../src/normalization/entity-name.js";

const arg = (name: string): string | undefined => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const retire = (arg("retire") ?? "").split(",").filter(Boolean).map(Number);
const renames = (arg("rename") ?? "").split(";").filter(Boolean).map((pair) => { const i = pair.indexOf("="); return [Number(pair.slice(0, i)), pair.slice(i + 1)] as const; });
const pairs = (name: string): Array<readonly [number, string]> => (arg(name) ?? "").split(";").filter(Boolean).map((pair) => { const i = pair.indexOf("="); return [Number(pair.slice(0, i)), pair.slice(i + 1)] as const; });
const splits = pairs("split");
const aliases = pairs("alias");
const note = arg("note") ?? "Curaduría 2026-10-05";
const RELATIONS = [
  { kind: "track_credit", table: "track_credits" }, { kind: "album_credit", table: "album_credits" },
  { kind: "artist_membership", table: "artist_members" }, { kind: "person_organization", table: "person_organizations" },
] as const;
const { runId } = await withOperatorRun({ name: "curation:persons-ops", operator: "claude-code", note }, async (context) => {
  for (const id of retire) {
    for (const relation of RELATIONS) {
      const { rows } = await context.client.query<{ id: string }>(`SELECT id::text FROM public.${relation.table} WHERE person_id=$1`, [id]);
      for (const row of rows) await removeRelation(context.client, relation.kind, Number(row.id), { note, runId: context.runId });
    }
    await deleteEntity(context, "person", id);
  }
  for (const [id, name] of renames) await updateEntity(context, "person", id, { name });
  for (const [id, names] of splits) await splitPerson(context.client, id, names.split("|"), note, context.runId);
  for (const [id, alias] of aliases) {
    await context.client.query(`INSERT INTO ingest.person_aliases(person_id,alias,alias_type,normalized_alias,is_primary,confidence,notes)
      SELECT $1::bigint,$2::text,'name_variant',$3::text,false,'high',$4::text
       WHERE NOT EXISTS (SELECT 1 FROM ingest.person_aliases WHERE person_id=$1::bigint AND normalized_alias=$3::text)`,
      [id, alias, normalizeEntityName(alias).primaryKey, note]);
  }
});
console.log(`run ${runId}: ${retire.length} retiradas, ${renames.length} renombradas, ${splits.length} divididas, ${aliases.length} alias`);
await closeDb();
