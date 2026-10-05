// CRV · Curaduría 2026-10-05: orden de pistas reconstruido desde la ficha de Sincopa.
//
// Sincopa reinicia la numeración en cada cara de un LP (A1…A4, B1…) y repite títulos (versión
// remix, acústica, otra cara). La identidad artista::disco::título y el número «01» de la cara B
// hicieron que el motor fundiera ocurrencias distintas en una pista, colgara claims de una canción
// en otra y dejara discos con huecos y números cruzados.
//
// La verdad es el orden de la página: la i-ésima pista listada (posición de evidencia) es la pista i.
// Por disco con UNA ficha de Sincopa y sin pistas de otro origen:
//   - cada entrada de la página se asigna a su pista (la que ya tiene sus claims; si una pista reúne
//     varias entradas, se queda con la de su título y número; las otras van a pistas nuevas);
//   - los números pasan a ser el orden de la página (1…n);
//   - las entradas sin pista (claims huérfanos) crean su pista, con título y duración de la página.
// Los títulos ya curados no se tocan; solo se corrige la duración de una pista cuando la de su
// propia entrada dice otra cosa.
//
//   ./scripts/with-node22.sh npx tsx scripts/curaduria-2026-10-05-rebuild-sincopa-order.ts [--albums=1,2] [--confirm]
import { writeFileSync } from "node:fs";
import type { PoolClient } from "pg";
import { closeDb, getPool } from "../src/db/client.js";
import { withOperatorRun } from "../src/merge/operator.js";

const NOTE = "Curaduría 2026-10-05: orden de pistas según la ficha de Sincopa (reinicia la numeración por cara y repite títulos); cada ocurrencia en su pista";
const SINCOPA = 7;
const fold = (s: string): string => s.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase().replace(/[^\p{L}\d]+/gu, " ").trim();
const arg = (name: string): string | undefined => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);

const PRIMARY = process.argv.includes("--primary");
const AUTHORITATIVE = ["youtube-data-api", "yt-master-seed", "musicbrainz", "deezer", "discogs", "spotify", "itunes", "metal-archives", "crv-operador", "coleccionistas-de-rock-venezolano"];
const RETITLE = process.argv.includes("--retitle");
/** Entradas rechazadas que otra fuente confirma (p. ej. Deezer): «<disco>:<posición>». */
const CREATE_REJECTED = new Set((arg("create-rejected") ?? "").split(",").filter(Boolean));
/** Con --retitle, una pista que trae el título de otra edición/disco toma el de su ficha (si no es otra grafía del mismo). */
const retitles = (current: string, page: string): boolean => {
  if (!RETITLE) return false;
  const a = fold(current); const b = fold(page);
  return a !== b && !a.startsWith(b) && !b.startsWith(a);
};

interface Entry { position: number; title: string; albumTitle: string; duration: number | null; claims: number[]; trackIds: Set<number>; numbers: number[]; statuses: Set<string> }
interface Track { id: number; disc: number; number: number; title: string; duration: number | null }
interface Plan { albumId: number; title: string; status: string; detail?: string; changes: string[] }

async function pageEntries(client: PoolClient, pageId: number): Promise<Entry[]> {
  const { rows } = await client.query<{ position: number; id: string; field: string; value: string | null; track_id: string | null; identity_key: string; status: string }>(`
    SELECT e.position, c.id::text, c.field, c.status::text, COALESCE(c.normalized_value, c.raw_value) #>> '{}' AS value, c.track_id::text, c.identity_key
      FROM ingest.claims c JOIN ingest.claim_evidence e ON e.claim_id=c.id
     WHERE c.source_id=$1 AND c.raw_page_id=$2 AND c.entity_kind='track' AND e.position IS NOT NULL
     ORDER BY e.position, c.id`, [SINCOPA, pageId]);
  const byPos = new Map<number, Entry>();
  for (const row of rows) {
    const entry = byPos.get(row.position) ?? { position: row.position, title: "", albumTitle: "", duration: null, claims: [], trackIds: new Set<number>(), numbers: [], statuses: new Set<string>() };
    entry.claims.push(Number(row.id));
    if (row.track_id) entry.trackIds.add(Number(row.track_id));
    if (row.field === "title" && !entry.title) entry.title = row.value ?? "";
    if (row.field === "title") entry.statuses.add(row.status);
    if (row.field === "album_title" && !entry.albumTitle) entry.albumTitle = row.value ?? "";
    if (row.field === "duration_seconds" && row.value && /^\d+$/u.test(row.value)) entry.duration ??= Number(row.value);
    if (row.field === "track_number" && row.value && /^\d+$/u.test(row.value)) entry.numbers.push(Number(row.value));
    byPos.set(row.position, entry);
  }
  return [...byPos.values()].filter((entry) => entry.title).sort((a, b) => a.position - b.position);
}

async function planAlbum(client: PoolClient, albumId: number, apply: boolean): Promise<Plan> {
  const { rows: [album] } = await client.query<{ title: string }>("SELECT title FROM public.albums WHERE id=$1", [albumId]);
  const plan: Plan = { albumId, title: album?.title ?? "", status: "", changes: [] };
  const { rows: tracksRaw } = await client.query<{ id: string; disc_number: number; track_number: number; title: string; duration_seconds: number | null }>(
    "SELECT id::text, disc_number, track_number, title, duration_seconds FROM public.tracks WHERE album_id=$1 ORDER BY disc_number, track_number", [albumId]);
  const tracks: Track[] = tracksRaw.map((t) => ({ id: Number(t.id), disc: t.disc_number, number: t.track_number, title: t.title, duration: t.duration_seconds }));
  if (new Set(tracks.map((t) => t.disc)).size > 1) return { ...plan, status: "omitido", detail: "varios discos" };
  const { rows: pages } = await client.query<{ raw_page_id: string }>(`
    SELECT DISTINCT c.raw_page_id::text FROM ingest.claims c JOIN public.tracks t ON t.id=c.track_id
     WHERE t.album_id=$1 AND c.source_id=$2 AND c.raw_page_id IS NOT NULL`, [albumId, SINCOPA]);
  // Modo «ficha principal» (--primary): con varias fichas (ediciones), manda la de la edición del disco
  // (su release_year aceptado) o la indicada con --page=<disco>:<ficha>; lo demás va al final.
  const forced = (arg("page") ?? "").split(",").map((pair) => pair.split(":").map(Number)).find(([album]) => album === albumId)?.[1];
  let pageId: number | undefined = forced;
  if (!pageId && pages.length === 1) pageId = Number(pages[0]!.raw_page_id);
  if (!pageId && PRIMARY) {
    const { rows: own } = await client.query<{ raw_page_id: string }>(`
      SELECT DISTINCT raw_page_id::text FROM ingest.claims WHERE album_id=$1 AND source_id=$2 AND entity_kind='album' AND field='release_year' AND status='accepted'
         AND raw_page_id=ANY($3::bigint[])`, [albumId, SINCOPA, pages.map((page) => Number(page.raw_page_id))]);
    if (own.length === 1) pageId = Number(own[0]!.raw_page_id);
  }
  if (!pageId) return { ...plan, status: "omitido", detail: `${pages.length} fichas de Sincopa` };
  const all = await pageEntries(client, pageId);
  // La ficha puede traer otro disco (p. ej. «El Puma En Ritmo II Fiesta»): solo las entradas del título de este disco.
  const trackIdSet = new Set(tracks.map((t) => t.id));
  const albumTitles = new Map<string, number>();
  for (const entry of all) if ([...entry.trackIds].some((id) => trackIdSet.has(id))) albumTitles.set(fold(entry.albumTitle), (albumTitles.get(fold(entry.albumTitle)) ?? 0) + 1);
  const mainTitle = [...albumTitles.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  // Sin número propio = parte de un popurrí, no una pista.
  const entries = all.filter((entry) => fold(entry.albumTitle) === mainTitle && entry.numbers.length > 0);
  // Una entrada cuyos claims viven en otro disco no se toca: el disco entero queda fuera.
  const elsewhere = entries.filter((entry) => [...entry.trackIds].some((id) => !trackIdSet.has(id)));
  if (elsewhere.length) return { ...plan, status: "omitido", detail: `entradas en otro disco: ${elsewhere.map((e) => e.title).join(" | ")}` };
  if (!entries.length) return { ...plan, status: "omitido", detail: "sin entradas" };
  // Asignación entrada → pista.
  const assigned = new Map<number, Entry>(); // trackId → entry
  const entryTrack = new Map<Entry, number | null>();
  entries.forEach((entry, index) => {
    const k = index + 1;
    const mine = [...entry.trackIds].filter((id) => trackIdSet.has(id));
    // La pista que ya tiene los claims de la entrada; primero la del mismo título (otra grafía vale si es la única).
    // Una pista cuyo título es el de OTRA entrada de la ficha queda reservada para esa entrada.
    const holders = tracks.filter((t) => mine.includes(t.id) && !assigned.has(t.id)
      && (fold(t.title) === fold(entry.title) || !entries.some((other) => other !== entry && fold(other.title) === fold(t.title))));
    const titled = holders.filter((t) => fold(t.title) === fold(entry.title));
    const candidates = titled.length ? titled : holders.length === 1 ? holders : [];
    const pick = candidates.find((t) => t.number === k) ?? candidates[0];
    if (pick) { assigned.set(pick.id, entry); entryTrack.set(entry, pick.id); } else entryTrack.set(entry, null);
  });
  // Entradas sin pista propia: una pista del disco con su título que nadie tomó.
  for (const entry of entries) {
    if (entryTrack.get(entry) !== null) continue;
    const free = tracks.find((t) => !assigned.has(t.id) && fold(t.title) === fold(entry.title));
    if (free) { assigned.set(free.id, entry); entryTrack.set(entry, free.id); }
  }
  const foreign = tracks.filter((t) => !assigned.has(t.id));
  if (foreign.length && !PRIMARY) return { ...plan, status: "omitido", detail: `pistas fuera de la ficha: ${foreign.map((t) => `${t.number}:${t.title}`).join(" | ")}` };
  // Una entrada sin pista se crea si fue fundida en otra pista del disco o quedó «superseded» por la
  // fusión; las candidatas (recopilaciones en espera) y las rechazadas conservan su hueco.
  // (Un número «rejected» de una ocurrencia fundida no es un juicio sobre su existencia: es el lado que
  // perdió el conflicto de track_number contra la otra ocurrencia; no frena la separación.)
  const creatable = (entry: Entry): boolean => entry.trackIds.size > 0 || entry.statuses.has("superseded") || entry.statuses.has("accepted")
    || CREATE_REJECTED.has(`${albumId}:${entry.position}`);
  // Una fuente de autoridad (canal, hoja, MusicBrainz, Deezer, operador…) que numera distinto manda: el
  // disco queda fuera. Los blogs (rock-de-vzla, Hippito…) no frenan: copian la numeración por cara.
  const { rows: otherNumbers } = await client.query<{ track_id: string; value: string }>(`
    SELECT c.track_id::text, COALESCE(c.normalized_value, c.raw_value) #>> '{}' AS value FROM ingest.claims c JOIN ingest.sources s ON s.id=c.source_id
     WHERE c.track_id=ANY($1::bigint[]) AND c.field='track_number' AND c.source_id<>$2 AND c.status='accepted' AND s.slug=ANY($3::text[])`,
    [[...trackIdSet], SINCOPA, AUTHORITATIVE]);
  const target = new Map<number, number>();
  entries.forEach((entry, index) => { const id = entryTrack.get(entry); if (id !== null && id !== undefined) target.set(id, index + 1); });
  const disagree = otherNumbers.filter((row) => /^\d+$/u.test(row.value) && target.has(Number(row.track_id)) && Number(row.value) !== target.get(Number(row.track_id)));
  if (disagree.length) return { ...plan, status: "omitido", detail: `otra fuente numera distinto: ${disagree.length} pistas` };
  // Cambios.
  entries.forEach((entry, index) => {
    const k = index + 1;
    const trackId = entryTrack.get(entry)!;
    if (trackId === null) {
      if (creatable(entry)) plan.changes.push(`nueva ${k}: «${entry.title}»`);
      return;
    }
    const track = tracks.find((t) => t.id === trackId)!;
    if (track.number !== k) plan.changes.push(`${track.number} → ${k}: «${track.title}»`);
    if (retitles(track.title, entry.title)) plan.changes.push(`título ${k}: «${track.title}» → «${entry.title}»`);
  });
  foreign.forEach((track, index) => plan.changes.push(`al final ${entries.length + index + 1}: «${track.title}» (${track.number})`));
  if (!plan.changes.length) {
    // Aun sin cambios de número, claims de una entrada pueden colgar de otra pista.
    const stray = entries.some((entry) => { const id = entryTrack.get(entry); return id !== null && [...entry.trackIds].some((t) => t !== id); });
    if (!stray) return { ...plan, status: "sin_cambios" };
    plan.changes.push("claims recolocados");
  }
  plan.status = "cambia";
  if (!apply) return plan;
  const disc = tracks[0]?.disc ?? 1;
  await client.query("UPDATE public.tracks SET track_number=track_number+10000 WHERE album_id=$1", [albumId]);
  for (const [index, entry] of entries.entries()) {
    const k = index + 1;
    let trackId = entryTrack.get(entry)!;
    if (trackId === null && !creatable(entry)) continue;
    if (trackId === null) {
      const { rows: [created] } = await client.query<{ id: string }>(
        "INSERT INTO public.tracks(album_id, disc_number, track_number, title, duration_seconds) VALUES ($1,$2,$3,$4,$5) RETURNING id::text",
        [albumId, disc, k, entry.title, entry.duration]);
      trackId = Number(created!.id);
    } else {
      await client.query("UPDATE public.tracks SET track_number=$1 WHERE id=$2", [k, trackId]);
      const current = tracks.find((t) => t.id === trackId)!;
      if (retitles(current.title, entry.title)) await client.query("UPDATE public.tracks SET title=$1 WHERE id=$2", [entry.title, trackId]);
      // La duración de la entrada solo rellena, o corrige la que ninguna otra fuente respalda (el canal manda).
      if (entry.duration !== null) {
        await client.query(`UPDATE public.tracks SET duration_seconds=$1 WHERE id=$2 AND (duration_seconds IS NULL OR (abs(duration_seconds-$1)>2
          AND NOT EXISTS (SELECT 1 FROM ingest.claims c WHERE c.track_id=$2 AND c.field='duration_seconds' AND c.source_id<>$3 AND c.status='accepted')))`,
          [entry.duration, trackId, SINCOPA]);
      }
    }
    await client.query(`UPDATE ingest.claims SET track_id=$1, album_id=NULL,
        status=CASE WHEN status IN ('conflict','superseded','candidate') AND field<>'track_number' THEN 'accepted'::ingest.claim_status ELSE status END, updated_at=now()
      WHERE id=ANY($2::bigint[])`, [trackId, entry.claims]);
  }
  // Pistas de otras ediciones (solo en modo ficha principal): al final, en su orden.
  let next = entries.length;
  for (const track of foreign) { next += 1; await client.query("UPDATE public.tracks SET track_number=$1 WHERE id=$2", [next, track.id]); }
  const { rows: left } = await client.query<{ id: string; track_number: number }>("SELECT id::text, track_number FROM public.tracks WHERE album_id=$1 AND track_number>10000", [albumId]);
  if (left.length) throw new Error(`disco ${albumId}: quedaron pistas sin numerar ${left.map((r) => r.id).join(",")}`);
  return plan;
}

async function targets(client: PoolClient): Promise<number[]> {
  if (arg("albums")) return arg("albums")!.split(",").map(Number);
  const { rows } = await client.query<{ album_id: string }>(`
    SELECT DISTINCT t.album_id::text FROM public.tracks t JOIN ingest.claims c ON c.track_id=t.id
     WHERE c.source_id=$1 AND c.entity_kind='track' ORDER BY 1`, [SINCOPA]);
  return rows.map((row) => Number(row.album_id));
}

const confirm = process.argv.includes("--confirm");
const plans: Plan[] = [];
const run = async (client: PoolClient, apply: boolean): Promise<void> => {
  for (const albumId of await targets(client)) {
    await client.query("SAVEPOINT album");
    try { plans.push(await planAlbum(client, albumId, apply)); await client.query("RELEASE SAVEPOINT album"); }
    catch (error) { await client.query("ROLLBACK TO SAVEPOINT album"); plans.push({ albumId, title: "", status: "error", detail: String(error), changes: [] }); }
  }
};
if (confirm) {
  const { runId } = await withOperatorRun({ name: "curation:rebuild-sincopa-order", operator: "claude-code", note: NOTE }, ({ client }) => run(client, true));
  console.log(`run ${runId}`);
} else {
  const client = await getPool().connect();
  try { await client.query("BEGIN"); await run(client, true); } finally { await client.query("ROLLBACK"); client.release(); }
}
const counts: Record<string, number> = {};
for (const plan of plans) counts[plan.status] = (counts[plan.status] ?? 0) + 1;
console.log(counts);
writeFileSync(`reports/curaduria-2026-10-05/rebuild-sincopa-order-${confirm ? "confirm" : "dry-run"}.json`, JSON.stringify(plans.filter((p) => p.status !== "sin_cambios"), null, 1));
await closeDb();
