// CRV · Frases de banda → género del ARTISTA (Brian, 2026-09-27).
//
// «Hotdrinkers! es una banda de punk rock»: la fuente nombra el género del
// artista, y por la regla «una fuente basta» entra directo, sin Laya. Solo al
// artista: el disco no hereda (separación estricta). La oración tiene que
// hablar de ESE artista: lo nombra (o un alias), o es el arranque de su propia
// biografía / del post de uno de sus discos. Negaciones, comparaciones
// («como una banda de…») e influencias no cuentan.
//
// Solo lectura. Escribe el libro reports/genre-laya-evidence-band-phrases-2026-09-26.jsonl,
// que aplica scripts/apply-source-genres.ts (actor `auto:<fuente>`, run reversible).
import { writeFileSync } from "node:fs";
import { getEnv } from "../src/config/env.js";
import { closeDb, getPool } from "../src/db/client.js";
import { normalizeGenreText } from "../src/genres/normalize.js";
import { loadTaxonomy } from "../src/genres/store.js";
import { canonical, indexPosts, mentioned, TEXT_SOURCES } from "./lib/laya-texts.js";

const OUT = "reports/genre-laya-evidence-band-phrases-2026-09-26.jsonl";
const VARIOUS = /^(?:va|v\.a\.|various artists?|varios(?: artistas)?|compilado|recopilatorio)$|\b(?:bands|bandas|compilado|recopilatorio|tributo)\b/iu;
/** La oración habla de OTRA banda: el artista es miembro, viene de ella o la compara. */
const OTHER_BAND = /\b(?:como|parecid[oa]|estilo de|influencia|influenciad|al igual|similar|tipo|pertenec\w*|miembro|integrante|ex|exmiembro|fundador\w*|vocalista|guitarrista|bajista|baterista|tecladista|parte|junto|antigua|anterior|primer[ao]?|compilado|recopilatorio|tributo|bandas?\s+como|comenz\w*|con\s+su|su\s+proyecto|su\s+banda)\b/iu;

const NOUN = String.raw`(?:banda|grupo|agrupaci[oó]n|conjunto|proyecto|power[\s-]*trio|tr[ií]o|d[uú]o|cuarteto|quinteto|solista|cantautora?|cantante|m[uú]sico|guitarrista|orquesta)`;
const ADJ = String.raw`(?:(?:gran|joven|nueva|legendaria|m[ií]tica|recordada|reconocida|importante|destacada|pionera|primera|mejor|otra)\s+)?`;
/** «X es una banda de…», «fue un grupo venezolano de…», «banda caraqueña de…». */
const PHRASE = new RegExp(String.raw`(?:^|[\s,(])(no\s+)?(?:(?:es|son|fue|fueron|era|eran|ser[aá])\s+)?(?:una?|la|el|las|los)?\s*${ADJ}${NOUN}\b(.{0,90})`, "iu");
/** Donde termina la descripción del estilo y empieza otra cosa. */
const TAIL_END = /\b(?:que|con|cuy[oa]s?|formad[oa]s?|nacid[oa]s?|fundad[oa]s?|originari[oa]s?|influenciad[oa]s?|influencias?|surgid[oa]s?|cread[oa]s?|conformad[oa]s?|integrad[oa]s?|liderad[oa]s?|desde|durante|donde|cuando|en\s+(?:el|la|los|las|19|20|caracas|venezuela|maracaibo|valencia|barquisimeto|m[eé]rida)|a\s+(?:finales|principios|mediados))\b|[.,;:!?()"«»“”'‘’]/iu;
/** Lo que se salta entre el sustantivo y el estilo: origen y rellenos. */
const FILLER = /^(?:\s*(?:venezolan[oa]s?|caraqueñ[oa]s?|marabin[oa]s?|valencian[oa]s?|larens[e]s?|merideñ[oa]s?|andin[oa]s?|oriental(?:es)?|zulian[oa]s?|nacional(?:es)?|independientes?|underground|local(?:es)?|de|del|la|el|estilo|g[eé]nero|corte|tendencia|orientad[oa]s?|dedicad[oa]s?|al?|y|musical(?:es)?|m[uú]sica|sonido)(?=[\s,]|$)|\s*,)+/iu;

interface Hit { source: string; url: string | null; sentence: string; genres: string[] }

function startsWithGenre(taxonomy: Awaited<ReturnType<typeof loadTaxonomy>>, words: string[]): boolean {
  const norm = normalizeGenreText(words.slice(0, 4).join(" ")).replace(/[^a-z0-9 &]+/gu, " ").split(/\s+/u).filter(Boolean);
  for (let size = 1; size <= norm.length; size += 1) {
    const target = taxonomy.aliases.get(norm.slice(0, size).join(" "));
    if (target?.kind === "genre") return true;
  }
  return false;
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/u).map((s) => s.trim()).filter((s) => s.length > 8);
}

async function main(): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  const taxonomy = await loadTaxonomy(client);
  client.release();
  const posts = indexPosts(getEnv().DATA_DIR);

  const pending = (await pool.query<{ id: string; name: string }>(`
    SELECT ar.id::text, ar.name FROM public.artists ar
     WHERE NOT EXISTS (SELECT 1 FROM ingest.artist_genres g WHERE g.artist_id=ar.id AND g.role='primary' AND g.status='confirmed')`)).rows
    .filter((row) => !VARIOUS.test(row.name.trim()));
  const names = new Map<number, string[]>();
  for (const row of pending) names.set(Number(row.id), [row.name]);
  for (const row of (await pool.query<{ artist_id: string; alias: string }>(`SELECT artist_id::text, alias FROM ingest.artist_aliases`)).rows) {
    names.get(Number(row.artist_id))?.push(row.alias);
  }

  // Textos por artista: biografías/notas (propias) y posts de sus discos.
  const texts = new Map<number, Array<{ source: string; url: string | null; text: string; own: boolean }>>();
  const add = (id: number, item: { source: string; url: string | null; text: string; own: boolean }) => {
    if (names.has(id)) texts.set(id, [...(texts.get(id) ?? []), item]);
  };
  for (const row of (await pool.query<{ artist_id: string; slug: string; text: string; url: string | null }>(`
    SELECT c.artist_id::text, s.slug, c.raw_value #>> '{}' AS text,
           (SELECT e.url FROM ingest.claim_evidence e WHERE e.claim_id=c.id ORDER BY e.id LIMIT 1) AS url
      FROM ingest.claims c JOIN ingest.sources s ON s.id=c.source_id
     WHERE c.field IN ('biography','notes') AND c.entity_kind='artist' AND c.status='accepted' AND c.artist_id IS NOT NULL`)).rows) {
    add(Number(row.artist_id), { source: row.slug, url: row.url, text: row.text ?? "", own: true });
  }
  for (const row of (await pool.query<{ id: string; biography: string | null }>(`SELECT id::text, biography FROM public.artists WHERE biography IS NOT NULL`)).rows) {
    add(Number(row.id), { source: "catalogo-crv", url: null, text: row.biography ?? "", own: true });
  }
  for (const row of (await pool.query<{ artist_id: string; slug: string; url: string }>(`
    SELECT DISTINCT al.artist_id::text, s.slug, c.raw_value #>> '{}' AS url
      FROM ingest.claims c JOIN ingest.sources s ON s.id=c.source_id JOIN public.albums al ON al.id=c.album_id
     WHERE c.field='source_url' AND c.entity_kind='album' AND c.status='accepted' AND s.slug = ANY($1)`, [TEXT_SOURCES])).rows) {
    const text = posts.get(canonical(row.url));
    if (text) add(Number(row.artist_id), { source: row.slug, url: row.url, text, own: false });
  }

  const rows: unknown[] = [];
  const held: Array<{ artist: string; compound: string; phrase: string }> = [];
  const stats = { artistsWithText: texts.size, withPhrase: 0, negated: 0, rejectedSubject: 0 };
  for (const [id, items] of texts) {
    const keys = (names.get(id) ?? []).map((name) => normalizeGenreText(name)).filter((key) => key.length > 2);
    let hit: Hit | null = null;
    // Primero la biografía propia; después los posts de sus discos.
    for (const item of [...items].sort((a, b) => Number(b.own) - Number(a.own))) {
      const list = sentences(item.text);
      for (const [index, sentence] of list.entries()) {
        const match = PHRASE.exec(sentence);
        if (!match) continue;
        if (match[1]) { stats.negated += 1; continue; }
        const before = sentence.slice(0, match.index);
        if (OTHER_BAND.test(before) || /\bbandas\b/iu.test(match[0])) { stats.rejectedSubject += 1; continue; }
        const norm = normalizeGenreText(sentence);
        const namesIt = keys.some((key) => norm.includes(key));
        // Sin nombre, solo vale el arranque del texto propio o del post (sujeto implícito).
        if (!namesIt && !(index <= (item.own ? 1 : 2) && !/\b(?:otra|otras|otro|otros)\b/iu.test(before))) {
          stats.rejectedSubject += 1; continue;
        }
        const tail = match[2]!.replace(FILLER, "");
        const cut = tail.search(TAIL_END);
        const style = (cut >= 0 ? tail.slice(0, cut) : tail).trim();
        if (!style) continue;
        // El estilo tiene que empezar por un género, no mencionarlo de pasada.
        const ids = mentioned(taxonomy, style);
        // «Pop Punk», «Rock Indie» sin término propio en la taxonomía: dos
        // géneros pegados son un compuesto que no sabemos leer; se aparta.
        const lead = normalizeGenreText(style).replace(/[^a-z0-9 &]+/gu, " ").split(/\s+/u).filter(Boolean);
        const isGenre = (key: string) => taxonomy.aliases.get(key)?.kind === "genre";
        const hyphen = style.split(/\s+/u)[0] ?? "";
        const parts = normalizeGenreText(hyphen).replace(/[^a-z0-9 &]+/gu, " ").split(/\s+/u).filter(Boolean);
        if (/-/u.test(hyphen) && parts.length > 1 && !isGenre(parts.join(" ")) && !parts.every(isGenre)) {
          held.push({ artist: names.get(id)![0]!, compound: hyphen, phrase: sentence.slice(0, 200) });
          continue;
        }
        if (lead.length >= 2 && isGenre(lead[0]!) && isGenre(lead[1]!) && !isGenre(`${lead[0]} ${lead[1]}`)
          && !(lead[2] && isGenre(`${lead[0]} ${lead[1]} ${lead[2]}`)) && !(lead[2] && isGenre(`${lead[1]} ${lead[2]}`))) {
          held.push({ artist: names.get(id)![0]!, compound: `${lead[0]} ${lead[1]}`, phrase: sentence.slice(0, 200) });
          continue;
        }
        // El estilo empieza por un género (se tolera una palabra antes: «Progresive Death Metal»).
        const words = style.split(/\s+/u);
        if (!ids.length || (!mentioned(taxonomy, words.slice(0, 4).join(" ")).length)
          || !startsWithGenre(taxonomy, words) && !startsWithGenre(taxonomy, words.slice(1))) continue;
        hit = { source: item.source, url: item.url, sentence: sentence.slice(0, 300), genres: ids.map((gid) => taxonomy.genres.get(gid)!.name) };
        break;
      }
      if (hit) break;
    }
    if (!hit) continue;
    stats.withPhrase += 1;
    rows.push({
      caseId: `artist:${id}`, kind: "artist", entityId: id, source: hit.source, url: hit.url ?? `crv:artist/${id}`,
      title: names.get(id)![0], rawGenres: hit.genres, phrase: hit.sentence,
    });
  }
  writeFileSync(OUT, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
  writeFileSync("reports/genre-band-phrases-held-2026-09-27.json", JSON.stringify(held, null, 2));
  console.log(JSON.stringify({ pendingArtists: pending.length, ...stats, heldCompounds: held.length, out: OUT }, null, 2));
  await closeDb();
}

main().catch(async (error) => { console.error(error); await closeDb(); process.exit(1); });
