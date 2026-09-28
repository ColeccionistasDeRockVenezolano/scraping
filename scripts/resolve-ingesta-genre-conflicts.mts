import { closeDb } from "../src/db/client.js";
import { decideGenre } from "../src/genres/curation.js";

const decisions = [
  { reviewId: 245146, kind: "album", entityId: 1047, genreSlug: "rock-fusion", reason: "Descargas Metal Venezolano afirma Rock-Fusión para No Limits; se precisa el Rock principal previamente confirmado." },
  { reviewId: 245147, kind: "album", entityId: 3807, genreSlug: "rock-fusion", reason: "Sincopa afirma Rock-Fusion/Latin para Cósmicos; se precisa el Rock principal previamente confirmado." },
  { reviewId: 245148, kind: "album", entityId: 4225, genreSlug: "rock-fusion", reason: "Sincopa afirma Rock-Fusion para Listo Para Llevar; se precisa el Rock principal previamente confirmado." },
  { reviewId: 248960, kind: "artist", entityId: 1851, genreSlug: "fusion-latina", reason: "Se conserva la decisión editorial Fusión latina de Paro Kardíaco: la lista original incluye Fusion y Latin, mientras Rock, Ska y Reggae ya constan como secundarios. La nueva lectura de Fusion no sustituye esta decisión." },
] as const;

try {
  for (const row of decisions) {
    console.log(`${row.reviewId}: ${row.kind} ${row.entityId} → ${row.genreSlug}`);
    if (!process.argv.includes("--confirm")) continue;
    const result = await decideGenre({
      action: "confirm_primary", kind: row.kind, entityId: row.entityId,
      genreSlug: row.genreSlug, actor: "codex", reason: row.reason,
      reviewIds: [row.reviewId], closeCases: true,
    });
    if (!result.closedReviewIds.includes(row.reviewId)) throw new Error(`no se cerró ${row.reviewId}`);
    console.log(`  run ${result.runId}: confirmado`);
  }
} finally {
  await closeDb();
}
