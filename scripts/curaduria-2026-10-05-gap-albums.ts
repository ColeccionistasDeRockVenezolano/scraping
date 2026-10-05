// CRV · Curaduría 2026-10-05: últimos discos con huecos de numeración, a mano.
//
// El reconstructor (rebuild-sincopa-order) los dejó fuera: pistas combinadas por otra fuente
// («Jazz, El Leñador», «Más, Lana, Romance en Rusia»), dos fichas de Sincopa para un disco,
// entradas rechazadas o números de otra fuente. El orden de cada uno sale de una fuente verificada:
//   957  Eternal Sorrow · Humana Descomposición — Metal Archives (album-details.jsonl)
//   3157 Agua Dulce — Deezer («Jazz» 248 s y «Leñador» 223 s son dos pistas)
//   3313, 3014, 2863, 9042, 4224 — orden de su ficha de Sincopa (4224 lo confirma rockhechovenezuela:
//        «Baila La Yenka» y «El Día Que Tú Partiste» están en las dos caras; la A5 es «Ritmo Ardillitas»)
//   2467 Alexis Rossell — ficha alexrossell_1vzla (1401) y el blog Rock de Vzla coinciden;
//        la ficha 1400 es otra edición: sus números (y el del operador que la copió) quedan superados
//   1023 Carne de Manzanas — 11 y 12 de la ficha son las versiones en vivo (crv-operador)
//   3059 Lo Inédito — «Loco Por El Rock & Roll» y «Loco por el Rock´n´Roll.» son la misma pista
// Cada pista nueva recibe los claims de su entrada de la ficha (los que solo hablan de esa posición).
//
//   ./scripts/with-node22.sh npx tsx scripts/curaduria-2026-10-05-gap-albums.ts [--confirm]
import type { PoolClient } from "pg";
import { closeDb, getPool } from "../src/db/client.js";
import { withOperatorRun } from "../src/merge/operator.js";
import { mergeInto } from "../src/review/duplicates.js";

const NOTE = "Curaduría 2026-10-05: disco con huecos de numeración; orden según su fuente verificada (Metal Archives, Deezer o la ficha de Sincopa)";

/** Una pista del orden final: existente (`id`) o nueva (`title`); `page`/`pos` = entrada de Sincopa cuyos claims le pertenecen. */
interface Item { id?: number; title?: string; duration?: number; page?: number; pos?: number }
const ORDERS: Record<number, Item[]> = {
  957: [{ id: 8580 }, { id: 8586 }, { id: 8589 }, { title: "El Efecto Monsanto", duration: 174 }, { id: 8595 }, { id: 42390 }, { id: 42391 }],
  3157: [{ id: 42135 }, { id: 42136 }, { id: 42137, title: "Jazz", duration: 248 }, { title: "Leñador", duration: 223 },
    { id: 42138 }, { id: 42139 }, { id: 42140 }, { id: 42141 }, { id: 42142 }, { id: 42143 }, { id: 42144 }],
  3313: [{ id: 20778 }, { id: 20771 }, { id: 20780 }, { id: 20784 }, { id: 20777 }, { id: 20796, title: "Más", page: 1925, pos: 6 },
    { title: "Lana", page: 1925, pos: 8 }, { title: "Romance En Rusia", page: 1925, pos: 9 },
    { id: 20781, page: 1925, pos: 10 }, { id: 20782, page: 1925, pos: 11 }, { id: 20785 }, { id: 20795 }],
  3014: [{ id: 18440, page: 1347, pos: 1 }, { id: 18443, page: 1347, pos: 2 }, { id: 18449, page: 1347, pos: 3 }, { id: 18442, page: 1347, pos: 4 },
    { id: 18447, page: 1347, pos: 5 }, { id: 18441, page: 1347, pos: 7 }, { id: 18444, title: "Crisis", page: 1347, pos: 8 },
    { title: "Háblame De Ti", page: 1347, pos: 9 }, { id: 18445, page: 1347, pos: 10 }, { id: 18446, page: 1347, pos: 11 }],
  2863: [{ id: 17443 }, { id: 155469, page: 1015, pos: 7 }, { id: 17448, title: "Potpourri Los Beatles", page: 1015, pos: 8 },
    { id: 17456, page: 1015, pos: 12 }, { id: 17451, page: 1015, pos: 13 }, { id: 17454, page: 1015, pos: 15 }, { id: 17455, page: 1015, pos: 20 },
    { id: 17458, page: 1015, pos: 21 }, { id: 17463, page: 1015, pos: 22 }, { id: 17457, page: 1015, pos: 23 }, { id: 17459, page: 1015, pos: 24 }],
  2467: [{ id: 15244 }, { title: "La Curiara", page: 1401, pos: 2 }, { id: 15248 }, { id: 15247 }, { id: 15249 }, { id: 15255 },
    { id: 15250 }, { id: 15259 }, { id: 15251 }, { title: "Orinoco", page: 1401, pos: 11 }],
  9042: [84487, 158586, 84488, 84489, 158587, 157863, 84490, 157864, 84491, 84492].map((id) => ({ id }) as Item)
    .concat([{ title: "Bolívar", duration: 214, page: 7473, pos: 10 }],
      [157865, 84493, 84494, 157866, 158588, 157867, 84495, 157868, 84496, 84497, 84498, 157869, 84499].map((id) => ({ id }))),
  4224: [{ id: 78598 }, { title: "El Día Que Tú Partiste", page: 2002, pos: 2 }, { id: 78599 }, { id: 78600 },
    { title: "Baila La Yenka (Ritmo Ardillitas)", page: 2002, pos: 5 }, { id: 78601 }, { id: 78602 }, { id: 78603 },
    { title: "Baila La Yenka", page: 2002, pos: 10 }, { id: 78604 }, { id: 78605 }, { title: "El Día Que Tú Partiste", page: 2002, pos: 13 },
    { id: 78606 }, { id: 78607 }],
  1023: [{ id: 79426 }, { id: 79427 }, { id: 79428 }, { id: 79429 }, { id: 79430 }, { id: 79431 }, { id: 79432 }, { id: 79433 }, { id: 79434 },
    { id: 79435 }, { id: 38802 }, { id: 38808 }, { id: 79436 }],
};

/** Claims de Sincopa cuya única evidencia en la ficha es esa posición. */
async function entryClaims(client: PoolClient, page: number, pos: number): Promise<number[]> {
  const { rows } = await client.query<{ id: string }>(`
    SELECT c.id::text FROM ingest.claims c WHERE c.source_id=7 AND c.raw_page_id=$1 AND c.entity_kind='track'
       AND EXISTS (SELECT 1 FROM ingest.claim_evidence e WHERE e.claim_id=c.id AND e.position=$2)
       AND NOT EXISTS (SELECT 1 FROM ingest.claim_evidence e WHERE e.claim_id=c.id AND e.position IS DISTINCT FROM $2)`, [page, pos]);
  return rows.map((row) => Number(row.id));
}

async function work(client: PoolClient, runId: number): Promise<void> {
  // Lo Inédito: dos fichas para la misma canción (Sincopa y el blog).
  await mergeInto(client, "track", 18955, 79353, NOTE, runId, {});
  await client.query("UPDATE public.tracks SET title='Loco Por El Rock & Roll' WHERE id=18955");
  // Alexis Rossell: números de la otra edición (ficha 1400) y el del operador que la copió.
  await client.query(`UPDATE ingest.claims SET status='superseded', updated_at=now() WHERE field='track_number' AND status='accepted'
     AND track_id = ANY('{15244,15250,15251}'::bigint[]) AND ((source_id=7 AND raw_page_id=1400) OR id=569764)`);
  for (const [albumKey, items] of Object.entries(ORDERS)) {
    const albumId = Number(albumKey);
    await client.query("UPDATE public.tracks SET track_number=track_number+10000 WHERE album_id=$1", [albumId]);
    for (const [index, item] of items.entries()) {
      const k = index + 1;
      let trackId = item.id;
      if (trackId === undefined) {
        const { rows: [created] } = await client.query<{ id: string }>(
          "INSERT INTO public.tracks(album_id, disc_number, track_number, title, duration_seconds) VALUES ($1,1,$2,$3,$4) RETURNING id::text",
          [albumId, k, item.title, item.duration ?? null]);
        trackId = Number(created!.id);
      } else {
        const { rowCount } = await client.query("UPDATE public.tracks SET track_number=$1 WHERE id=$2 AND album_id=$3", [k, trackId, albumId]);
        if (rowCount !== 1) throw new Error(`pista ${trackId} no está en el disco ${albumId}`);
        if (item.title) await client.query("UPDATE public.tracks SET title=$1 WHERE id=$2", [item.title, trackId]);
        if (item.duration) await client.query("UPDATE public.tracks SET duration_seconds=$1 WHERE id=$2 AND duration_seconds IS NULL", [item.duration, trackId]);
      }
      if (item.page !== undefined && item.pos !== undefined) {
        const claims = await entryClaims(client, item.page, item.pos);
        await client.query(`UPDATE ingest.claims SET track_id=$1, album_id=NULL,
            status=CASE WHEN status IN ('conflict','superseded','candidate','rejected') AND field<>'track_number' THEN 'accepted'::ingest.claim_status ELSE status END, updated_at=now()
          WHERE id=ANY($2::bigint[])`, [trackId, claims]);
      }
    }
    const { rows: left } = await client.query("SELECT id FROM public.tracks WHERE album_id=$1 AND track_number>10000", [albumId]);
    if (left.length) throw new Error(`disco ${albumId}: quedaron pistas sin numerar`);
  }
}

if (process.argv.includes("--confirm")) {
  const { runId } = await withOperatorRun({ name: "curation:gap-albums-manual", operator: "claude-code", note: NOTE }, ({ client, runId }) => work(client, runId));
  console.log(`run ${runId}`);
} else {
  const client = await getPool().connect();
  try { await client.query("BEGIN"); await work(client, 0); console.log("ensayo correcto"); } finally { await client.query("ROLLBACK"); client.release(); }
}
await closeDb();
