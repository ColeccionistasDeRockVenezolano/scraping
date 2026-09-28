// CRV · Género de artista en iTunes (Search API pública) para los artistas sin
// principal confirmado o con el que predijo Laya (una fuente lo reemplaza:
// regla de Brian del 2026-09-27). Escribe libros de evidencia que
// `apply-source-genres.ts` y `source-over-laya.ts` aplican. Nunca escribe en la base.
//
// Identidad: el artista de iTunes tiene el nombre exacto tras normalizar y
// además publica un disco del catálogo de ese artista (mismo título). Un disco
// homónimo no añade nada al nombre: vale solo con el año a ±1. Si dos artistas
// de iTunes con ese nombre pasan la prueba y dan géneros distintos, no se elige.
// Los artistas sin discos en el catálogo no se buscan: sin disco no hay segunda prueba.
// Homónimos dentro del catálogo tampoco.
//
// El género es el `primaryGenreName` del artista (tienda de EE. UU., nombres en
// inglés; si no está allí, la de Venezuela). «Latin», «World»… no son género.
// iTunes admite ~20 peticiones por minuto: una cada 3,5 s.
//
//   npx tsx scripts/harvest-itunes-artist-genres.ts [--ids=1,2]
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";
import { bareTitle, contact, getJson, norm, sleep, STORE_NOT_GENRE, yearOf } from "./lib/store-api.js";

const LEDGER = "reports/genre-laya-evidence-itunes-artists-2026-09-27.jsonl";
const REJECTED = "reports/genre-laya-evidence-itunes-artists-rejected-2026-09-27.jsonl";
const PAUSE = 3500;

interface Artist { id: number; name: string; albums: Array<{ title: string; year: number | null }> }
interface ItunesRow {
  wrapperType?: string; artistType?: string; artistId?: number; artistName?: string; artistLinkUrl?: string;
  primaryGenreName?: string; collectionName?: string; releaseDate?: string;
}
interface ItunesResults { results?: ItunesRow[] }
interface Candidate { artistId: number; url: string; genre: string; country: string; proof: string | null }

async function loadArtists(ids: number[]): Promise<Artist[]> {
  const client = await getPool().connect();
  try {
    const rows = await client.query<{ id: string; name: string; albums: Array<{ title: string; year: number | null }> }>(`
      SELECT ar.id::text, ar.name,
             json_agg(json_build_object('title', al.title, 'year', al.release_year) ORDER BY al.id) AS albums
        FROM public.artists ar JOIN public.albums al ON al.artist_id=ar.id
       WHERE ar.name !~* '^(various artists|varios artistas|v\\.?a\\.?)$'
         AND (ar.id = ANY($1::bigint[]) OR (cardinality($1::bigint[]) = 0 AND NOT EXISTS (
               SELECT 1 FROM ingest.artist_genres g WHERE g.artist_id=ar.id AND g.role='primary' AND g.status='confirmed'
                  AND g.decided_by<>'auto:laya')))
       GROUP BY ar.id, ar.name ORDER BY ar.id`, [ids]);
    const all = (await client.query<{ name: string }>(`SELECT name FROM public.artists`)).rows;
    const count = new Map<string, number>();
    for (const row of all) count.set(norm(row.name), (count.get(norm(row.name)) ?? 0) + 1);
    return rows.rows.filter((row) => norm(row.name) && count.get(norm(row.name)) === 1)
      .map((row) => ({ id: Number(row.id), name: row.name, albums: row.albums }));
  } finally {
    client.release();
  }
}

async function itunes(params: Record<string, string>, path = "search"): Promise<ItunesRow[]> {
  const url = new URL(`https://itunes.apple.com/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const payload = await getJson<ItunesResults>(url.toString());
  await sleep(PAUSE);
  return payload.results ?? [];
}

/** La segunda prueba: un disco del catálogo publicado por ese artista de iTunes. */
function albumProof(artist: Artist, collections: ItunesRow[]): string | null {
  for (const album of artist.albums) {
    const title = bareTitle(album.title);
    if (!title) continue;
    const hit = collections.find((row) => bareTitle(String(row.collectionName ?? "")) === title);
    if (!hit) continue;
    if (title !== norm(artist.name)) return `publica «${album.title}»`;
    const year = yearOf(hit.releaseDate);
    if (album.year && year && Math.abs(album.year - year) <= 1) return `publica el homónimo «${album.title}» (${year})`;
  }
  return null;
}

async function candidates(artist: Artist): Promise<Candidate[]> {
  for (const country of ["US", "VE"]) {
    const found = (await itunes({ term: artist.name, media: "music", entity: "musicArtist", country, limit: "25" }))
      .filter((row) => row.artistId && norm(String(row.artistName ?? "")) === norm(artist.name));
    if (!found.length) continue;
    const out: Candidate[] = [];
    for (const row of found.slice(0, 3)) {
      const collections = (await itunes({ id: String(row.artistId), entity: "album", limit: "200", country }, "lookup"))
        .filter((item) => item.wrapperType === "collection");
      out.push({ artistId: row.artistId!, url: String(row.artistLinkUrl ?? ""), genre: String(row.primaryGenreName ?? ""),
        country, proof: albumProof(artist, collections) });
    }
    return out;
  }
  return [];
}

async function main(): Promise<void> {
  if (!contact()) throw new Error("falta GENRES_EXTERNAL_CONTACT en .env");
  const ids = (process.argv.find((arg) => arg.startsWith("--ids="))?.slice(6) ?? "").split(",").filter(Boolean).map(Number);
  const artists = await loadArtists(ids);
  await closeDb();
  const done = new Set<string>();
  for (const path of [LEDGER, REJECTED]) if (existsSync(path))
    for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) done.add((JSON.parse(line) as { caseId: string }).caseId);
  const todo = artists.filter((artist) => !done.has(`artist:${artist.id}`));
  console.log(`${artists.length} artistas con discos y sin principal (o con el de Laya); ${todo.length} por buscar`);
  let accepted = 0;
  let refused = 0;
  for (const [index, artist] of todo.entries()) {
    const caseId = `artist:${artist.id}`;
    let found: Candidate[];
    try {
      found = await candidates(artist);
    } catch (error) {
      // Un fallo de red no se anota: la próxima pasada lo reintenta.
      console.warn(`${caseId}: ${(error as Error).message}`);
      await sleep(30_000);
      continue;
    }
    const proven = found.filter((item) => item.proof);
    const genres = [...new Set(proven.map((item) => item.genre).filter((genre) => genre && !STORE_NOT_GENRE.has(norm(genre))))];
    if (proven.length && genres.length === 1) {
      const best = proven.find((item) => item.genre === genres[0])!;
      appendFileSync(LEDGER, JSON.stringify({ caseId, kind: "artist", entityId: artist.id, source: "itunes", url: best.url,
        title: artist.name, rawGenres: genres, identity: `nombre exacto + ${best.proof} en iTunes (${best.country})` }) + "\n");
      accepted += 1;
    } else {
      const reason = !found.length ? "sin artista con el mismo nombre"
        : !proven.length ? "ningún disco del catálogo en su discografía"
          : genres.length > 1 ? "varios artistas con prueba y géneros distintos" : "identificado pero sin género utilizable";
      appendFileSync(REJECTED, JSON.stringify({ caseId, kind: "artist", entityId: artist.id, source: "itunes", title: artist.name, reason,
        candidates: found }) + "\n");
      refused += 1;
    }
    if ((index + 1) % 25 === 0) console.log(`[${index + 1}/${todo.length}] con género ${accepted}, sin él ${refused}`);
  }
  console.log(`itunes artistas: ${accepted} con género, ${refused} sin él (esta pasada) → ${LEDGER}`);
}

main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  await closeDb();
  process.exitCode = 1;
});
