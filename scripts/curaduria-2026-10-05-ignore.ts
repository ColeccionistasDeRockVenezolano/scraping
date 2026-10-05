// CRV · Curaduría 2026-10-05: ignorar hallazgos revisados con motivo y nota (mismo camino que la web).
//
//   ./scripts/with-node22.sh npx tsx scripts/curaduria-2026-10-05-ignore.ts --reason=correcto_a_proposito|falso_positivo|fuera_de_alcance
//        --note="…" (--ids=<archivo JSON> | --detector=<clave> [--signature=…]) [--confirm]
import { readFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";
import { ignoreFinding } from "../src/curation/repository.js";

const arg = (name: string): string | undefined => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const reason = arg("reason") as "correcto_a_proposito" | "falso_positivo" | "fuera_de_alcance";
const note = arg("note");
if (!reason || !note) throw new Error("faltan --reason y --note");
let ids: number[];
if (arg("ids")) ids = /^[\d,]+$/u.test(arg("ids")!) ? arg("ids")!.split(",").map(Number) : JSON.parse(readFileSync(arg("ids")!, "utf8")) as number[];
else {
  const { rows } = await getPool().query<{ id: string }>(
    "SELECT id::text FROM ingest.curation_findings WHERE status='open' AND detector=$1 AND ($2::text IS NULL OR signature=$2) ORDER BY id",
    [arg("detector"), arg("signature") ?? null]);
  ids = rows.map((row) => Number(row.id));
}
console.log(`${ids.length} hallazgos`);
if (process.argv.includes("--confirm")) {
  let done = 0;
  for (const id of ids) { try { await ignoreFinding(id, "claude-code", reason, note); done += 1; } catch (error) { console.log(id, String(error)); } }
  console.log(`ignorados ${done}`);
}
await closeDb();
