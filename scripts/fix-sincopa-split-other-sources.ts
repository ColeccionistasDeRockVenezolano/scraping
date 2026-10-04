// Cuatro discos separados (2026-10-03) donde otra fuente dejó en el disco viejo
// el repertorio del disco separado: Hippito (dos entradas con el mismo
// «artista::título», también fusionadas) o MusicBrainz. El disco viejo conserva
// año, sello y descripción de su ficha de Sincopa; sus pistas eran de la otra.
// Brian (2026-10-03): mover al disco nuevo.
//
//  * Cada pista del disco viejo que también está en el disco nuevo y NO en la
//    ficha dueña se fusiona con su gemela del disco nuevo (sus claims la siguen).
//  * La entrada de la otra fuente (por número de catálogo, sello o lista de
//    pistas) pasa al disco nuevo.
//  * Los claims de Sincopa del disco viejo con el año, sello o catálogo del
//    disco separado quedan `superseded`; el sello del disco viejo vuelve al de su ficha.
//
//   tsx scripts/fix-sincopa-split-other-sources.ts [--confirm]
import { readFileSync } from "node:fs";
import { SincopaAdapter } from "../src/adapters/sincopa.js";
import { closeDb, getPool } from "../src/db/client.js";
import { mergeEquivalentCreditsOnParent } from "../src/merge/equivalent-relations.js";
import { updateEntity, withOperatorRun } from "../src/merge/operator.js";
import { mergeInto } from "../src/review/duplicates.js";

const DATA_DIR = process.env["CRV_RAW_DATA_DIR"] ?? "/home/brian/apps/Coleccionistas De Rock Venezolano/data";
// Hippito añade el título original: «Ya no volveré (Simone Simonette)», «La, La, La / La La La (If I Had You)».
const fold = (text: string) => text.replace(/\s*[(/].*$/u, "").normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase().replace(/[^\p{L}\d]+/gu, " ").trim();

interface Case {
  oldAlbum: number; newAlbum: number; owner: string;
  /** Claims de disco de otra fuente que pasan al disco nuevo. */
  move: { sourceId: number; rawPageId?: number };
  /** Valores del disco separado que no son del viejo. */
  separated: Record<string, string[]>;
  labels?: { old?: number; new?: number };
}
const HIPPITO = 4, MUSICBRAINZ = 0;
const CASES: Case[] = [
  { oldAlbum: 4125, newAlbum: 15674, owner: "germanfreytes1_6254.htm", move: { sourceId: HIPPITO, rawPageId: 359 },
    separated: { release_year: ["1969"], catalog_number: ["LP-6276", "LP 6276"] } },
  { oldAlbum: 4172, newAlbum: 15678, owner: "grupobota_1974.htm", move: { sourceId: HIPPITO, rawPageId: 357 },
    separated: { release_year: ["1975", "1976", "1977"], label: ["Polydor / Korta", "Velvet / Korta"] }, labels: { old: 2327 } },
  { oldAlbum: 4283, newAlbum: 15681, owner: "ivo_1ivo.htm", move: { sourceId: -1 },
    separated: { release_year: ["1978"], label: ["RCA-Cordica"] } },
  { oldAlbum: 8597, newAlbum: 15403, owner: "gual_ibarreto_01.htm", move: { sourceId: MUSICBRAINZ },
    separated: { release_year: ["1984"], label: ["Sonográfica"] }, labels: { old: 1978, new: 1458 } },
];

async function sourceId(slugLike: string): Promise<number> {
  const { rows: [row] } = await getPool().query<{ id: string }>("SELECT id::text FROM ingest.sources WHERE name ILIKE $1 LIMIT 1", [slugLike]);
  if (!row) throw new Error(`fuente ${slugLike} no encontrada`);
  return Number(row.id);
}

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const pool = getPool();
  const hippito = await sourceId("Hippito%");
  const musicbrainz = await sourceId("MusicBrainz%");
  const adapter = new SincopaAdapter();
  const plans: Array<Case & { merges: Array<{ drop: number; keep: number; title: string }>; claims: number[]; stale: number[] }> = [];
  for (const item of CASES) {
    const { rows: [page] } = await pool.query<{ url: string; stored_path: string }>("SELECT url, stored_path FROM ingest.raw_pages WHERE url LIKE $1 LIMIT 1", [`%/${item.owner}`]);
    const body = adapter.decodeBody(readFileSync(`${DATA_DIR}/${page!.stored_path}`));
    const ownerTitles = new Set(adapter.extractSnapshot({ body, url: page!.url } as never)
      .filter((record) => record.entityKind === "track").map((record) => fold(String(record.fields.find((field) => field.field === "title")?.value ?? ""))));
    const { rows: tracks } = await pool.query<{ id: string; album_id: string; title: string }>(
      "SELECT id::text, album_id::text, title FROM public.tracks WHERE album_id IN ($1, $2)", [item.oldAlbum, item.newAlbum]);
    const twins = new Map(tracks.filter((row) => Number(row.album_id) === item.newAlbum).map((row) => [fold(row.title), Number(row.id)]));
    const merges = tracks.filter((row) => Number(row.album_id) === item.oldAlbum && twins.has(fold(row.title)) && !ownerTitles.has(fold(row.title)))
      .map((row) => ({ drop: Number(row.id), keep: twins.get(fold(row.title))!, title: row.title }));
    const source = item.move.sourceId === HIPPITO ? hippito : item.move.sourceId === MUSICBRAINZ ? musicbrainz : -1;
    const { rows: moved } = source < 0 ? { rows: [] } : await pool.query<{ id: string }>(`
      SELECT id::text FROM ingest.claims WHERE album_id = $1 AND entity_kind = 'album' AND source_id = $2
         AND ($3::bigint IS NULL OR raw_page_id = $3) AND status IN ('accepted','conflict','candidate')`,
      [item.oldAlbum, source, item.move.rawPageId ?? null]);
    const stale: number[] = [];
    for (const [field, values] of Object.entries(item.separated)) {
      const { rows } = await pool.query<{ id: string }>(`
        SELECT id::text FROM ingest.claims WHERE album_id = $1 AND entity_kind = 'album' AND source_id = 7 AND field = $2
           AND status IN ('accepted','conflict') AND (raw_value #>> '{}') = ANY($3)`, [item.oldAlbum, field, values]);
      stale.push(...rows.map((row) => Number(row.id)));
    }
    plans.push({ ...item, merges, claims: moved.map((row) => Number(row.id)), stale });
  }
  for (const plan of plans) {
    console.log(`${plan.oldAlbum} → ${plan.newAlbum}: ${plan.merges.length} pistas (${plan.merges.map((merge) => merge.title).join(" | ")}); ${plan.claims.length} claims de otra fuente; ${plan.stale.length} claims de Sincopa a superseded${plan.labels ? `; sello ${JSON.stringify(plan.labels)}` : ""}`);
  }
  if (!confirm) { await closeDb(); return; }
  const note = "Sincopa: el disco viejo tenía el repertorio del disco separado que trajo otra fuente (Hippito/MusicBrainz); pasa al disco nuevo (Brian, 2026-10-03)";
  const result = await withOperatorRun({ name: "fix-sincopa-split-other-sources", operator: "brian", note, params: { cases: CASES.map((item) => [item.oldAlbum, item.newAlbum]) } }, async (context) => {
    const done = { merged: 0, claimsMoved: 0, superseded: 0, labels: 0 };
    for (const plan of plans) {
      for (const merge of plan.merges) {
        await mergeInto(context.client, "track", merge.keep, merge.drop, context.note, context.runId, { alias: false });
        await mergeEquivalentCreditsOnParent(context.client, { kind: "track", id: merge.keep }, context.note, context.runId);
        done.merged += 1;
      }
      if (plan.claims.length > 0) {
        const { rowCount } = await context.client.query(
          "UPDATE ingest.claims SET album_id = $2, notes = concat_ws(E'\\n', notes, $3::text), updated_at = now() WHERE id = ANY($1::bigint[])",
          [plan.claims, plan.newAlbum, `[run ${context.runId}] entrada del disco separado: pasa de ${plan.oldAlbum} a ${plan.newAlbum}`]);
        done.claimsMoved += rowCount ?? 0;
      }
      if (plan.stale.length > 0) {
        const { rowCount } = await context.client.query(
          "UPDATE ingest.claims SET status = 'superseded', notes = concat_ws(E'\\n', notes, $2::text), updated_at = now() WHERE id = ANY($1::bigint[])",
          [plan.stale, `[run ${context.runId}] valor del disco separado ${plan.newAlbum}, no de ${plan.oldAlbum}`]);
        done.superseded += rowCount ?? 0;
      }
      if (plan.labels?.old !== undefined) { await updateEntity(context, "album", plan.oldAlbum, { label_id: plan.labels.old }); done.labels += 1; }
      if (plan.labels?.new !== undefined) { await updateEntity(context, "album", plan.newAlbum, { label_id: plan.labels.new }); done.labels += 1; }
    }
    return done;
  });
  console.log(JSON.stringify(result));
  await closeDb();
}

await main();
