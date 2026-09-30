// Busca fotos de artista en Deezer para fichas sin picture_url. Solo emite un
// candidato si el nombre coincide de forma exacta y ÚNICA en Deezer Y el
// perfil comparte al menos un disco con el catálogo (título distintivo, o
// título genérico con año compatible): así una banda homónima de otro país no
// entra. Lo que no pasa la guarda queda en un ledger de dudosos; los nombres
// ambiguos dentro de Deezer se descartan.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import pg from "pg";
import { normalizeEntityName } from "../src/normalization/entity-name.js";

loadDotenv();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface CatalogAlbum { title: string; year: number | null; }
interface Artist { id: number; name: string; albums: CatalogAlbum[]; }
interface DzArtist { id?: number; name?: string; picture_xl?: string; picture_big?: string; }
interface DzAlbum { title?: string; release_date?: string; cover_xl?: string; cover_big?: string; }
interface Candidate { kind: "artist"; id: number; sourceUrl: string; label: string; source: "deezer-artist"; deezerId: number; sharedAlbums: string[]; }
interface Doubt { id: number; name: string; deezerId?: number | undefined; reason: string; shared?: string[] | undefined; }

function arg(name: string): string | undefined { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; }
function numberArg(name: string, fallback: number): number { const raw = arg(name); if (raw === undefined) return fallback; const n = Number(raw); if (!Number.isInteger(n) || n < 1) throw new Error(`${name} debe ser entero positivo`); return n; }
function key(value: string): string { return normalizeEntityName(value).secondaryKey; }
async function pause(ms: number): Promise<void> { await new Promise((resolve) => setTimeout(resolve, ms)); }

const GENERIC = new Set([
  "demos", "demo", "demos nuestra", "ep", "single", "sencillo", "ineditas", "inéditas",
  "b-sides", "bsides", "b-sides", "acustico", "unplugged", "en vivo", "en directo", "live",
  "recopilatorio", "compilacion", "compilation", "greatest hits", "exitos", "lo mejor",
  "vol 1", "vol 2", "vol 3", "vol 4", "volumen 1", "volumen 2", "disco 1", "side a",
]);
function isGeneric(title: string): boolean { const k = key(title); return GENERIC.has(k) || /^demos?($| )/u.test(k); }

async function artists(pool: pg.Pool, limit: number | undefined): Promise<Artist[]> {
  const { rows } = await pool.query<{ id: string; name: string; albums: CatalogAlbum[] }>(`
    SELECT ar.id::text, ar.name, jsonb_agg(jsonb_build_object('title', al.title, 'year', al.release_year)) AS albums
      FROM public.artists ar JOIN public.albums al ON al.artist_id = ar.id
     WHERE ar.picture_url IS NULL OR btrim(ar.picture_url) = ''
     GROUP BY ar.id, ar.name ORDER BY ar.id`);
  const result = rows.map((row) => ({ id: Number(row.id), name: row.name, albums: row.albums }));
  return limit === undefined ? result : result.slice(0, limit);
}
async function searchArtist(name: string): Promise<DzArtist[]> {
  const url = new URL("https://api.deezer.com/search/artist");
  url.search = new URLSearchParams({ q: name, limit: "15" }).toString();
  const response = await fetch(url, { headers: { "user-agent": "CRV-local-media/1.0 (+coleccionistasderockvenezolano.com)" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Deezer HTTP ${response.status}`);
  return ((await response.json()) as { data?: DzArtist[] }).data ?? [];
}
async function artistAlbums(id: number): Promise<DzAlbum[]> {
  const url = new URL(`https://api.deezer.com/artist/${id}/albums`);
  url.search = new URLSearchParams({ limit: "100" }).toString();
  const response = await fetch(url, { headers: { "user-agent": "CRV-local-media/1.0 (+coleccionistasderockvenezolano.com)" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Deezer HTTP ${response.status}`);
  return ((await response.json()) as { data?: DzAlbum[] }).data ?? [];
}
function sharedAlbums(artist: Artist, discography: DzAlbum[]): { strong: string[]; weak: string[] } {
  const strong: string[] = []; const weak: string[] = [];
  for (const ours of artist.albums) {
    for (const theirs of discography) {
      if (!theirs.title || key(theirs.title) !== key(ours.title)) continue;
      const dzYear = theirs.release_date ? Number(theirs.release_date.slice(0, 4)) : null;
      const yearsCompatible = ours.year === null || dzYear === null || Math.abs(ours.year - dzYear) <= 1;
      const generic = isGeneric(ours.title);
      if (!generic && yearsCompatible) strong.push(ours.title);
      else if (generic && ours.year !== null && dzYear !== null && Math.abs(ours.year - dzYear) <= 1) strong.push(ours.title);
      else weak.push(ours.title);
    }
  }
  return { strong, weak };
}

function pictureOf(row: DzArtist): string | undefined {
  for (const value of [row.picture_xl, row.picture_big]) {
    if (value && /^https?:\/\//u.test(value) && !value.includes("/artist//")) return value;
  }
  return undefined;
}

// Deezer identifica las imágenes por hash de contenido en la ruta de la CDN;
// cuando reutiliza una portada como «foto» del artista el hash es el mismo.
function hashOfImage(url: string | undefined): string | undefined {
  const match = /\/images\/(?:artist|cover)\/([0-9a-f]{16,})/u.exec(url ?? "");
  return match?.[1];
}

async function main(): Promise<void> {
  const limitRaw = arg("--limit"); const limit = limitRaw === undefined ? undefined : numberArg("--limit", 1);
  const delay = numberArg("--delay-ms", 200);
  const pool = new pg.Pool({ connectionString: process.env["DATABASE_URL"] });
  try {
    const pending = await artists(pool, limit);
    const candidates: Candidate[] = []; const doubts: Doubt[] = []; let ambiguous = 0; let noMatch = 0; let failures = 0; let artworkSkips = 0;
    for (let index = 0; index < pending.length; index += 1) {
      const artist = pending[index]!;
      try {
        const found = await searchArtist(artist.name);
        const matches = found.filter((row) => row.name && Number.isInteger(row.id) && key(row.name) === key(artist.name) && pictureOf(row) !== undefined);
        if (matches.length === 0) { noMatch += 1; }
        else if (matches.length > 1) { ambiguous += 1; doubts.push({ id: artist.id, name: artist.name, reason: `${matches.length} homónimos exactos en Deezer` }); }
        else {
          const dz = matches[0]!;
          const discography = await artistAlbums(dz.id!);
          const picture = pictureOf(dz)!;
          const pictureHash = hashOfImage(picture);
          if (pictureHash && discography.some((row) => hashOfImage(row.cover_xl ?? row.cover_big) === pictureHash)) {
            // La «foto» es el artwork de uno de sus discos: no se emite.
            artworkSkips += 1;
          } else {
            const { strong, weak } = sharedAlbums(artist, discography);
            if (strong.length > 0) {
              candidates.push({ kind: "artist", id: artist.id, sourceUrl: picture, label: artist.name, source: "deezer-artist", deezerId: dz.id!, sharedAlbums: strong });
            } else if (weak.length > 0) {
              doubts.push({ id: artist.id, name: artist.name, deezerId: dz.id, reason: "solo discos genéricos o años dispares", shared: weak });
            } else {
              doubts.push({ id: artist.id, name: artist.name, deezerId: dz.id, reason: "sin discos en común" });
            }
          }
        }
      } catch (error) { failures += 1; process.stderr.write(`artist ${artist.id}: ${(error as Error).message}\n`); }
      if ((index + 1) % 50 === 0 || index + 1 === pending.length) {
        process.stdout.write(`consultados ${index + 1}/${pending.length}; candidatos ${candidates.length}; dudosos ${doubts.length}; ambiguos ${ambiguous}; sin match ${noMatch}; fallos ${failures}\n`);
      }
      await pause(delay);
    }
    const out = path.resolve(ROOT, arg("--out") ?? "reports/media-deezer-artist-candidates.jsonl");
    const doubtsOut = path.resolve(ROOT, arg("--doubts") ?? "reports/media-deezer-artist-doubts.jsonl");
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, candidates.map((row) => JSON.stringify(row)).join("\n") + (candidates.length ? "\n" : ""));
    await writeFile(doubtsOut, doubts.map((row) => JSON.stringify(row)).join("\n") + (doubts.length ? "\n" : ""));
    process.stdout.write(`${JSON.stringify({ pending: pending.length, candidates: candidates.length, doubts: doubts.length, ambiguous, noMatch, failures, artworkSkips, out: path.relative(ROOT, out) })}\n`);
  } finally { await pool.end(); }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
