// CRV · Expedientes para Laya (último recurso de géneros, regla de Brian del
// 2026-09-26/27: primero se agotan las fuentes; Laya solo con evidencia
// completa y lo que elija se confirma directo).
//
// Para cada ficha SIN género principal confirmado arma un expediente:
//  * TEXTO PROPIO (obligatorio): disco → la reseña del post de origen, leída
//    de la captura guardada; artista → su biografía. Sin texto propio la ficha
//    no se envía: con solo el contexto el disco heredaría el género del artista
//    (o al revés), y eso la regla de herencia lo prohíbe.
//  * CONTEXTO (opcional): disco → géneros confirmados de su artista y de sus
//    otros discos; artista → géneros confirmados de sus discos. Orienta, no
//    decide.
//  * OPCIONES (1–8): solo géneros que el texto propio nombra con un alias
//    aprobado; el contexto nunca aporta una opción. Sin opciones no se envía.
// Solo lectura. Escribe reports/genre-laya-dossiers-<fecha>.jsonl y un resumen.
import { readFileSync, writeFileSync } from "node:fs";
import { getEnv } from "../src/config/env.js";
import { closeDb, getPool } from "../src/db/client.js";
import { loadTaxonomy } from "../src/genres/store.js";
import { canonical, indexPosts, mentioned, prose, TEXT_SOURCES } from "./lib/laya-texts.js";
import { SKIP_SOURCE_ROWS } from "./genre-source-skip.js";

const DATE = "2026-09-27";
const OUT = process.env["LAYA_DOSSIERS_OUT"] ?? `reports/genre-laya-dossiers-${DATE}.jsonl`;
const MAX_TEXT = 1800;
const MAX_CANDIDATES = 8;
const VARIOUS = /^(?:va|v\.a\.|various artists?|varios(?: artistas)?)$/iu;
/**
 * Textos recuperados por otros frentes (capturas locales no enlazadas, fuentes
 * nuevas): {caseId, source, url, text}. Se suman como texto propio.
 */
const EXTRA_TEXTS = (process.env["LAYA_EXTRA_TEXTS"] ?? "").split(",").map((file) => file.trim()).filter(Boolean);

interface Evidence { ref: string; kind: "post_text" | "biography" | "context_genre"; source: string; text: string; url: string | null }
interface Candidate { slug: string; name: string; level: string; family: string | null; evidenceRefs: string[] }

async function main(): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  const taxonomy = await loadTaxonomy(client);
  client.release();
  const posts = indexPosts(getEnv().DATA_DIR);

  const confirmed = async (table: string, column: string) => {
    const { rows } = await pool.query<{ id: string; slug: string; role: string }>(`
      SELECT g.${column}::text AS id, x.slug, g.role FROM ingest.${table} g JOIN ingest.genres x ON x.id=g.genre_id
       WHERE g.status='confirmed' ORDER BY g.role DESC`);
    const map = new Map<number, string[]>();
    for (const row of rows) map.set(Number(row.id), [...(map.get(Number(row.id)) ?? []), row.slug]);
    return map;
  };
  const albumGenres = await confirmed("album_genres", "album_id");
  const artistGenres = await confirmed("artist_genres", "artist_id");
  const albums = (await pool.query<{ id: string; title: string; artist_id: string; artist: string; release_year: number | null; label: string | null }>(`
    SELECT al.id::text, al.title, al.artist_id::text, ar.name AS artist, al.release_year, o.name AS label
      FROM public.albums al JOIN public.artists ar ON ar.id=al.artist_id LEFT JOIN public.organizations o ON o.id=al.label_id`)).rows;
  const artists = (await pool.query<{ id: string; name: string; biography: string | null; origin_city: string | null }>(`
    SELECT id::text, name, biography, origin_city FROM public.artists`)).rows;
  const albumUrls = new Map<number, Array<{ source: string; url: string }>>();
  for (const row of (await pool.query<{ album_id: string; slug: string; url: string }>(`
    SELECT c.album_id::text, s.slug, c.raw_value #>> '{}' AS url FROM ingest.claims c JOIN ingest.sources s ON s.id=c.source_id
     WHERE c.field='source_url' AND c.entity_kind='album' AND c.status='accepted' AND c.album_id IS NOT NULL
       AND s.slug = ANY($1)`, [TEXT_SOURCES])).rows) {
    albumUrls.set(Number(row.album_id), [...(albumUrls.get(Number(row.album_id)) ?? []), { source: row.slug, url: row.url }]);
  }
  const bios = new Map<number, Array<{ source: string; text: string; url: string | null }>>();
  for (const row of (await pool.query<{ artist_id: string; slug: string; text: string; url: string | null }>(`
    SELECT c.artist_id::text, s.slug, c.raw_value #>> '{}' AS text,
           (SELECT e.url FROM ingest.claim_evidence e WHERE e.claim_id=c.id ORDER BY e.id LIMIT 1) AS url
      FROM ingest.claims c JOIN ingest.sources s ON s.id=c.source_id
     WHERE c.field='biography' AND c.entity_kind='artist' AND c.status='accepted' AND c.artist_id IS NOT NULL`)).rows) {
    bios.set(Number(row.artist_id), [...(bios.get(Number(row.artist_id)) ?? []), { source: row.slug, text: row.text, url: row.url }]);
  }
  const extras = new Map<string, Array<{ source: string; url: string | null; text: string }>>();
  for (const file of EXTRA_TEXTS) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as { caseId: string; source: string; url: string | null; text: string };
      if (SKIP_SOURCE_ROWS.has(`${row.source}|${row.caseId}`)) continue;
      extras.set(row.caseId, [...(extras.get(row.caseId) ?? []), row]);
    }
  }
  const albumsByArtist = new Map<number, typeof albums>();
  for (const album of albums) albumsByArtist.set(Number(album.artist_id), [...(albumsByArtist.get(Number(album.artist_id)) ?? []), album]);

  const describe = (slug: string, refs: string[]): Candidate => {
    const genre = taxonomy.bySlug.get(slug)!;
    const family = genre.parentId === null ? null : taxonomy.genres.get(genre.parentId)?.slug ?? null;
    return { slug, name: genre.name, level: genre.level, family, evidenceRefs: refs };
  };
  /**
   * Opciones: SOLO lo que nombra el texto propio. El contexto (géneros del
   * artista o de otros discos) va como evidencia para orientar a Laya, pero
   * nunca aporta una opción: si lo hiciera, el disco heredaría del artista.
   */
  const options = (own: Evidence[], ignore: string[]): Candidate[] => {
    const bySlug = new Map<string, string[]>();
    for (const item of own) {
      for (const id of mentioned(taxonomy, item.text, ignore)) {
        const slug = taxonomy.genres.get(id)!.slug;
        bySlug.set(slug, [...(bySlug.get(slug) ?? []), item.ref]);
      }
    }
    return [...bySlug.entries()].slice(0, MAX_CANDIDATES).map(([slug, refs]) => describe(slug, [...new Set(refs)]));
  };

  const cases: unknown[] = [];
  const stats = {
    album: { pending: 0, various: 0, extraText: 0, withText: 0, withOptions: 0, textButNoOptions: 0 },
    artist: { pending: 0, extraText: 0, withText: 0, withOptions: 0, textButNoOptions: 0 },
  };

  const primaries = async (table: string, column: string) => new Set((await pool.query<{ id: string }>(
    `SELECT DISTINCT ${column}::text AS id FROM ingest.${table} WHERE role='primary' AND status='confirmed'`)).rows.map((row) => Number(row.id)));
  const albumsDone = await primaries("album_genres", "album_id");
  const artistsDone = await primaries("artist_genres", "artist_id");

  for (const album of albums) {
    const id = Number(album.id);
    if (albumsDone.has(id)) continue;
    stats.album.pending += 1;
    // Recopilatorios de varios artistas: el post nombra canciones y bandas
    // ajenas («Black Is Black»); no hay un estilo propio que leer.
    if (VARIOUS.test(album.artist.trim())) { stats.album.various += 1; continue; }
    const own: Evidence[] = [];
    for (const [index, link] of (albumUrls.get(id) ?? []).entries()) {
      const raw = posts.get(canonical(link.url));
      const text = raw ? prose(raw) : "";
      if (text.length > 40) own.push({ ref: `post:${index + 1}`, kind: "post_text", source: link.source, text: text.slice(0, MAX_TEXT), url: link.url });
    }
    for (const [index, extra] of (extras.get(`album:${id}`) ?? []).entries()) {
      const text = prose(extra.text);
      if (text.length > 40) { own.push({ ref: `extra:${index + 1}`, kind: "post_text", source: extra.source, text: text.slice(0, MAX_TEXT), url: extra.url }); stats.album.extraText += 1; }
    }
    if (!own.length) continue;
    stats.album.withText += 1;
    const artistId = Number(album.artist_id);
    const siblingSlugs = (albumsByArtist.get(artistId) ?? []).filter((other) => Number(other.id) !== id)
      .flatMap((other) => albumGenres.get(Number(other.id)) ?? []);
    const contextSlugs = [...new Set([...(artistGenres.get(artistId) ?? []), ...siblingSlugs])];
    const context: Evidence[] = contextSlugs.length ? [{
      ref: "contexto", kind: "context_genre", source: "catalogo-crv", url: null,
      text: `Géneros ya confirmados del artista ${album.artist} y de sus otros discos (solo contexto, no del disco): ${contextSlugs.join(", ")}`,
    }] : [];
    const candidates = options(own, [album.title, album.artist]);
    if (!candidates.length) { stats.album.textButNoOptions += 1; continue; }
    stats.album.withOptions += 1;
    cases.push({
      caseId: `album:${id}`, kind: "album", entityId: id, title: album.title, artist: album.artist,
      year: album.release_year, label: album.label, evidence: [...own, ...context], candidates,
    });
  }

  for (const artist of artists) {
    const id = Number(artist.id);
    if (artistsDone.has(id)) continue;
    stats.artist.pending += 1;
    const own: Evidence[] = [];
    for (const [index, bio] of (bios.get(id) ?? []).entries()) {
      if (bio.text?.trim().length > 40) own.push({ ref: `bio:${index + 1}`, kind: "biography", source: bio.source, text: bio.text.slice(0, MAX_TEXT), url: bio.url });
    }
    if (!own.length && artist.biography && artist.biography.trim().length > 40) {
      own.push({ ref: "bio:core", kind: "biography", source: "catalogo-crv", text: artist.biography.slice(0, MAX_TEXT), url: null });
    }
    for (const [index, extra] of (extras.get(`artist:${id}`) ?? []).entries()) {
      const text = prose(extra.text);
      if (text.length > 40) { own.push({ ref: `extra:${index + 1}`, kind: "biography", source: extra.source, text: text.slice(0, MAX_TEXT), url: extra.url }); stats.artist.extraText += 1; }
    }
    if (!own.length) continue;
    stats.artist.withText += 1;
    const contextSlugs = [...new Set((albumsByArtist.get(id) ?? []).flatMap((album) => albumGenres.get(Number(album.id)) ?? []))];
    const context: Evidence[] = contextSlugs.length ? [{
      ref: "contexto", kind: "context_genre", source: "catalogo-crv", url: null,
      text: `Géneros ya confirmados de los discos de ${artist.name} (solo contexto): ${contextSlugs.join(", ")}`,
    }] : [];
    const candidates = options(own, [artist.name]);
    if (!candidates.length) { stats.artist.textButNoOptions += 1; continue; }
    stats.artist.withOptions += 1;
    cases.push({
      caseId: `artist:${id}`, kind: "artist", entityId: id, title: artist.name, origin: artist.origin_city,
      evidence: [...own, ...context], candidates,
    });
  }

  writeFileSync(OUT, cases.map((row) => JSON.stringify(row)).join("\n") + (cases.length ? "\n" : ""));
  console.log(JSON.stringify({ postsIndexed: posts.size, ...stats, cases: cases.length, out: OUT }, null, 2));
  await closeDb();
}

main().catch(async (error) => { console.error(error); await closeDb(); process.exit(1); });
