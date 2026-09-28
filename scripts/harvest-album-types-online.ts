// CRV · Tipo de disco en Deezer y MusicBrainz para los discos `other` que la
// hoja, el nombre y los posts no resolvieron (scripts/harvest-album-types.py).
//
// Deezer publica `record_type` (album, ep, single, compile) y MusicBrainz el
// tipo primario y los secundarios del grupo de lanzamientos (Album, EP, Single;
// Compilation, Live, Demo, Remix, Soundtrack). Identidad como en los géneros
// de tiendas (scripts/harvest-streaming-album-genres.ts): artista y título
// iguales tras normalizar, más año a ±1 o dos pistas en común; MusicBrainz, que
// no da pistas en la búsqueda, exige el año. Nunca escribe en la base: añade
// filas al libro que resuelve scripts/apply-album-types.ts, y se puede cortar y
// retomar (los discos ya vistos se saltan).
//
//   npx tsx scripts/harvest-album-types-online.ts [--only=deezer,musicbrainz] [--ids=1,2]
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";
import { bareTitle, contact, getJson, norm, sleep, yearOf } from "./lib/store-api.js";

const DATE = "2026-09-28";
const LEDGER = `reports/album-type-evidence-online-${DATE}.jsonl`;
const SEEN = `reports/album-type-evidence-online-seen-${DATE}.jsonl`;
const OFFLINE = `reports/album-type-evidence-${DATE}.jsonl`;

interface Album { id: number; artist: string; title: string; year: number | null; tracks: string[] }
interface Found { url: string; externalTitle: string; year: number | null; tracks: string[]; type: string | null; raw: string }

const argOf = (name: string): string | undefined =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

function sameRecord(album: Album, artistName: string, title: string): boolean {
  return norm(artistName) === norm(album.artist) && bareTitle(title) === bareTitle(album.title) && bareTitle(title) !== "";
}

/** La prueba independiente del nombre (la misma que en los géneros de tiendas). */
function proof(album: Album, found: Found, needYear: boolean): string | null {
  const ours = new Set(album.tracks.map(bareTitle).filter(Boolean));
  const shared = found.tracks.map(bareTitle).filter((title) => ours.has(title));
  if (ours.size >= 3 && found.tracks.length >= 3 && shared.length === 0) return null;
  if (!needYear && shared.length >= Math.min(2, ours.size || 2)) return `${shared.length} pistas en común`;
  if (bareTitle(album.title) === norm(album.artist) && !shared.length) return null;
  if (album.year && found.year && Math.abs(album.year - found.year) <= 1) return `año ${found.year}`;
  return null;
}

const DEEZER: Record<string, string> = { album: "album", ep: "ep", single: "single", compile: "compilation" };

async function deezer(album: Album): Promise<Found[]> {
  const out: Found[] = [];
  const seen = new Set<number>();
  for (const query of [`artist:"${album.artist}" album:"${album.title}"`, `${album.artist} ${album.title}`]) {
    const search = await getJson<{ data?: Array<{ id: number; title?: string; artist?: { name?: string } }> }>(
      `https://api.deezer.com/search/album?q=${encodeURIComponent(query)}`, { headers: { "Accept-Language": "en" } });
    for (const hit of search.data ?? []) {
      if (seen.has(hit.id) || !sameRecord(album, String(hit.artist?.name ?? ""), String(hit.title ?? ""))) continue;
      seen.add(hit.id);
      const full = await getJson<{ link?: string; title?: string; release_date?: string; record_type?: string; tracks?: { data?: Array<{ title?: string }> } }>(
        `https://api.deezer.com/album/${hit.id}`, { headers: { "Accept-Language": "en" } });
      out.push({ url: String(full.link ?? `https://www.deezer.com/album/${hit.id}`), externalTitle: String(full.title),
        year: yearOf(full.release_date), tracks: (full.tracks?.data ?? []).map((track) => String(track.title ?? "")),
        type: DEEZER[String(full.record_type)] ?? null, raw: String(full.record_type) });
      await sleep(250);
    }
    if (out.length) break;
    await sleep(250);
  }
  return out;
}

interface MbGroup { id: string; title?: string; "primary-type"?: string; "secondary-types"?: string[]; "first-release-date"?: string;
  "artist-credit"?: Array<{ name?: string; artist?: { name?: string } }> }

function mbType(group: MbGroup): string | null {
  const secondary = new Set((group["secondary-types"] ?? []).map((value) => value.toLowerCase()));
  // Una sola marca secundaria; si son varias (p. ej. «Compilation, Live») no se decide.
  const specific = [["compilation", "compilation"], ["live", "live_album"], ["demo", "demo"], ["remix", "remix"], ["soundtrack", "soundtrack"]]
    .filter(([key]) => secondary.has(key!)).map(([, value]) => value!);
  if (specific.length > 1) return null;
  if (specific.length === 1) return specific[0]!;
  if ([...secondary].some((value) => !["compilation", "live", "demo", "remix", "soundtrack"].includes(value))) return null;
  return { Album: "album", EP: "ep", Single: "single" }[String(group["primary-type"])] ?? null;
}

async function musicbrainz(album: Album): Promise<Found[]> {
  const escape = (value: string) => value.replace(/([+\-&|!(){}[\]^"~*?:\\/])/gu, "\\$1");
  const query = `releasegroup:"${escape(album.title)}" AND artist:"${escape(album.artist)}"`;
  const data = await getJson<{ "release-groups"?: MbGroup[] }>(
    `https://musicbrainz.org/ws/2/release-group/?fmt=json&limit=10&query=${encodeURIComponent(query)}`);
  await sleep(1100);
  return (data["release-groups"] ?? [])
    .filter((group) => sameRecord(album, String(group["artist-credit"]?.map((credit) => credit.name ?? credit.artist?.name ?? "").join(" ") ?? ""), String(group.title ?? "")))
    .map((group) => ({ url: `https://musicbrainz.org/release-group/${group.id}`, externalTitle: String(group.title),
      year: yearOf(group["first-release-date"]), tracks: [], type: mbType(group),
      raw: [group["primary-type"], ...(group["secondary-types"] ?? [])].filter(Boolean).join(" + ") }));
}

const SOURCES: Record<string, { run: (album: Album) => Promise<Found[]>; needYear: boolean }> = {
  deezer: { run: deezer, needYear: false },
  musicbrainz: { run: musicbrainz, needYear: true },
};

/** Discos `other` sin tipo concreto en el libro sin red (solo «album» genérico o nada). */
async function loadAlbums(ids: number[]): Promise<Album[]> {
  const resolved = new Set<number>();
  if (existsSync(OFFLINE)) {
    for (const line of readFileSync(OFFLINE, "utf8").split("\n").filter(Boolean)) {
      const row = JSON.parse(line) as { albumId: number; type: string; via: string };
      if (row.type !== "album" || row.via === "hoja") resolved.add(row.albumId);
    }
  }
  const rows = await getPool().query<{ id: string; artist: string; title: string; year: number | null; tracks: string[] | null; classes: string[] | null }>(`
    SELECT a.id::text, ar.name AS artist, a.title, a.release_year AS year,
           (SELECT array_agg(t.title ORDER BY t.disc_number, t.track_number) FROM public.tracks t WHERE t.album_id = a.id) AS tracks,
           (SELECT array_agg(x.classification) FROM ingest.album_classifications x WHERE x.album_id = a.id) AS classes
      FROM public.albums a JOIN public.artists ar ON ar.id = a.artist_id
     WHERE a.album_type = 'other' AND (cardinality($1::bigint[]) = 0 OR a.id = ANY($1::bigint[]))
       AND ar.name !~* '^(various artists|varios artistas|varios|v\\.?a\\.?)$'
     ORDER BY a.id`, [ids]);
  return rows.rows
    .filter((row) => !(row.classes ?? []).some((label) => ["Music Video", "Live Concert", "Documentary", "B-Sides"].includes(label)))
    .filter((row) => ids.length || !resolved.has(Number(row.id)))
    .map((row) => ({ id: Number(row.id), artist: row.artist, title: row.title, year: row.year, tracks: row.tracks ?? [] }));
}

async function harvest(source: string, albums: Album[]): Promise<void> {
  const done = new Set<string>();
  if (existsSync(SEEN)) for (const line of readFileSync(SEEN, "utf8").split("\n").filter(Boolean)) done.add(line.trim());
  let found = 0;
  let index = 0;
  for (const album of albums) {
    index += 1;
    const key = `${source}|${album.id}`;
    if (done.has(JSON.stringify(key))) continue;
    let hits: Found[];
    try {
      hits = await SOURCES[source]!.run(album);
    } catch (error) {
      // Un fallo de red no se anota: la próxima pasada lo reintenta.
      console.warn(`${source} album:${album.id}: ${(error as Error).message}`);
      await sleep(5000);
      continue;
    }
    const judged = hits.map((hit) => ({ hit, proof: proof(album, hit, SOURCES[source]!.needYear) })).filter((item) => item.proof && item.hit.type);
    const types = new Set(judged.map((item) => item.hit.type));
    // Dos fichas identificadas que dicen tipos distintos (una reedición recopilatoria) no deciden nada.
    if (types.size === 1) {
      const best = judged[0]!;
      appendFileSync(LEDGER, JSON.stringify({ albumId: album.id, artist: album.artist, title: album.title, source, via: source,
        type: best.hit.type, raw: `${best.hit.raw} · ${best.hit.externalTitle} (${best.proof})`, url: best.hit.url }) + "\n");
      found += 1;
    }
    appendFileSync(SEEN, JSON.stringify(key) + "\n");
    if (index % 100 === 0) console.log(`${source}: ${index}/${albums.length} · ${found} con tipo`);
  }
  console.log(`${source}: terminado · ${found} con tipo → ${LEDGER}`);
}

async function main(): Promise<void> {
  if (!contact()) throw new Error("falta GENRES_EXTERNAL_CONTACT en .env");
  const only = (argOf("only") ?? Object.keys(SOURCES).join(",")).split(",");
  const ids = (argOf("ids") ?? "").split(",").filter(Boolean).map(Number);
  const albums = await loadAlbums(ids);
  await closeDb();
  console.log(`${albums.length} discos sin tipo concreto`);
  await Promise.all(only.map((source) => harvest(source, albums)));
}

main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  await closeDb();
  process.exitCode = 1;
});
