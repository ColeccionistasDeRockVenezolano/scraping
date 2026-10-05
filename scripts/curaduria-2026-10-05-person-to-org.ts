// CRV · Curaduría 2026-10-05: personas que son una organización (o un trozo de su nombre: «Rock» y
// «Folk» de «Estudios Rock & Folk», «Art» y «Sounds» de «Art & Sounds»). Sus créditos pasan a la
// organización existente o a una nueva; el nombre suelto queda como alias de la organización.
//
//   --map="<personId>=<orgId>;<personId>=new:<tipo>:<nombre>;…"  [--drop-track-credits=<personIds>] --note="…"
import { closeDb } from "../src/db/client.js";
import { createEntity, withOperatorRun } from "../src/merge/operator.js";
import { removeRelation } from "../src/merge/removals.js";
import { convertPerson } from "../src/review/person-corrections.js";

const arg = (name: string): string | undefined => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const note = arg("note") ?? "Curaduría 2026-10-05";
const map = arg("map")!.split(";").filter(Boolean).map((pair) => { const i = pair.indexOf("="); return [Number(pair.slice(0, i)), pair.slice(i + 1)] as const; });
const dropTrack = (arg("drop-track-credits") ?? "").split(",").filter(Boolean).map(Number);
const { runId } = await withOperatorRun({ name: "curation:person-to-organization", operator: "claude-code", note }, async (context) => {
  for (const personId of dropTrack) {
    const { rows } = await context.client.query<{ id: string }>("SELECT id::text FROM public.track_credits WHERE person_id=$1", [personId]);
    for (const row of rows) await removeRelation(context.client, "track_credit", Number(row.id), { note, runId: context.runId });
  }
  const created = new Map<string, number>();
  for (const [personId, target] of map) {
    if (target.startsWith("artist:")) {
      await convertPerson(context.client, personId, { kind: "artist", id: Number(target.slice(7)) }, true, note, context.runId);
      continue;
    }
    let orgId: number;
    if (target.startsWith("new:")) {
      const [, type, ...name] = target.split(":");
      const key = name.join(":");
      if (!created.has(key)) {
        const result = await createEntity(context, "organization", { name: key, organization_type: type }, { allowSimilar: true });
        created.set(key, Number(result.id));
      }
      orgId = created.get(key)!;
    } else orgId = Number(target);
    await convertPerson(context.client, personId, { kind: "organization", id: orgId }, true, note, context.runId);
  }
});
console.log(`run ${runId}: ${map.length} personas convertidas`);
await closeDb();
