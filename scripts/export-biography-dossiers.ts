// CRV · Expedientes para la síntesis de biografías (pedido de Brian del
// 2026-09-27: completar o mejorar la biografía de todos los artistas, personas
// y organizaciones y la reseña de todos los discos con todas las fuentes).
//
// Cada expediente junta, para una ficha:
//  * DATOS DEL CATÁLOGO: lo que el core ya afirma (origen, años, miembros,
//    discos, créditos, sello, géneros confirmados…).
//  * BIOGRAFÍA ACTUAL: la del core; la síntesis la enriquece, nunca la pierde.
//  * TEXTOS DE FUENTES: los posts de las fuentes del proyecto (capturas
//    locales de Rock De Vzla, Rockzuela, Hippito, RHV, CRV, Descargas Metal, El
//    Punk, Rock Hecho), las descripciones del canal de YouTube del proyecto y
//    lo que cosechó scripts/harvest-biography-texts.py (Lobotoradio, Last.fm,
//    Wikipedia, La Venciclopedia, Discogs, MusicBrainz, TheAudioDB, directorio
//    RHV, Vzla Rockea, Sincopa), cada uno con su URL y su prueba de identidad.
//
// Las fichas con una biografía corregida a mano (claim de `crv-operador` o
// auditoría «corrección humana») no se envían: la síntesis no pisa decisiones
// humanas. Solo lectura.
// Salida: reports/bio-dossiers/<tipo>-NNN.jsonl (lotes) y manifest.json.
// Uso: tsx scripts/export-biography-dossiers.ts [--kinds=artist,album,person,organization]
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getEnv } from "../src/config/env.js";
import { closeDb, getPool } from "../src/db/client.js";
import { SKIP_SOURCE_ROWS } from "./genre-source-skip.js";
import { canonical, indexPosts, prose, TEXT_SOURCES } from "./lib/laya-texts.js";

type Kind = "artist" | "album" | "person" | "organization";
interface SourceText { ref: string; source: string; url: string | null; lang: string; identity: string | null; text: string; facts?: Record<string, unknown> }
interface Dossier { caseId: string; kind: Kind; entityId: number; name: string; catalog: Record<string, unknown>; currentText: string | null; sources: SourceText[] }

const OUT_DIR = process.env["BIO_DOSSIERS_DIR"] ?? "reports/bio-dossiers";
const TEXTS_DIR = "reports/bio-texts";
/** Textos ya recuperados por los frentes de géneros ({caseId, source, url, text}). */
const EXTRA_TEXTS = ["reports/genre-local-texts-2026-09-27.jsonl", "reports/genre-new-texts-lastfm-2026-09-27.jsonl",
  "reports/genre-new-texts-rhv-directorio-2026-09-27.jsonl", "reports/genre-new-texts-wikipedia-2026-09-27.jsonl"];
const MAX_TEXT = 3500;
const MAX_SOURCE_CHARS = 14000;
/** Tamaño del lote en caracteres de expediente: lo que un subagente lee de una vez. */
const BATCH_CHARS = 110_000;
const BATCH_MAX = 120;
const VARIOUS = /^(?:va|v\.a\.|various artists?|varios(?: artistas)?)$/iu;

const kindsArg = process.argv.find((arg) => arg.startsWith("--kinds="))?.slice("--kinds=".length);
const KINDS = (kindsArg ? kindsArg.split(",") : ["artist", "album", "person", "organization"]) as Kind[];
// Segunda pasada: solo las fichas que alguna de estas fuentes cosechadas nombra.
const withSources = process.argv.find((arg) => arg.startsWith("--with-sources="))?.slice("--with-sources=".length).split(",");

const pool = getPool();
const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => (await pool.query<T>(sql, params)).rows;
const group = <T,>(rows: T[], key: (row: T) => string) => {
  const map = new Map<string, T[]>();
  for (const row of rows) map.set(key(row), [...(map.get(key(row)) ?? []), row]);
  return map;
};
const years = (from: unknown, to: unknown) => (from || to ? ` (${from ?? "?"}–${to ?? ""})` : "");
const clip = (text: string, max = MAX_TEXT) => (text.length > max ? `${text.slice(0, max).replace(/\s+\S*$/u, "")} […]` : text);
const clean = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([, v]) =>
  v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0)));

async function main(): Promise<void> {
  const posts = indexPosts(getEnv().DATA_DIR);

  // --- Fuentes cosechadas --------------------------------------------------
  const harvested = new Map<string, SourceText[]>();
  // Las páginas vetadas en genre-source-skip.ts son de homónimos: tampoco sirven para la biografía.
  const push = (caseId: string, item: SourceText) => {
    if (SKIP_SOURCE_ROWS.has(`${item.source}|${caseId}`)) return;
    harvested.set(caseId, [...(harvested.get(caseId) ?? []), item]);
  };
  const seenText = new Set<string>();
  if (existsSync(TEXTS_DIR)) {
    for (const file of readdirSync(TEXTS_DIR).filter((name) => name.endsWith(".jsonl") && !name.includes("-sample"))) {
      for (const line of readFileSync(path.join(TEXTS_DIR, file), "utf8").split("\n")) {
        if (!line.trim()) continue;
        const row = JSON.parse(line) as { caseId: string; source: string; url: string; lang: string; text: string; facts: Record<string, unknown>; identity: string };
        const key = `${row.caseId}|${row.text.slice(0, 200)}`;
        if (row.text && seenText.has(key)) continue;
        seenText.add(key);
        push(row.caseId, { ref: "", source: row.source, url: row.url, lang: row.lang, identity: row.identity,
          text: clip(row.text), ...(Object.keys(row.facts ?? {}).length ? { facts: row.facts } : {}) });
      }
    }
  }
  for (const file of EXTRA_TEXTS.filter((name) => existsSync(name))) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as { caseId: string; source: string; url: string | null; text: string };
      const key = `${row.caseId}|${row.text.slice(0, 200)}`;
      if (seenText.has(key)) continue;
      seenText.add(key);
      push(row.caseId, { ref: "", source: row.source, url: row.url, lang: /\b(the|and|was|with)\b/iu.test(row.text.slice(0, 400)) ? "en" : "es",
        identity: "texto ya recuperado y casado por los frentes de géneros", text: clip(prose(row.text)) });
    }
  }

  // --- Protegidas: corrección humana ---------------------------------------
  const protectedCases = new Set((await q<{ case_id: string }>(`
    SELECT c.entity_kind || ':' || COALESCE(c.artist_id, c.album_id, c.person_id, c.organization_id) AS case_id
      FROM ingest.claims c JOIN ingest.sources s ON s.id=c.source_id
     WHERE s.slug='crv-operador' AND c.field IN ('biography','description')
    UNION
    SELECT a.entity_kind || ':' || COALESCE(a.artist_id, a.album_id, a.person_id, a.organization_id)
      FROM ingest.merge_audit a
     WHERE a.field IN ('biography','description') AND a.reason ILIKE 'corrección humana%'`)).map((row) => row.case_id));

  // --- URLs de origen y textos locales --------------------------------------
  const sourceUrls = group(await q<{ case_id: string; slug: string; url: string }>(`
    SELECT c.entity_kind || ':' || COALESCE(c.artist_id, c.album_id, c.person_id, c.organization_id) AS case_id,
           s.slug, c.raw_value #>> '{}' AS url
      FROM ingest.claims c JOIN ingest.sources s ON s.id=c.source_id
     WHERE c.field='source_url' AND c.status='accepted' AND s.slug = ANY($1)
       AND COALESCE(c.artist_id, c.album_id, c.person_id, c.organization_id) IS NOT NULL`, [TEXT_SOURCES]), (row) => row.case_id);
  const localTexts = (caseId: string): SourceText[] => {
    const out: SourceText[] = [];
    const seen = new Set<string>();
    for (const link of sourceUrls.get(caseId) ?? []) {
      const raw = posts.get(canonical(link.url));
      const text = raw ? prose(raw) : "";
      if (text.length < 60 || seen.has(text.slice(0, 300))) continue;
      seen.add(text.slice(0, 300));
      out.push({ ref: "", source: link.slug, url: link.url, lang: "es", identity: "URL de origen aceptada en el catálogo", text: clip(text) });
    }
    return out;
  };
  const bioClaims = group(await q<{ case_id: string; slug: string; text: string; url: string | null }>(`
    SELECT c.entity_kind || ':' || COALESCE(c.artist_id, c.album_id, c.person_id, c.organization_id) AS case_id,
           s.slug, c.raw_value #>> '{}' AS text,
           (SELECT e.url FROM ingest.claim_evidence e WHERE e.claim_id=c.id ORDER BY e.id LIMIT 1) AS url
      FROM ingest.claims c JOIN ingest.sources s ON s.id=c.source_id
     WHERE c.field IN ('biography','description') AND c.status IN ('accepted','candidate')
       AND s.slug NOT IN ('crv-operador','crv-sintesis')`), (row) => row.case_id);

  // --- Datos del catálogo ------------------------------------------------------
  const confirmedGenres = async (table: string, column: string) => group(await q<{ id: string; name: string; role: string }>(`
    SELECT g.${column}::text AS id, x.name, g.role FROM ingest.${table} g JOIN ingest.genres x ON x.id=g.genre_id
     WHERE g.status='confirmed' ORDER BY g.role DESC, x.name`), (row) => row.id);
  const artistGenres = await confirmedGenres("artist_genres", "artist_id");
  const albumGenres = await confirmedGenres("album_genres", "album_id");
  const artists = await q<{ id: string; name: string; artist_type: string; biography: string | null; origin_city: string | null; origin_country: string | null; formed_year: number | null; disbanded_year: number | null }>(
    `SELECT id::text, name, artist_type, biography, origin_city, origin_country, formed_year, disbanded_year FROM public.artists ORDER BY id`);
  const artistName = new Map(artists.map((a) => [a.id, a.name]));
  const albums = await q<{ id: string; artist_id: string; title: string; release_year: number | null; album_type: string; label: string | null; description: string | null; youtube_url: string | null }>(`
    SELECT al.id::text, al.artist_id::text, al.title, al.release_year, al.album_type, o.name AS label, al.description, al.youtube_url
      FROM public.albums al LEFT JOIN public.organizations o ON o.id=al.label_id ORDER BY al.id`);
  const albumsByArtist = group(albums, (a) => a.artist_id);
  const albumsByLabel = group(await q<{ label_id: string; line: string }>(`
    SELECT al.label_id::text, ar.name || ' — ' || al.title || COALESCE(' (' || al.release_year || ')', '') AS line
      FROM public.albums al JOIN public.artists ar ON ar.id=al.artist_id WHERE al.label_id IS NOT NULL
     ORDER BY al.release_year NULLS LAST`), (r) => r.label_id);
  const members = group(await q<{ artist_id: string; person_id: string; person: string; artist: string; role: string; from_year: number | null; to_year: number | null; is_current: boolean }>(`
    SELECT m.artist_id::text, m.person_id::text, p.name AS person, a.name AS artist, m.role, m.from_year, m.to_year, m.is_current
      FROM public.artist_members m JOIN public.persons p ON p.id=m.person_id JOIN public.artists a ON a.id=m.artist_id
     ORDER BY m.from_year NULLS LAST, p.name`), (r) => r.artist_id);
  const memberOf = group([...members.values()].flat(), (r) => r.person_id);
  const albumCredits = await q<{ album_id: string; person_id: string | null; who: string; role: string; credit_type: string }>(`
    SELECT c.album_id::text, c.person_id::text, COALESCE(p.name, a.name, o.name) AS who, c.role, c.credit_type::text
      FROM public.album_credits c LEFT JOIN public.persons p ON p.id=c.person_id LEFT JOIN public.artists a ON a.id=c.artist_id
      LEFT JOIN public.organizations o ON o.id=c.organization_id`);
  const creditsByAlbum = group(albumCredits, (r) => r.album_id);
  const personCredits = group(await q<{ person_id: string; line: string; artist_name: string }>(`
    SELECT person_id::text, artist_name,
           role || ' en «' || album_title || '» de ' || artist_name AS line
      FROM public.person_album_credits
    UNION
    SELECT tc.person_id::text, ar.name,
           tc.role || ' en «' || t.title || '» (disco «' || al.title || '» de ' || ar.name || ')'
      FROM public.track_credits tc JOIN public.tracks t ON t.id=tc.track_id JOIN public.albums al ON al.id=t.album_id
      JOIN public.artists ar ON ar.id=al.artist_id WHERE tc.person_id IS NOT NULL`), (r) => r.person_id);
  const tracks = group(await q<{ album_id: string; title: string }>(
    `SELECT album_id::text, title FROM public.tracks ORDER BY album_id, disc_number, track_number`), (r) => r.album_id);
  const formats = group(await q<{ album_id: string; format: string }>(`SELECT album_id::text, format::text FROM public.album_formats`), (r) => r.album_id);
  const personOrgs = group(await q<{ person_id: string; organization_id: string; person: string; org: string; role: string; from_year: number | null; to_year: number | null }>(`
    SELECT po.person_id::text, po.organization_id::text, p.name AS person, o.name AS org, po.role, po.from_year, po.to_year
      FROM public.person_organizations po JOIN public.persons p ON p.id=po.person_id JOIN public.organizations o ON o.id=po.organization_id`), (r) => r.person_id);
  const orgPeople = group([...personOrgs.values()].flat(), (r) => r.organization_id);
  const videos = group(await q<{ album_id: string; url: string; title: string; description: string | null }>(`
    SELECT va.album_id::text, v.url, v.title, v.description
      FROM media.video_albums va JOIN media.youtube_videos v ON v.id=va.video_id
     WHERE v.description IS NOT NULL AND length(v.description) > 40`), (r) => r.album_id);
  const persons = await q<{ id: string; name: string; biography: string | null; nationality: string | null; is_venezuelan: boolean | null; birth_date: string | null; death_date: string | null }>(
    `SELECT id::text, name, biography, nationality, is_venezuelan, birth_date::text, death_date::text FROM public.persons ORDER BY id`);
  const organizations = await q<{ id: string; name: string; organization_type: string; biography: string | null; website_url: string | null; country: string | null }>(
    `SELECT id::text, name, organization_type::text, biography, website_url, country FROM public.organizations ORDER BY id`);

  const sourcesFor = (caseId: string, extra: SourceText[] = []): SourceText[] => {
    const all: SourceText[] = [...(bioClaims.get(caseId) ?? []).map((b) => ({ ref: "", source: b.slug, url: b.url, lang: "es", identity: "claim de biografía de la fuente, ya en el catálogo", text: clip(b.text) })),
      ...localTexts(caseId), ...extra, ...(harvested.get(caseId) ?? [])];
    const out: SourceText[] = [];
    const kept: string[] = [];
    let budget = MAX_SOURCE_CHARS;
    // El mismo texto llega por varias vías (claim de biografía, post, libro de
    // géneros) con otro título delante: se compara un tramo del medio.
    const squash = (text: string) => text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/gu, "");
    for (const item of [...all].sort((a, b) => b.text.length - a.text.length)) {
      const flat = squash(item.text);
      if (flat.length >= 60) {
        const probe = flat.slice(Math.floor(flat.length / 2) - 30, Math.floor(flat.length / 2) + 30);
        if (kept.some((other) => other.includes(probe))) continue;
        kept.push(flat);
      }
      if (budget <= 0 && !item.facts) continue;
      const text = budget > 0 ? clip(item.text, Math.min(MAX_TEXT, Math.max(budget, 400))) : "";
      budget -= text.length;
      out.push({ ...item, ref: `s${out.length + 1}`, text });
    }
    return out;
  };

  const dossiers: Dossier[] = [];
  const skipped = { protected: [] as string[], various: 0 };

  if (KINDS.includes("artist")) {
    for (const artist of artists) {
      const caseId = `artist:${artist.id}`;
      if (protectedCases.has(caseId)) { skipped.protected.push(caseId); continue; }
      if (VARIOUS.test(artist.name.trim())) { skipped.various += 1; continue; }
      const own = albumsByArtist.get(artist.id) ?? [];
      // Posts de sus discos: suelen abrir con la historia de la banda.
      const albumPosts = own.flatMap((album) => localTexts(`album:${album.id}`).slice(0, 1)
        .map((item) => ({ ...item, identity: `post del disco «${album.title}» de esta ficha`, text: clip(item.text, 1500) }))).slice(0, 4);
      dossiers.push({
        caseId, kind: "artist", entityId: Number(artist.id), name: artist.name, currentText: artist.biography,
        catalog: clean({
          tipo: artist.artist_type, ciudad: artist.origin_city, país: artist.origin_country,
          formación: artist.formed_year, separación: artist.disbanded_year,
          géneros: (artistGenres.get(artist.id) ?? []).map((g) => g.name),
          miembros: (members.get(artist.id) ?? []).map((m) => `${m.person} — ${m.role}${years(m.from_year, m.to_year)}${m.is_current ? " (actual)" : ""}`).slice(0, 40),
          discos: own.map((a) => `${a.title}${a.release_year ? ` (${a.release_year})` : ""} [${a.album_type}]${a.label ? ` — ${a.label}` : ""}`).slice(0, 60),
        }),
        sources: sourcesFor(caseId, albumPosts),
      });
    }
  }
  if (KINDS.includes("album")) {
    for (const album of albums) {
      const caseId = `album:${album.id}`;
      if (protectedCases.has(caseId)) { skipped.protected.push(caseId); continue; }
      const videoTexts = (videos.get(album.id) ?? []).map((v) => ({ ref: "", source: "youtube-canal-crv", url: v.url, lang: "es",
        identity: "video del canal del proyecto enlazado al disco", text: clip(`${v.title}\n${v.description}`, 2500) }));
      const credits = creditsByAlbum.get(album.id) ?? [];
      dossiers.push({
        caseId, kind: "album", entityId: Number(album.id), name: album.title, currentText: album.description,
        catalog: clean({
          artista: artistName.get(album.artist_id), año: album.release_year, tipo: album.album_type, sello: album.label,
          formatos: [...new Set((formats.get(album.id) ?? []).map((f) => f.format))],
          géneros: (albumGenres.get(album.id) ?? []).map((g) => g.name),
          temas: (tracks.get(album.id) ?? []).map((t) => t.title).slice(0, 40),
          créditos: credits.map((c) => `${c.who} — ${c.role}`).slice(0, 50),
          youtube: album.youtube_url,
        }),
        sources: sourcesFor(caseId, videoTexts),
      });
    }
  }
  if (KINDS.includes("person")) {
    for (const person of persons) {
      const caseId = `person:${person.id}`;
      if (protectedCases.has(caseId)) { skipped.protected.push(caseId); continue; }
      const bands = memberOf.get(person.id) ?? [];
      dossiers.push({
        caseId, kind: "person", entityId: Number(person.id), name: person.name, currentText: person.biography,
        catalog: clean({
          venezolano: person.is_venezuelan, nacionalidad: person.nationality, nacimiento: person.birth_date, muerte: person.death_date,
          bandas: bands.map((m) => `${m.artist} — ${m.role}${years(m.from_year, m.to_year)}${m.is_current ? " (actual)" : ""}`),
          organizaciones: (personOrgs.get(person.id) ?? []).map((o) => `${o.org} — ${o.role}${years(o.from_year, o.to_year)}`),
          créditos: [...new Set((personCredits.get(person.id) ?? []).map((c) => c.line))].slice(0, 40),
        }),
        sources: sourcesFor(caseId),
      });
    }
  }
  if (KINDS.includes("organization")) {
    for (const org of organizations) {
      const caseId = `organization:${org.id}`;
      if (protectedCases.has(caseId)) { skipped.protected.push(caseId); continue; }
      dossiers.push({
        caseId, kind: "organization", entityId: Number(org.id), name: org.name, currentText: org.biography,
        catalog: clean({
          tipo: org.organization_type, país: org.country, web: org.website_url,
          discos: (albumsByLabel.get(org.id) ?? []).map((r) => r.line).slice(0, 60),
          personas: (orgPeople.get(org.id) ?? []).map((p) => `${p.person} — ${p.role}${years(p.from_year, p.to_year)}`).slice(0, 30),
        }),
        sources: sourcesFor(caseId),
      });
    }
  }

  // --- Lotes -------------------------------------------------------------------
  if (withSources) {
    const keep = (d: Dossier) => d.sources.some((source) => withSources.includes(source.source));
    dossiers.splice(0, dossiers.length, ...dossiers.filter(keep));
  }
  if (existsSync(OUT_DIR)) {
    for (const file of readdirSync(OUT_DIR)) {
      const match = /^(artist|album|person|organization)-\d+\.jsonl$/u.exec(file);
      if (match && KINDS.includes(match[1] as Kind)) rmSync(path.join(OUT_DIR, file));
    }
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const manifest: Array<{ file: string; kind: Kind; count: number; chars: number }> = [];
  for (const kind of KINDS) {
    let batch: string[] = [];
    let chars = 0;
    const flush = () => {
      if (!batch.length) return;
      const file = `${kind}-${String(manifest.filter((m) => m.kind === kind).length + 1).padStart(3, "0")}.jsonl`;
      writeFileSync(path.join(OUT_DIR, file), batch.join("\n") + "\n");
      manifest.push({ file, kind, count: batch.length, chars });
      batch = []; chars = 0;
    };
    for (const dossier of dossiers.filter((d) => d.kind === kind)) {
      const line = JSON.stringify(dossier);
      if (batch.length && (chars + line.length > BATCH_CHARS || batch.length >= BATCH_MAX)) flush();
      batch.push(line); chars += line.length;
    }
    flush();
  }
  const withText = (kind: Kind) => dossiers.filter((d) => d.kind === kind && (d.sources.some((s) => s.text.length >= 80) || (d.currentText ?? "").length >= 80)).length;
  const summary = {
    postsIndexed: posts.size, dossiers: dossiers.length, batches: manifest.length,
    byKind: Object.fromEntries(KINDS.map((kind) => [kind, { dossiers: dossiers.filter((d) => d.kind === kind).length, withText: withText(kind),
      batches: manifest.filter((m) => m.kind === kind).length }])),
    skipped,
  };
  const manifestPath = path.join(OUT_DIR, "manifest.json");
  const previous = existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, "utf8")) as { batches: typeof manifest }).batches
    .filter((batch) => !KINDS.includes(batch.kind)) : [];
  writeFileSync(manifestPath, JSON.stringify({ summary, batches: [...previous, ...manifest] }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  await closeDb();
}

main().catch(async (error) => { console.error(error); await closeDb(); process.exit(1); });
