// CRV · Curaduría 2026-10-05: recopilaciones dobles numeradas seguidas (Serie 32, 40 Años 40 Éxitos).
// El catálogo las numera 1–32 / 1–40 en un disco; MusicBrainz/Deezer las dan en dos (16+16, 20+20) y
// sus pistas del disco 2 que no casaron quedaron sueltas en «disco 2». La n-ésima del disco 2 es la
// 16+n (o 20+n): si la misma canción ya está ahí (de Sincopa), se funden; si el puesto está libre, se muda.
import { closeDb } from "../src/db/client.js";
import { withOperatorRun } from "../src/merge/operator.js";
import { mergeInto } from "../src/review/duplicates.js";

const NOTE = "Curaduría 2026-10-05: pista del disco 2 de MusicBrainz/Deezer en su puesto de la numeración seguida del catálogo";
const MERGES: Array<[keep: number, drop: number]> = [[155792, 142089], [155799, 142096], [155835, 142589], [155847, 142601]];
const { runId } = await withOperatorRun({ name: "curation:disc2-compilations", operator: "claude-code", note: NOTE }, async ({ client, runId: run }) => {
  for (const [keep, drop] of MERGES) {
    const { rows: [dur] } = await client.query<{ d: number | null }>("SELECT duration_seconds d FROM public.tracks WHERE id=$1", [drop]);
    await mergeInto(client, "track", keep, drop, NOTE, run, { alias: true });
    if (dur?.d) await client.query("UPDATE public.tracks SET duration_seconds=$1 WHERE id=$2 AND duration_seconds IS NULL", [dur.d, keep]);
  }
  // Luis Silva «32 Grandes Éxitos»: la 2-16 «Enfurecida» (versión de 4:35) es la 32, que faltaba.
  await client.query("UPDATE public.tracks SET disc_number=1, track_number=32 WHERE id=148726");
});
console.log(`run ${runId}`);
await closeDb();
