// CRV · Curaduría 2026-10-05: ejecuta un archivo SQL de correcciones dentro de un run reversible.
//
// Para arreglos puntuales ya verificados a mano (retitulados, discos, números): todo queda en el
// diario de cambios ligado al run y se deshace con `runs undo`.
//
//   ./scripts/with-node22.sh npx tsx scripts/curaduria-2026-10-05-sql-run.ts --file=<x.sql> --name=<clave> --note="…"
import { readFileSync } from "node:fs";
import { closeDb } from "../src/db/client.js";
import { withOperatorRun } from "../src/merge/operator.js";

const arg = (name: string): string | undefined => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const sql = readFileSync(arg("file")!, "utf8");
const { runId } = await withOperatorRun({ name: `curation:${arg("name")}`, operator: "claude-code", note: arg("note")! }, async ({ client }) => {
  await client.query(sql);
});
console.log(`run ${runId}`);
await closeDb();
