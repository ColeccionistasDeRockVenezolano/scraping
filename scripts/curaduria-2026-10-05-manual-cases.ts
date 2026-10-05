// CRV · Curaduría 2026-10-05: las dos revisiones manuales de personas mezcladas (run 13019).
//   ./scripts/with-node22.sh npx tsx scripts/curaduria-2026-10-05-manual-cases.ts
import { closeDb } from "../src/db/client.js";
import { rejectReview } from "../src/review/operator-review.js";

const operator = "claude-code";
console.log(await rejectReview(1832636, { operator, note:
  "Curaduría 2026-10-05: ninguna fuente dice qué O'Brien es (los discos imprimen solo «O'Brien»; podría ser también el padre, Pat O'Brien). El crédito se queda en la ficha «O'Brien» tal como lo imprime el disco." }));
console.log(await rejectReview(1832639, { operator, note:
  "Curaduría 2026-10-05: el bajo en Luz Verde (2014) se queda con Ezequiel Serrano Valencia (#883), guitarrista y bajista de rock; el padre (#2568) toca saxo y flauta." }));
await closeDb();
