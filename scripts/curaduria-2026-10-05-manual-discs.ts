// CRV · Curaduría 2026-10-05: discos dobles aplanados que split-discs no pudo separar solo.
//
//   3856 Carlos Baute · Directo En Tus Manos (CD+DVD): «Te Extraño Porque Te Extraño» (CD 11) y «No Me
//        Abandones Amiga Mía» (CD 12) tenían los claims cruzados y la ocurrencia del DVD 12 colgaba de
//        la pista del CD; la pista sobrante del CD 12 (sin datos propios) se funde en la del CD.
//   4153 Paul Gillman · Más Vivo & En Vivo (CD+DVD): la ficha escribe «14- El Poeta» y «01- Alfredo
//        Escalante» en una sola línea y la cosecha no los capturó: se crean (CD 14 y DVD 1, 7, 12).
//   9431 Quinteto Contrapunto · 32 Grandes Exitos y 8833 Luis Silva · Serie 32: 16 + 16 según la ficha
//        (en 8833, «Enfurecida» abre el CD1 y la «versión internacional» cierra el CD2).
//
//   ./scripts/with-node22.sh npx tsx scripts/curaduria-2026-10-05-manual-discs.ts [--confirm]
import type { PoolClient } from "pg";
import { closeDb, getPool } from "../src/db/client.js";
import { withOperatorRun } from "../src/merge/operator.js";
import { mergeInto } from "../src/review/duplicates.js";

const NOTE = "Curaduría 2026-10-05: disco doble separado a mano según su ficha de Sincopa (CD1/CD2 o CD+DVD)";
type Item = number | { title: string; page?: number; pos?: number };
const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const LAYOUT: Record<number, Item[][]> = {
  3856: [
    [24383, 24381, 24386, 24394, 24382, 24387, 24384, 24388, 24385, 24389, 30957, 24393, 24390, 24391, 24392, 24396],
    [164758, ...range(164759, 164768), { title: "Te Extraño Porque Te Extraño", page: 1601, pos: 32 }, 164769, 164770, 164771, 164772, 164773, 164774],
  ],
  4153: [
    [33006, 33011, 33017, 33023, 33030, 33036, 157612, 157613, 157614, 158828, 157871, 157615, 157872, { title: "El Poeta" }, 157616, 157617, 157618],
    [{ title: "Alfredo Escalante (Presentación 1994)" }, 157873, 164044, 164045, 164046, 164047, { title: "Alfredo Escalante (Intro 1982)" }, 164048, 157619,
      164049, 164050, { title: "Alfredo Escalante (Intro 1981)" }, 164051, 164052, 157874, 164053, 164054, 157620],
  ],
  9431: [range(68216, 68231), [158832, ...range(156792, 156806)]],
  8833: [[66112, ...range(66113, 66126), 156462], [66127, ...range(156463, 156476), 148726]],
};

async function claimsAt(client: PoolClient, page: number, pos: number): Promise<number[]> {
  const { rows } = await client.query<{ id: string }>(`
    SELECT c.id::text FROM ingest.claims c WHERE c.source_id=7 AND c.raw_page_id=$1 AND c.entity_kind='track'
       AND EXISTS (SELECT 1 FROM ingest.claim_evidence e WHERE e.claim_id=c.id AND e.position=$2)
       AND NOT EXISTS (SELECT 1 FROM ingest.claim_evidence e WHERE e.claim_id=c.id AND e.position IS DISTINCT FROM $2)`, [page, pos]);
  return rows.map((row) => Number(row.id));
}
const moveClaims = async (client: PoolClient, trackId: number, page: number, pos: number): Promise<void> => {
  await client.query("UPDATE ingest.claims SET track_id=$1, updated_at=now() WHERE id=ANY($2::bigint[])", [trackId, await claimsAt(client, page, pos)]);
};

async function work(client: PoolClient, runId: number): Promise<void> {
  // Baute: cada entrada del CD vuelve a su pista; la sobrante se funde.
  await moveClaims(client, 30957, 1601, 11);
  await moveClaims(client, 24393, 1601, 12);
  await mergeInto(client, "track", 24393, 164757, NOTE, runId, {});
  await client.query("UPDATE public.tracks SET title='Enfurecida (Versión Internacional)' WHERE id=148726");
  for (const [albumKey, discs] of Object.entries(LAYOUT)) {
    const albumId = Number(albumKey);
    await client.query("UPDATE public.tracks SET track_number=track_number+10000 WHERE album_id=$1", [albumId]);
    for (const [d, items] of discs.entries()) {
      for (const [i, item] of items.entries()) {
        if (typeof item === "number") {
          const { rowCount } = await client.query("UPDATE public.tracks SET disc_number=$1, track_number=$2 WHERE id=$3 AND album_id=$4", [d + 1, i + 1, item, albumId]);
          if (rowCount !== 1) throw new Error(`pista ${item} no está en ${albumId}`);
        } else {
          const { rows: [created] } = await client.query<{ id: string }>(
            "INSERT INTO public.tracks(album_id, disc_number, track_number, title) VALUES ($1,$2,$3,$4) RETURNING id::text", [albumId, d + 1, i + 1, item.title]);
          if (item.page && item.pos) await moveClaims(client, Number(created!.id), item.page, item.pos);
        }
      }
    }
    const { rows: left } = await client.query("SELECT id FROM public.tracks WHERE album_id=$1 AND track_number>10000", [albumId]);
    if (left.length) throw new Error(`disco ${albumId}: ${left.map((r: { id: string }) => r.id).join(",")} sin numerar`);
  }
}

if (process.argv.includes("--confirm")) {
  const { runId } = await withOperatorRun({ name: "curation:manual-flattened-discs", operator: "claude-code", note: NOTE }, ({ client, runId }) => work(client, runId));
  console.log(`run ${runId}`);
} else console.log("usar --confirm (las fusiones necesitan un run)");
await closeDb();
