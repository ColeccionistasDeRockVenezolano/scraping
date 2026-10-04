// Discos de Billo's cuyo «Mosaico Nº N» (pista madre en color pálido) el adapter
// 1.3.0 no leía: sin él, las pistas siguientes quedaron una posición antes. El
// adapter 1.3.1 lo lee y Sincopa (la ficha del LP original y fuente de casi
// todas esas pistas) manda en el orden (Brian, 2026-10-03). Una pista que otra
// fuente numera distinto lo conserva en sus notas («Deezer la numera N»); las
// que la ficha no trae van al final. Un disco del canal no se toca.
//
//   tsx scripts/renumber-sincopa-medley-albums.ts <url…> [--confirm --note="…"]
import { readFileSync } from "node:fs";
import { SincopaAdapter } from "../src/adapters/sincopa.js";
import { closeDb, getPool } from "../src/db/client.js";
import { updateEntity, withOperatorRun } from "../src/merge/operator.js";

const fold = (text: string) => text.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase().replace(/[^\p{L}\d]+/gu, " ").trim();
const arg = (name: string) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const DATA_DIR = process.env["CRV_RAW_DATA_DIR"] ?? "/home/brian/apps/Coleccionistas De Rock Venezolano/data";
const CHANNEL_SOURCES = [12, 14];

interface Move { trackId: number; title: string; from: number; to: number; note?: string }

async function main(): Promise<void> {
  const urls = process.argv.slice(2).filter((item) => !item.startsWith("--"));
  const confirm = process.argv.includes("--confirm");
  const note = arg("note") ?? "Sincopa: orden del LP con la pista «Mosaico» que el adapter 1.3.0 no leía (Brian: Sincopa manda en el orden)";
  const pool = getPool();
  const adapter = new SincopaAdapter();
  const plans: Array<{ url: string; albumId: number; moves: Move[] }> = [];
  for (const url of urls) {
    const { rows: [page] } = await pool.query<{ id: string; stored_path: string; album_id: string | null }>(`
      SELECT p.id::text, p.stored_path,
             (SELECT max(c.album_id)::text FROM ingest.claims c WHERE c.raw_page_id = p.id AND c.entity_kind = 'album' AND c.status = 'accepted') AS album_id
        FROM ingest.raw_pages p WHERE p.url = $1`, [url]);
    if (page?.album_id == null) { console.error("sin disco en el core", url); continue; }
    const albumId = Number(page.album_id);
    const { rows: [channel] } = await pool.query<{ hit: boolean }>(`
      SELECT EXISTS (SELECT 1 FROM ingest.claims c JOIN public.tracks t ON t.id = c.track_id WHERE t.album_id = $1 AND c.source_id = ANY($2) AND c.status = 'accepted')
          OR EXISTS (SELECT 1 FROM ingest.claims WHERE album_id = $1 AND source_id = ANY($2) AND status = 'accepted') AS hit`, [albumId, CHANNEL_SOURCES]);
    if (channel?.hit) { console.error("disco del canal: no se toca", url); continue; }
    const body = adapter.decodeBody(readFileSync(`${DATA_DIR}/${page.stored_path}`));
    const order = new Map<string, number>();
    const numbered = adapter.extractSnapshot({ body, url } as never).flatMap((record) => {
      const number = record.fields.find((field) => field.field === "track_number")?.value;
      const title = record.fields.find((field) => field.field === "title")?.value;
      return record.entityKind === "track" && number != null && title != null ? [{ title: fold(String(title)), number: Number(number) }] : [];
    });
    const printed = new Set(numbered.map((item) => item.number));
    for (const item of numbered) {
      if (order.has(item.title)) continue;
      // Errata de la ficha: «03» dos veces y ningún «04» (Mayra Martí 1984): la segunda es la siguiente.
      const taken = [...order.values()].includes(item.number);
      order.set(item.title, taken && !printed.has(item.number + 1) ? item.number + 1 : item.number);
    }
    const { rows: tracks } = await pool.query<{ id: string; title: string; track_number: number; others: string | null }>(`
      SELECT t.id::text, t.title, t.track_number,
             (SELECT string_agg(DISTINCT s.name || ' la numera ' || (c.raw_value #>> '{}')::int, '; ')
                FROM ingest.claims c JOIN ingest.sources s ON s.id = c.source_id
               WHERE c.track_id = t.id AND c.field = 'track_number' AND c.status = 'accepted' AND c.source_id NOT IN (7, 49)) AS others
        FROM public.tracks t WHERE t.album_id = $1 ORDER BY t.track_number`, [albumId]);
    const last = Math.max(0, ...order.values());
    let extra = last;
    const moves: Move[] = [];
    for (const track of tracks) {
      const to = order.get(fold(track.title)) ?? (extra += 1);
      if (to === track.track_number) continue;
      moves.push({ trackId: Number(track.id), title: track.title, from: track.track_number, to, ...(track.others ? { note: `${track.others} (Sincopa: ${to}).` } : {}) });
    }
    const targets = moves.map((move) => move.to);
    if (new Set(targets).size !== targets.length) { console.error("dos pistas al mismo número: se deja", url); continue; }
    plans.push({ url, albumId, moves });
  }
  for (const plan of plans) {
    console.log(plan.albumId, plan.url.split("/").pop());
    for (const move of plan.moves) console.log(`   ${move.from} → ${move.to}  ${move.title}${move.note ? `  [nota: ${move.note}]` : ""}`);
  }
  if (confirm) {
    const result = await withOperatorRun({ name: "renumber-sincopa-medley-albums", operator: "brian", note, params: { urls } }, async (context) => {
      let moved = 0;
      for (const plan of plans) {
        // Primero a posiciones libres (100+) y luego a la definitiva: así no chocan entre ellas.
        for (const move of plan.moves) await updateEntity(context, "track", move.trackId, { track_number: 100 + move.to });
        for (const move of plan.moves) {
          const { rows: [current] } = await context.client.query<{ notes: string | null }>("SELECT notes FROM public.tracks WHERE id = $1", [move.trackId]);
          const notes = move.note === undefined || current?.notes?.includes(move.note) ? undefined : current?.notes ? `${current.notes}\n${move.note}` : move.note;
          await updateEntity(context, "track", move.trackId, { track_number: move.to, ...(notes === undefined ? {} : { notes }) });
          moved += 1;
        }
      }
      return { moved };
    });
    console.log(result);
  }
  await closeDb();
}

await main();
