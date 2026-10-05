// CRV · Curaduría 2026-10-05: correcciones puntuales de nombre o título por el motor (un run).
//
//   ./scripts/with-node22.sh npx tsx scripts/curaduria-2026-10-05-rename.ts --kind=organization|artist|album|track
//        --pairs="<id>=<nombre>;…" | --file=<tsv id\tnombre> --note="…"
//        [--column=organization_type] cambia otro campo en vez del nombre
import { readFileSync } from "node:fs";
import { closeDb } from "../src/db/client.js";
import { updateEntity, withOperatorRun } from "../src/merge/operator.js";
import { ENTITY_SPECS, type ResolvableClaimKind } from "../src/merge/specs.js";

const arg = (name: string): string | undefined => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const kind = arg("kind") as ResolvableClaimKind;
const column = arg("column") ?? ENTITY_SPECS[kind].identityColumn;
const pairs = (arg("file") ? readFileSync(arg("file")!, "utf8").split("\n").filter(Boolean).map((line) => line.replace("\t", "=")) : arg("pairs")!.split(";"))
  .filter(Boolean).map((pair) => { const i = pair.indexOf("="); return [Number(pair.slice(0, i)), pair.slice(i + 1)] as const; });
const note = arg("note") ?? "Curaduría 2026-10-05";
const failed: string[] = [];
const { runId } = await withOperatorRun({ name: `curation:rename-${kind}`, operator: "claude-code", note }, async (context) => {
  for (const [id, name] of pairs) {
    await context.client.query("SAVEPOINT r");
    try { await updateEntity(context, kind, id, { [column]: name === "" ? null : name }); await context.client.query("RELEASE SAVEPOINT r"); }
    catch (error) { await context.client.query("ROLLBACK TO SAVEPOINT r"); failed.push(`${id} ${name}: ${String(error)}`); }
  }
});
console.log(`run ${runId}: ${pairs.length - failed.length} cambios de ${kind}`);
for (const line of failed) console.log("  fallo", line);
await closeDb();
