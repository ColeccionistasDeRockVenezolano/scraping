// CRV · Duración de las pistas que no la tienen, desde Deezer e iTunes.
//
// Por disco con alguna pista sin duración busca el mismo disco en la tienda con
// la identidad de los cosechadores de género (artista y título iguales tras
// normalizar) y exige además pistas en común: dos, o una si el disco tiene una
// sola. El año solo NO basta aquí, porque la duración se copia pista por pista.
// Cada pista se empareja por título normalizado y solo si el título es único a
// ambos lados; nunca por posición. Escribe un libro de evidencia y nunca toca la
// base (lo aplica scripts/apply-track-durations.ts).
//
// Se reanuda sola: los discos ya consultados quedan en el libro `seen`.
//
//   npx tsx scripts/harvest-track-durations.ts [--only=deezer,itunes] [--ids=1,2] [--limit=N]
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";
import { bareTitle, getJson, norm, sleep } from "./lib/store-api.js";

const DATE = "2026-09-28";
const LEDGER = `reports/track-durations-evidence-${DATE}.jsonl`;
const SEEN = `reports/track-durations-seen-${DATE}.jsonl`;

interface Track { id: number; title: string; duration: number | null }
interface Album { id: number; artist: string; title: string; tracks: Track[] }
interface External { source: string; url: string; externalTitle: string; tracks: Array<{ title: string; seconds: number }> }

const argOf = (name: string): string | undefined =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

interface DeezerSearch { data?: Array<{ id: number; title?: string; artist?: { name?: string } }> }
interface DeezerAlbum { link?: string; title?: string; tracks?: { data?: Array<{ title?: string; duration?: number }> } }
interface ItunesRow { wrapperType?: string; artistName?: string; collectionName?: string; collectionViewUrl?: string; collectionId?: number; trackName?: string; trackTimeMillis?: number }
interface ItunesResults { results?: ItunesRow[] }

const sameRecord = (album: Album, artist: string, title: string) =>
  norm(artist) === norm(album.artist) && bareTitle(title) === bareTitle(album.title) && bareTitle(title) !== "";

async function deezer(album: Album): Promise<External[]> {
  const out: External[] = [];
  const seen = new Set<number>();
  for (const query of [`artist:"${album.artist}" album:"${album.title}"`, `${album.artist} ${album.title}`]) {
    const search = await getJson<DeezerSearch>(`https://api.deezer.com/search/album?q=${encodeURIComponent(query)}`, { headers: { "Accept-Language": "en" } });
    for (const hit of search.data ?? []) {
      if (seen.has(hit.id) || !sameRecord(album, String(hit.artist?.name ?? ""), String(hit.title ?? ""))) continue;
      seen.add(hit.id);
      const full = await getJson<DeezerAlbum>(`https://api.deezer.com/album/${hit.id}`, { headers: { "Accept-Language": "en" } });
      out.push({ source: "deezer", url: String(full.link ?? `https://www.deezer.com/album/${hit.id}`), externalTitle: String(full.title),
        tracks: (full.tracks?.data ?? []).map((t) => ({ title: String(t.title ?? ""), seconds: Number(t.duration ?? 0) })) });
      await sleep(250);
    }
    if (out.length) break;
    await sleep(250);
  }
  return out;
}

async function itunes(album: Album): Promise<External[]> {
  const out: External[] = [];
  for (const country of ["US", "VE"]) {
    const url = new URL("https://itunes.apple.com/search");
    for (const [key, value] of Object.entries({ term: `${album.artist} ${album.title}`, media: "music", entity: "album", country, limit: "50" }))
      url.searchParams.set(key, value);
    const search = await getJson<ItunesResults>(url.toString());
    for (const hit of search.results ?? []) {
      if (!sameRecord(album, String(hit.artistName ?? ""), String(hit.collectionName ?? ""))) continue;
      await sleep(3500);
      const lookup = await getJson<ItunesResults>(`https://itunes.apple.com/lookup?id=${hit.collectionId}&entity=song&country=${country}`);
      out.push({ source: "itunes", url: String(hit.collectionViewUrl), externalTitle: String(hit.collectionName),
        tracks: (lookup.results ?? []).filter((r) => r.wrapperType === "track")
          .map((r) => ({ title: String(r.trackName ?? ""), seconds: Math.round(Number(r.trackTimeMillis ?? 0) / 1000) })) });
    }
    await sleep(3500);
    if (out.length) break;
  }
  return out;
}

const SOURCES: Record<string, (album: Album) => Promise<External[]>> = { deezer, itunes };

/** Títulos que aparecen una sola vez en la lista (tras normalizar). */
function uniqueTitles<T>(items: T[], title: (item: T) => string): Map<string, T> {
  const count = new Map<string, number>();
  for (const item of items) count.set(bareTitle(title(item)), (count.get(bareTitle(title(item))) ?? 0) + 1);
  const out = new Map<string, T>();
  for (const item of items) {
    const key = bareTitle(title(item));
    if (key && count.get(key) === 1) out.set(key, item);
  }
  return out;
}

function match(album: Album, ext: External) {
  const ours = uniqueTitles(album.tracks, (t) => t.title);
  const theirs = uniqueTitles(ext.tracks.filter((t) => t.seconds > 0), (t) => t.title);
  const shared = [...ours.keys()].filter((key) => theirs.has(key));
  const needed = Math.min(2, album.tracks.length);
  if (shared.length < needed) return { ok: false as const, shared: shared.length };
  const fills = shared.map((key) => ({ track: ours.get(key)!, ext: theirs.get(key)! })).filter(({ track }) => track.duration === null);
  return { ok: true as const, shared: shared.length, fills };
}

async function loadAlbums(ids: number[]): Promise<Album[]> {
  const rows = await getPool().query<{ id: string; artist: string; title: string; tracks: Track[] }>(`
    SELECT a.id::text, ar.name AS artist, a.title,
           json_agg(json_build_object('id', t.id, 'title', t.title, 'duration', t.duration_seconds) ORDER BY t.disc_number, t.track_number) AS tracks
      FROM public.albums a JOIN public.artists ar ON ar.id=a.artist_id JOIN public.tracks t ON t.album_id=a.id
     WHERE ar.name !~* '^(various artists|varios artistas|v\\.?a\\.?)$'
       AND (cardinality($1::bigint[]) = 0 OR a.id = ANY($1::bigint[]))
     GROUP BY a.id, ar.name, a.title
    HAVING bool_or(t.duration_seconds IS NULL)
     ORDER BY a.id`, [ids]);
  return rows.rows.map((r) => ({ id: Number(r.id), artist: r.artist, title: r.title, tracks: r.tracks }));
}

async function main(): Promise<void> {
  const only = (argOf("only") ?? "deezer,itunes").split(",");
  const ids = (argOf("ids") ?? "").split(",").filter(Boolean).map(Number);
  const limit = Number(argOf("limit") ?? "0");
  const seen = new Set(existsSync(SEEN) ? readFileSync(SEEN, "utf8").split("\n").filter(Boolean).map((l) => { const s = JSON.parse(l) as { albumId: number; source: string }; return `${s.source}:${s.albumId}`; }) : []);
  const done = new Set(existsSync(LEDGER) ? readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { albumId: number }).albumId) : []);
  let albums = await loadAlbums(ids);
  if (limit) albums = albums.slice(0, limit);
  console.log(`${albums.length} discos con pistas sin duración`);
  const totals = { matched: 0, fills: 0, noMatch: 0, errors: 0 };
  for (const [index, album] of albums.entries()) {
    if (done.has(album.id)) continue;
    for (const source of only) {
      if (seen.has(`${source}:${album.id}`)) continue;
      let status = "sin_ficha";
      let detail = "";
      try {
        const found = await SOURCES[source]!(album);
        const verdicts = found.map((ext) => ({ ext, m: match(album, ext) }));
        const best = verdicts.filter((v) => v.m.ok).sort((a, b) => b.m.shared - a.m.shared)[0];
        if (best && best.m.ok) {
          status = "ok";
          detail = `${best.m.shared} pistas en común`;
          for (const { track, ext } of best.m.fills) {
            appendFileSync(LEDGER, JSON.stringify({ albumId: album.id, artist: album.artist, album: album.title, trackId: track.id, title: track.title,
              seconds: ext.seconds, source, url: best.ext.url, externalAlbum: best.ext.externalTitle, externalTitle: ext.title, shared: best.m.shared }) + "\n");
            totals.fills += 1;
          }
          totals.matched += 1;
        } else if (found.length) {
          status = "sin_identidad";
          detail = verdicts.map((v) => `${v.ext.url}: ${v.m.shared} en común`).join("; ");
          totals.noMatch += 1;
        }
      } catch (error) {
        status = "error";
        detail = String((error as Error).message).slice(0, 200);
        totals.errors += 1;
        await sleep(5000);
      }
      appendFileSync(SEEN, JSON.stringify({ albumId: album.id, source, status, detail }) + "\n");
      if (status === "ok") break;
    }
    if (index % 25 === 0) console.log(`${index + 1}/${albums.length}`, JSON.stringify(totals));
  }
  console.log("fin", JSON.stringify(totals));
  await closeDb();
}

main().catch(async (error: unknown) => { console.error(error); await closeDb(); process.exit(1); });
