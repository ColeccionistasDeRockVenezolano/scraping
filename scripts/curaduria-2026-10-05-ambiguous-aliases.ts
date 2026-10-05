// CRV · Curaduría 2026-10-05: alias ambiguos de discos y pistas. Cada caso es la misma canción o el
// mismo título en otro disco/otro artista (fichas distintas legítimas): no aplicar el alias es lo
// correcto y la revisión se descarta. El único duplicado real (Balzehaguaos) se fusionó en el run 15051.
import { closeDb, getPool } from "../src/db/client.js";
import { rejectReview } from "../src/review/operator-review.js";

const { rows } = await getPool().query<{ id: string }>("SELECT id::text FROM ingest.review_queue WHERE kind='ambiguous_alias' AND status IN ('open','in_progress') ORDER BY id");
for (const row of rows) {
  const note = "Curaduría 2026-10-05: el alias pertenece con razón a otra ficha (mismo título en otro disco u otro artista); no se aplica";
  const result = await rejectReview(Number(row.id), { operator: "claude-code", note });
  console.log(row.id, result.status);
}
await closeDb();
