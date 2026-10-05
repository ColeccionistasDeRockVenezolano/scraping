// CRV · Curaduría 2026-10-05: «Moisés Peña» #7380 juntaba dos personas: el compositor de aguinaldos
// (Sincopa: «Zapatico De Navidad», Alexis Rossell 1984) y el bajista de Predator T (Metal Archives).
// El compositor es el fundador y director de Los Tucusitos (#40229; MinCultura: fundó el coro en 1959,
// murió en 1997). Lo navideño pasa a #40229; #7380 queda para el bajista.
import { closeDb } from "../src/db/client.js";
import { rejectReview } from "../src/review/operator-review.js";
import { withOperatorRun } from "../src/merge/operator.js";

const NOTE = "Curaduría 2026-10-05: el compositor navideño Moisés Peña es el fundador de Los Tucusitos (mincultura.gob.ve), no el bajista de Predator T";
const { runId } = await withOperatorRun({ name: "curation:split-moises-pena", operator: "claude-code", note: NOTE }, async ({ client }) => {
  await client.query("UPDATE public.track_credits SET person_id=40229 WHERE id=7534 AND person_id=7380");
  await client.query("UPDATE ingest.claims SET person_id=40229, updated_at=now() WHERE id IN (304495,1881658,642642) AND person_id=7380");
  await client.query(`UPDATE public.persons p SET biography=COALESCE(p.biography, o.biography), is_deceased=true, updated_at=now()
    FROM public.persons o WHERE p.id=40229 AND o.id=7380`);
  await client.query("UPDATE public.persons SET biography=NULL, updated_at=now() WHERE id=7380");
});
console.log(`run ${runId}`);
console.log(await rejectReview(1833539, { operator: "claude-code", note: `${NOTE}. No se fusionan: el #7380 que quedaba era el bajista (run ${runId}).` }));
await closeDb();
