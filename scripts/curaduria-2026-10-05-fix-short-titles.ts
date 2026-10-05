// CRV · Curaduría 2026-10-05: tres pistas reales de una palabra que la ingesta descartó por cortas
// («No» de Kiara, «No» de Mirtha Pérez —Armando Manzanero—, «Yo» de Punto Sur —Antonio Bolívar—);
// dejaban un hueco en su recopilación. Se crean en su puesto con los claims de la ficha de Sincopa.
import { closeDb } from "../src/db/client.js";
import { withOperatorRun } from "../src/merge/operator.js";

const NOTE = "Curaduría 2026-10-05: título de una palabra real según la ficha de Sincopa (el filtro lo había rechazado por corto)";
const ITEMS = [{ album: 4346, page: 2354, position: 28, number: 27, title: "No" }, { album: 7581, page: 5733, position: 28, number: 27, title: "No" },
  { album: 7732, page: 5817, position: 36, number: 35, title: "Yo" }];
const { runId } = await withOperatorRun({ name: "curation:short-titles", operator: "claude-code", note: NOTE }, async ({ client }) => {
  for (const item of ITEMS) {
    const { rows: [created] } = await client.query<{ id: string }>(
      "INSERT INTO public.tracks(album_id, disc_number, track_number, title) VALUES ($1,1,$2,$3) RETURNING id::text", [item.album, item.number, item.title]);
    const { rowCount } = await client.query(`UPDATE ingest.claims c SET track_id=$1, status='accepted', updated_at=now() FROM ingest.claim_evidence e
      WHERE e.claim_id=c.id AND c.source_id=7 AND c.raw_page_id=$2 AND e.position=$3 AND c.entity_kind='track' AND c.field IN ('title','album_title','artist_name')`,
      [Number(created!.id), item.page, item.position]);
    console.log(item.album, created!.id, rowCount);
  }
});
console.log(`run ${runId}`);
await closeDb();
