// CRV · Curaduría 2026-10-05: los tres casos de género de la cola de revisión.
//   ./scripts/with-node22.sh npx tsx scripts/curaduria-2026-10-05-genre-cases.ts
import { closeDb } from "../src/db/client.js";
import { decideGenre } from "../src/genres/curation.js";

const actor = "claude-code";
const cases = [
  { reviewIds: [1831814], kind: "album" as const, entityId: 52, action: "confirm_primary" as const, genreSlug: "disco",
    reason: "Curaduría 2026-10-05: tras la fusión manda el principal que decidió Brian (Disco, rudylascala.com); Pop de Sincopa queda como secundario" },
  { reviewIds: [1833684], kind: "album" as const, entityId: 2846, action: "add_secondary" as const, genreSlug: "rock-progresivo",
    reason: "Curaduría 2026-10-05: Sincopa dice Rock-Progressive; queda como secundario, el principal Post-rock (Bandcamp) se mantiene" },
  { reviewIds: [1833683], kind: "album" as const, entityId: 3021, action: "add_secondary" as const, genreSlug: "pop-rock",
    reason: "Curaduría 2026-10-05: Sincopa dice Pop-Rock (más específico que Rock de Laya); entra como secundario, una fuente basta" },
];
for (const item of cases) console.log(await decideGenre({ ...item, actor, closeCases: true }));
await closeDb();
