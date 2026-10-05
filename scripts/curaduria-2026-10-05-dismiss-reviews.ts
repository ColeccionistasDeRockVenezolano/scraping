// CRV · Curaduría 2026-10-05: revisiones abiertas por las propias correcciones de la curaduría.
//
// - ambiguous_alias: al renombrar o dividir, el título/nombre viejo queda como alias y choca con otra
//   ficha legítima (otra grabación, otro disco): el alias no se aplica y la revisión se descarta.
// - person_match: al dividir «A - B» el motor compara cada nombre nuevo con personas parecidas; los
//   casos que eran la misma persona ya se fusionaron (run 16420), el resto son personas distintas.
//
//   ./scripts/with-node22.sh npx tsx scripts/curaduria-2026-10-05-dismiss-reviews.ts --kinds=ambiguous_alias,person_match --since=<id>
import { closeDb, getPool } from "../src/db/client.js";
import { rejectReview } from "../src/review/operator-review.js";

const arg = (name: string): string | undefined => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const kinds = arg("kinds")!.split(",");
const { rows } = await getPool().query<{ id: string; kind: string }>(
  "SELECT id::text, kind FROM ingest.review_queue WHERE kind::text = ANY($1::text[]) AND status IN ('open','in_progress') AND id >= $2 ORDER BY id",
  [kinds, Number(arg("since") ?? 0)]);
const notes: Record<string, string> = {
  ambiguous_alias: "Curaduría 2026-10-05: el nombre o título anterior pertenece con razón a otra ficha (otra grabación u otro disco); no se aplica como alias",
  person_match: "Curaduría 2026-10-05: personas distintas con nombre parecido (los casos de la misma persona se fusionaron en el run 16420)",
};
let done = 0;
for (const row of rows) {
  try { await rejectReview(Number(row.id), { operator: "claude-code", note: notes[row.kind] ?? "Curaduría 2026-10-05" }); done += 1; }
  catch (error) { console.log(row.id, String(error)); }
}
console.log(`${done}/${rows.length} descartadas`);
await closeDb();
