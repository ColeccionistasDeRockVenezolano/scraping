// CRV · Etapa 3 del nuevo lote (plan ~/Desktop/PLAN_NUEVO_LOTE_2026-10-02.md §3):
// discos, en UN run reversible (`crv runs undo <run>`).
//
// Parte de la cosecha de scripts/lote-etapa3-cosecha.ts (MusicBrainz y Deezer,
// con la identidad del artista ya verificada) y decide disco a disco:
//
//   · Discografía: entra todo disco que la ficha firma como artista principal
//     en MusicBrainz, y en Deezer el que tiene ancla propia: título que ya
//     conocemos (catálogo, lote o MusicBrainz) o el mismo sello que un disco
//     anclado. Deezer junta homónimos en una página; lo que no tiene ancla
//     queda en lista, sin crearse.
//   · Discos del lote (decisión 4 de Brian): entran si una segunda fuente
//     (MusicBrainz, Deezer, iTunes o Discogs) confirma artista + título con el
//     año ±1. Los no confirmados quedan en lista. Al crearse, adoptan los claims
//     `candidate` que la etapa 1 dejó con identity_key
//     `lote-2026-10-02:album:<lote_id>:<índice>` (solo rellenan vacíos).
//   · Lo que ya está en el catálogo (mismo título normalizado, o variante
//     probable) no se crea; las variantes van al informe.
//
// Cada disco nace por el motor (claim de la plataforma con su URL de
// evidencia, decisión humana «different» porque la duplicidad ya se comprobó
// arriba) y luego recibe año y tipo como claims de campo. El año de Deezer solo
// se usa si cae dentro de la vida del artista (sus fechas digitales suelen ser
// de la reedición). Las pistas, portadas y sellos son de la etapa 4.
//
//   ./scripts/with-node22.sh npx tsx scripts/lote-etapa3-discos.ts [--confirm] [--only=lote_id,…]
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import type { PoolClient } from "pg";
import { persistClaim, type ClaimToPersist } from "../src/claims/persistence.js";
import { closeDb, getPool } from "../src/db/client.js";
import { compareKey, loteFileSchema, sameTitle, yearOf as loteYearOf, type LoteArtist } from "../src/ingest/lote-investigacion.js";
import { mergeClaim } from "../src/merge/engine.js";
import { COMPOSERS_ONLY, titleKey, variantOf, type DeezerAlbum, type ReleaseGroup } from "./lote-etapa3-comun.js";

loadDotenv();
const DESKTOP = path.join(os.homedir(), "Desktop");
const OUT_DIR = "reports/nuevo-lote-2026-10-02";
const HARVEST_FILE = `${OUT_DIR}/etapa3-cosecha.json`;
const CACHE_DIR = "data/raw/etapa3-discografias";
const USER_AGENT = "CRV-discografias/1.0 (+coleccionistasderockvenezolano.com)";
const OPERATOR = "claude-code (delegado por Brian)";
const NOTE = "Nuevo lote 2026-10-02, etapa 3: discografía desde MusicBrainz y Deezer; discos del lote confirmados por una segunda fuente (decisión 4 de Brian, plan §2 y §3)";
const LOTE_SOURCE_SLUG = "lote-investigacion-2026-10-02";
const LOTES = [
  { key: "lote1", file: path.join(DESKTOP, "Nuevo lote/catalogo_artistas_venezolanos_generos_2026-10-02.json") },
  { key: "lote2", file: path.join(DESKTOP, "Nuevo lote 2/catalogo_artistas_venezolanos_generos_faltantes_2026-10-02.json") },
] as const;

const CONFIRM = process.argv.includes("--confirm");
const ONLY = process.argv.find((arg) => arg.startsWith("--only="))?.slice("--only=".length).split(",");

type Platform = "musicbrainz" | "deezer" | "itunes" | "discogs";
const SOURCES: Record<Platform, { slug: string; name: string; notes: string }> = {
  musicbrainz: { slug: "musicbrainz", name: "MusicBrainz (API)", notes: "Discografías por artista (release-groups) vía la API pública, con la identidad del artista verificada por títulos en común o país. Etapa 3 del nuevo lote 2026-10-02: scripts/lote-etapa3-cosecha.ts." },
  deezer: { slug: "deezer", name: "Deezer (API)", notes: "Discografías por artista vía la API pública. Deezer junta homónimos: solo entra lo anclado por título o sello. Etapa 3 del nuevo lote 2026-10-02: scripts/lote-etapa3-cosecha.ts." },
  itunes: { slug: "itunes", name: "iTunes Search (API)", notes: "Confirmación de discos (artista + título + año) vía la API de búsqueda. Etapa 3 del nuevo lote 2026-10-02." },
  discogs: { slug: "discogs", name: "Discogs (API)", notes: "Confirmación de discos (artista + título + año) vía la API de búsqueda. Etapa 3 del nuevo lote 2026-10-02." },
};

// --- Cosecha -------------------------------------------------------------------

interface HarvestArtist {
  lote: string; loteId: string; name: string; artistId: number; artistName: string; aliases: string[]; knownTitles: string[]; loteTitles: string[];
  musicbrainz: { status: string; why: string; mbid?: string; name?: string; releaseGroups?: ReleaseGroup[] };
  deezer: { status: string; why: string; deezerId?: number; name?: string; albums?: DeezerAlbum[] };
}

// --- Tipos y años --------------------------------------------------------------

/** Lo que no es un disco del artista: entrevistas, audiolibros, radioteatro. */
const NOT_A_RECORD = new Set(["Interview", "Audiobook", "Audio drama", "Spokenword"]);

function mbType(group: ReleaseGroup): string {
  const secondary = group.secondaryTypes;
  if (secondary.includes("Compilation") || secondary.includes("DJ-mix") || secondary.includes("Mixtape/Street")) return "compilation";
  if (secondary.includes("Live")) return "live_album";
  if (secondary.includes("Soundtrack")) return "soundtrack";
  if (secondary.includes("Remix")) return "remix";
  if (secondary.includes("Demo")) return "demo";
  if (group.primaryType === "Album") return group.soleArtist ? "studio_album" : "collaboration_album";
  if (group.primaryType === "EP") return "ep";
  if (group.primaryType === "Single") return "single";
  return "other";
}

/** Deezer marca «album» también recopilaciones y reediciones: solo se fían single, EP y compile. */
function deezerType(album: DeezerAlbum): string {
  if (album.recordType === "single") return "single";
  if (album.recordType === "ep") return "ep";
  if (album.recordType === "compile") return "compilation";
  return "other";
}

const yearOf = (date: string | null | undefined): number | null => {
  const year = Number(String(date ?? "").slice(0, 4));
  return Number.isInteger(year) && year >= 1900 && year <= 2027 ? year : null;
};

// --- Catálogo --------------------------------------------------------------------

/** Variante probable: un título contiene al otro (con sustancia) o difieren en un carácter o dos. */
/** Años en los que el artista pudo publicar: de su formación a su disolución o la muerte de su titular. */
async function lifeSpan(client: PoolClient, artistId: number, lote: LoteArtist | undefined): Promise<{ from: number | null; to: number | null }> {
  const artist = (await client.query<{ formed_year: number | null; disbanded_year: number | null; artist_type: string }>(
    "SELECT formed_year, disbanded_year, artist_type::text FROM public.artists WHERE id=$1", [artistId])).rows[0]!;
  let to = artist.disbanded_year;
  if (to === null && artist.artist_type !== "band") {
    const dead = await client.query<{ alive: string; dead: string; last: number | null }>(`
      SELECT count(*) FILTER (WHERE p.death_date IS NULL)::text AS alive, count(*) FILTER (WHERE p.death_date IS NOT NULL)::text AS dead,
             max(extract(year FROM p.death_date))::int AS last
        FROM public.artist_members m JOIN public.persons p ON p.id=m.person_id
       WHERE m.artist_id=$1 AND m.role ILIKE 'titular%'`, [artistId]);
    const row = dead.rows[0]!;
    if (Number(row.dead) > 0 && Number(row.alive) === 0) to = row.last;
    // Las fichas que ya existían no tienen titular: la muerte la da el lote.
    const died = loteYearOf(lote?.death?.date ?? null);
    if (to === null && died !== null && lote?.entity_type === "solo") to = died;
  }
  return { from: artist.formed_year, to };
}

// --- Confirmación por iTunes y Discogs (discos del lote sin par en la cosecha) -------

const lastCall: Record<string, number> = {};
async function cachedJson<T>(service: "itunes" | "discogs", url: string, headers: Record<string, string> = {}): Promise<T | null> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `${service}-${createHash("sha1").update(url).digest("hex")}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as T;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const wait = (lastCall[service] ?? 0) + (service === "itunes" ? 3_100 : 1_100) - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCall[service] = Date.now();
    const response = await fetch(url, { headers: { "user-agent": USER_AGENT, ...headers }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (!response || [403, 429, 500, 502, 503].includes(response.status)) { await new Promise((resolve) => setTimeout(resolve, 10_000 * (attempt + 1))); continue; }
    if (!response.ok) return null;
    const body = (await response.json()) as T;
    writeFileSync(file, JSON.stringify(body));
    return body;
  }
  return null;
}

interface External { platform: Platform; id: string; title: string; year: number | null; type: string; url: string; credit: string }

async function itunesMatch(names: string[], title: string): Promise<External[]> {
  const url = `https://itunes.apple.com/search?${new URLSearchParams({ term: `${names[0]} ${title}`, media: "music", entity: "album", limit: "25", country: "VE" })}`;
  const body = await cachedJson<{ results?: Array<{ collectionId: number; collectionName: string; artistName: string; releaseDate?: string; collectionViewUrl?: string; collectionType?: string }> }>("itunes", url);
  const keys = names.map(compareKey);
  return (body?.results ?? [])
    .filter((row) => keys.includes(compareKey(row.artistName)) && titleKey(row.collectionName) === titleKey(title))
    .map((row) => ({
      platform: "itunes" as const, id: String(row.collectionId), title: row.collectionName.replace(/\s+-\s+(Single|EP)$/, ""), year: yearOf(row.releaseDate),
      type: / - Single$/.test(row.collectionName) ? "single" : / - EP$/.test(row.collectionName) ? "ep" : "other",
      url: row.collectionViewUrl ?? `https://music.apple.com/album/${row.collectionId}`, credit: row.artistName,
    }));
}

async function discogsMatch(names: string[], title: string): Promise<External[]> {
  const token = process.env["DISCOGS_TOKEN"]?.trim();
  if (!token) return [];
  const url = `https://api.discogs.com/database/search?${new URLSearchParams({ artist: names[0]!, release_title: title, type: "master", per_page: "25" })}`;
  let body = await cachedJson<{ results?: Array<{ id: number; title: string; year?: string; uri?: string }> }>("discogs", url, { authorization: `Discogs token=${token}` });
  if (!body?.results?.length) {
    body = await cachedJson("discogs", url.replace("type=master", "type=release"), { authorization: `Discogs token=${token}` });
  }
  const keys = names.map(compareKey);
  return (body?.results ?? []).flatMap((row) => {
    // Discogs titula «Artista - Título»; los homónimos llevan «(2)».
    const [artist, ...rest] = row.title.split(" - ");
    const clean = (artist ?? "").replace(/\s*\(\d+\)$/, "").replace(/\*$/, "");
    if (!keys.includes(compareKey(clean)) || titleKey(rest.join(" - ")) !== titleKey(title)) return [];
    return [{
      platform: "discogs" as const, id: String(row.id), title: rest.join(" - "), year: yearOf(row.year), type: "other",
      url: `https://www.discogs.com${row.uri ?? ""}`, credit: clean,
    }];
  });
}

// --- Escritura -----------------------------------------------------------------

interface Context { client: PoolClient; runId: number; sourceIds: Record<Platform, number>; loteSourceId: number }
function platformClaim(context: Context, external: External, input: { field: string; value: unknown; albumId?: number; parentArtistId?: number }): ClaimToPersist {
  const identity = `etapa3:${external.platform}:${external.id}`;
  return {
    entityKind: "album",
    identity, identitySecondary: identity, originalIdentity: `${external.credit} — ${external.title}`,
    field: input.field, rawValue: input.value, normalizedValue: input.value,
    rawHash: createHash("sha256").update(JSON.stringify([identity, input.field, input.value])).digest("hex"),
    extractor: `etapa3-${external.platform}`, extractorVersion: "1",
    evidence: { url: external.url, excerpt: `${external.credit} — ${external.title}${external.year ? ` (${external.year})` : ""}; ${external.platform} ${external.type}`.slice(0, 1000) },
    sourceId: context.sourceIds[external.platform], runId: context.runId, confidence: "medium",
    // La creación la habilita la decisión de Brian (plan §2.4–2.5), aplicada por el operador.
    createdBy: "human",
    ...(input.albumId === undefined ? {} : { albumId: input.albumId }),
    ...(input.parentArtistId === undefined ? {} : { parentArtistId: input.parentArtistId }),
  } as ClaimToPersist;
}

async function createAlbum(context: Context, artistId: number, primary: External, others: External[], fields: { year: number | null; type: string }): Promise<number> {
  const claim = platformClaim(context, primary, { field: "title", value: primary.title, parentArtistId: artistId });
  const persisted = await persistClaim(claim, context.client);
  const outcome = await mergeClaim(claim, persisted, {
    client: context.client,
    humanResolution: { verdict: "different", decidedBy: OPERATOR, reference: "etapa 3 del nuevo lote: el título no está en la discografía de la ficha" },
  });
  if (!outcome.created || outcome.entityId === undefined) throw new Error(`no se creó «${primary.title}» (artista ${artistId}): ${outcome.action} ${outcome.detail}`);
  const albumId = outcome.entityId;
  for (const external of [primary, ...others]) {
    if (external !== primary) await field(context, external, albumId, "title", external.title);
    if (fields.year !== null && external.year === fields.year) await field(context, external, albumId, "release_year", fields.year);
    if (external.type !== "other" && external.type === fields.type) await field(context, external, albumId, "album_type", fields.type);
  }
  return albumId;
}

async function field(context: Context, external: External, albumId: number, name: string, value: unknown): Promise<void> {
  const claim = platformClaim(context, external, { field: name, value, albumId });
  const persisted = await persistClaim(claim, context.client);
  await mergeClaim(claim, persisted, { client: context.client });
}

/** Claims `candidate` del lote para un disco: se enganchan al creado y rellenan vacíos. */
async function adoptLote(context: Context, loteId: string, index: number, albumId: number): Promise<Record<string, string>> {
  const { rows } = await context.client.query<{ id: string; field: string; value: unknown; raw: unknown }>(`
    SELECT id::text, field, normalized_value AS value, raw_value AS raw FROM ingest.claims
     WHERE source_id=$1 AND entity_kind='album' AND identity_key=$2 AND album_id IS NULL AND status='candidate'`,
  [context.loteSourceId, `lote-2026-10-02:album:${loteId}:${index}`]);
  const result: Record<string, string> = {};
  for (const row of rows) {
    const current = (await context.client.query<{ value: string | null }>(
      `SELECT ${row.field === "title" ? "title" : row.field === "release_year" ? "release_year::text" : "album_type::text"} AS value FROM public.albums WHERE id=$1`, [albumId])).rows[0]?.value ?? null;
    let status: "accepted" | "conflict" | "candidate" = "accepted";
    let write = false;
    if (row.field === "title") status = sameTitle(String(row.value), String(current)) ? "accepted" : "conflict";
    else if (row.field === "release_year") {
      if (current === null) write = true;
      else status = Math.abs(Number(current) - Number(row.value)) <= 1 ? "accepted" : "conflict";
    } else if (row.field === "album_type") {
      // El «album» genérico del lote no rellena el tipo (regla de la etapa 1): queda candidate.
      if (String(row.raw).trim().toLowerCase() === "album") status = current === row.value ? "accepted" : "candidate";
      else if (current === "other") write = row.value !== "other";
      else status = current === row.value ? "accepted" : "conflict";
    } else continue;
    await context.client.query(
      "UPDATE ingest.claims SET album_id=$2, status=$3::ingest.claim_status, updated_at=now(), notes=concat_ws(' · ', notes, $4::text) WHERE id=$1",
      [row.id, albumId, status, `enganchado en la etapa 3 (run ${context.runId})`]);
    if (write) {
      await context.client.query(`UPDATE public.albums SET ${row.field}=$2${row.field === "album_type" ? "::album_type" : ""}, updated_at=now() WHERE id=$1`, [albumId, row.value]);
      const audit = await context.client.query<{ id: string }>(`
        INSERT INTO ingest.merge_audit(run_id,entity_kind,album_id,field,old_value,new_value,reason,confidence,performed_by)
        VALUES($1,'album',$2,$3,$4::jsonb,$5::jsonb,$6,'medium','system') RETURNING id::text`,
      [context.runId, albumId, row.field, JSON.stringify(current), JSON.stringify(row.value), "Lote de investigación 2026-10-02: rellena un campo vacío del disco creado en la etapa 3"]);
      await context.client.query("INSERT INTO ingest.merge_audit_claims(merge_audit_id,claim_id) VALUES($1,$2)", [audit.rows[0]!.id, row.id]);
    }
    result[row.field] = write ? "rellenado" : status;
  }
  return result;
}

// --- Plan por artista -----------------------------------------------------------

interface Group { key: string; members: External[]; anchored: string | null }
interface Created { artistId: number; artist: string; albumId: number | null; title: string; year: number | null; type: string; sources: string[]; lote: string | null }
interface Listed { loteId: string; artistId: number; artist: string; title: string; year: number | null; why: string; seenIn?: string }

const report = {
  mode: CONFIRM ? "confirm" : "dry-run",
  runId: 0,
  artists: [] as Array<Record<string, unknown>>,
  created: [] as Created[],
  variants: [] as Array<{ artistId: number; artist: string; external: string; core: string; coreId: number; source: string }>,
  loteUnconfirmed: [] as Listed[],
  loteYearMismatch: [] as Listed[],
  deezerUnanchored: [] as Array<{ artistId: number; artist: string; title: string; year: number | null; type: string | null; label: string | null; url: string }>,
  skipped: [] as Array<{ loteId: string; why: string }>,
  noIdentity: [] as Array<{ loteId: string; artistId: number; artist: string; musicbrainz: string; deezer: string }>,
  fieldMismatches: [] as Array<{ albumId: number; title: string; planned: unknown; stored: unknown }>,
  totals: {} as Record<string, number>,
};
const bump = (key: string, by = 1) => { report.totals[key] = (report.totals[key] ?? 0) + by; };

const normLabel = (label: string | null) => label ? compareKey(label).replace(/\b(records|record|music|musica|discos|distribuidora|entertainment|ltd|inc|s a|c a|ca|sa)\b/g, "").replace(/\s+/g, " ").trim() : "";

async function planArtist(context: Context, artist: HarvestArtist, lote: LoteArtist | undefined): Promise<void> {
  const { client } = context;
  const core = (await client.query<{ id: string; title: string; year: number | null; type: string }>(
    "SELECT id::text, title, release_year AS year, album_type::text AS type FROM public.albums WHERE artist_id=$1", [artist.artistId]))
    .rows.map((row) => ({ id: Number(row.id), title: row.title, year: row.year, type: row.type }));
  const coreKeys = new Map(core.map((album) => [titleKey(album.title), album]));
  const span = await lifeSpan(client, artist.artistId, lote);
  const plausible = (year: number | null) => year !== null && (span.to === null || year <= span.to + 1) && (span.from === null || year >= span.from - 1);

  const groups = new Map<string, Group>();
  const add = (external: External) => {
    const key = titleKey(external.title);
    if (!key) return;
    const group = groups.get(key) ?? { key, members: [], anchored: null };
    group.members.push(external);
    groups.set(key, group);
  };
  for (const group of artist.musicbrainz.releaseGroups ?? []) {
    if (group.secondaryTypes.some((type) => NOT_A_RECORD.has(type))) continue;
    add({ platform: "musicbrainz", id: group.id, title: group.title, year: yearOf(group.date), type: mbType(group), url: `https://musicbrainz.org/release-group/${group.id}`, credit: group.credit });
  }
  const deezerAlbums = (artist.deezer.albums ?? []).filter((album) => album.mainArtist);
  for (const album of deezerAlbums) {
    add({ platform: "deezer", id: String(album.id), title: album.title, year: plausible(yearOf(album.date)) ? yearOf(album.date) : null, type: deezerType(album), url: album.link, credit: artist.deezer.name ?? artist.artistName });
  }

  // Anclas: MusicBrainz (identidad verificada, sin homónimos mezclados), un
  // título conocido o el sello de un disco ya anclado.
  const knownKeys = new Set([...artist.knownTitles, ...artist.loteTitles].map(titleKey));
  for (const group of groups.values()) {
    if (group.members.some((member) => member.platform === "musicbrainz")) group.anchored = "musicbrainz";
    else if (knownKeys.has(group.key)) group.anchored = "título conocido";
  }
  const labelOf = new Map(deezerAlbums.map((album) => [String(album.id), normLabel(album.label)]));
  const anchoredLabels = new Set<string>();
  for (const group of groups.values()) {
    if (!group.anchored) continue;
    for (const member of group.members) if (member.platform === "deezer" && labelOf.get(member.id)) anchoredLabels.add(labelOf.get(member.id)!);
  }
  for (const group of groups.values()) {
    if (group.anchored) continue;
    const label = group.members.map((member) => labelOf.get(member.id)).find((value) => value && anchoredLabels.has(value));
    if (label) group.anchored = `sello «${label}»`;
  }

  // Discos del lote: confirmación por segunda fuente con el año ±1.
  const loteIndexByKey = new Map<string, { index: number; title: string; year: number | null }>();
  const loteOutcomes: Record<string, number> = {};
  for (const [index, release] of (lote?.discography ?? []).entries()) {
    const key = titleKey(release.title);
    const year = typeof release.year === "number" ? release.year : loteYearOf(release.year == null ? null : String(release.year));
    if (coreKeys.has(key)) { loteOutcomes["ya en catálogo"] = (loteOutcomes["ya en catálogo"] ?? 0) + 1; continue; }
    let group = groups.get(key);
    let confirmed = group?.members.some((member) => year === null || member.year === null || Math.abs(member.year - year) <= 1) ?? false;
    if (!group || !confirmed) {
      const extra = [...await itunesMatch(artist.aliases, release.title), ...await discogsMatch(artist.aliases, release.title)]
        .filter((external) => year === null || external.year === null || Math.abs(external.year - year) <= 1);
      if (extra.length) {
        const target = group ?? { key, members: [], anchored: null };
        target.members.push(...extra);
        groups.set(key, target);
        group = target;
        confirmed = true;
      }
    }
    if (group && confirmed) {
      group.anchored ??= "disco del lote confirmado";
      loteIndexByKey.set(key, { index, title: release.title, year });
      loteOutcomes["confirmado"] = (loteOutcomes["confirmado"] ?? 0) + 1;
    } else if (group) {
      const seen = group.members.map((member) => `${member.platform} ${member.year ?? "s/a"}`).join(", ");
      report.loteYearMismatch.push({ loteId: artist.loteId, artistId: artist.artistId, artist: artist.artistName, title: release.title, year, why: "título encontrado con otro año", seenIn: seen });
      loteOutcomes["año distinto"] = (loteOutcomes["año distinto"] ?? 0) + 1;
    } else {
      report.loteUnconfirmed.push({ loteId: artist.loteId, artistId: artist.artistId, artist: artist.artistName, title: release.title, year, why: "sin segunda fuente" });
      loteOutcomes["sin confirmar"] = (loteOutcomes["sin confirmar"] ?? 0) + 1;
    }
  }

  const counts: Record<string, number> = {};
  const count = (key: string) => { counts[key] = (counts[key] ?? 0) + 1; bump(key); };
  for (const group of groups.values()) {
    if (!group.anchored) {
      for (const member of group.members.filter((row) => row.platform === "deezer")) {
        const album = deezerAlbums.find((row) => String(row.id) === member.id)!;
        report.deezerUnanchored.push({ artistId: artist.artistId, artist: artist.artistName, title: album.title, year: yearOf(album.date), type: album.recordType, label: album.label, url: album.link });
      }
      count("deezer sin ancla");
      continue;
    }
    if (coreKeys.has(group.key)) { count("ya en catálogo"); continue; }
    const variant = variantOf(group.key, core);
    if (variant) {
      report.variants.push({ artistId: artist.artistId, artist: artist.artistName, external: group.members[0]!.title, core: variant.title, coreId: variant.id, source: group.members[0]!.url });
      count("variante probable");
      continue;
    }
    // Título: el de MusicBrainz si lo hay; si no, el de la primera plataforma.
    const order: Platform[] = ["musicbrainz", "deezer", "itunes", "discogs"];
    const members = [...group.members].sort((a, b) => order.indexOf(a.platform) - order.indexOf(b.platform));
    const primary = members[0]!;
    const years = members.map((member) => member.year).filter((year): year is number => year !== null);
    const mbYears = members.filter((member) => member.platform === "musicbrainz" && member.year !== null).map((member) => member.year!);
    const year = mbYears.length ? Math.min(...mbYears) : years.length ? Math.min(...years) : null;
    const type = members.find((member) => member.type !== "other")?.type ?? "other";
    const loteMatch = loteIndexByKey.get(group.key);
    let lote: string | null = null;
    // Una variante con otro título dentro del mismo grupo cuenta como el mismo disco.
    const others = members.slice(1).filter((member) => !(member.platform === primary.platform && member.id === primary.id));
    const albumId = await createAlbum(context, artist.artistId, primary, dedupeById(others), { year, type });
    if (loteMatch) lote = JSON.stringify(await adoptLote(context, artist.loteId, loteMatch.index, albumId));
    // Lo que de verdad quedó en el core (el motor puede no aplicar un campo).
    const stored = (await client.query<{ year: number | null; type: string }>(
      "SELECT release_year AS year, album_type::text AS type FROM public.albums WHERE id=$1", [albumId])).rows[0]!;
    if (!loteMatch && (stored.year !== year || stored.type !== type)) report.fieldMismatches.push({ albumId, title: primary.title, planned: { year, type }, stored });
    core.push({ id: albumId, title: primary.title, year: stored.year, type: stored.type });
    coreKeys.set(group.key, core[core.length - 1]!);
    report.created.push({ artistId: artist.artistId, artist: artist.artistName, albumId, title: primary.title, year: stored.year, type: stored.type, sources: [...new Set(members.map((member) => member.platform))], lote });
    count("creado");
    count(`creado:${type}`);
  }
  report.artists.push({
    loteId: artist.loteId, artistId: artist.artistId, artist: artist.artistName,
    musicbrainz: artist.musicbrainz.status, deezer: artist.deezer.status, catalogo: core.length - (counts["creado"] ?? 0),
    ...counts, lote: loteOutcomes,
  });
}

function dedupeById(rows: External[]): External[] {
  const seen = new Set<string>();
  return rows.filter((row) => { const key = `${row.platform}:${row.id}`; if (seen.has(key)) return false; seen.add(key); return true; });
}

// --- Principal ---------------------------------------------------------------

async function main(): Promise<void> {
  const harvest = JSON.parse(readFileSync(HARVEST_FILE, "utf8")) as { harvestedAt: string; skipped: Array<{ loteId: string; why: string }>; artists: HarvestArtist[] };
  report.skipped = harvest.skipped;
  const loteArtists = new Map<string, LoteArtist>();
  for (const lote of LOTES) for (const artist of loteFileSchema.parse(JSON.parse(readFileSync(lote.file, "utf8"))).artists) loteArtists.set(artist.id, artist);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('merge:duplicates'))");
    const sourceIds = {} as Record<Platform, number>;
    for (const [platform, source] of Object.entries(SOURCES) as Array<[Platform, typeof SOURCES[Platform]]>) {
      await client.query(`
        INSERT INTO ingest.sources(slug,name,site_type,trust_level,enabled,notes) VALUES($1,$2,'database','medium',false,$3)
        ON CONFLICT (slug) DO NOTHING`, [source.slug, source.name, source.notes]);
      sourceIds[platform] = Number((await client.query<{ id: string }>("SELECT id::text FROM ingest.sources WHERE slug=$1", [source.slug])).rows[0]!.id);
    }
    const loteSourceId = Number((await client.query<{ id: string }>("SELECT id::text FROM ingest.sources WHERE slug=$1", [LOTE_SOURCE_SLUG])).rows[0]!.id);
    const run = await client.query<{ id: string }>(
      "INSERT INTO ingest.scrape_runs(kind,source_id,status,params) VALUES('manual',$1,'running',$2::jsonb) RETURNING id::text",
      [sourceIds.musicbrainz, JSON.stringify({ action: "lote_etapa3_discos", operator: OPERATOR, note: NOTE, stage: 3, confirm: CONFIRM, harvest: HARVEST_FILE, harvestedAt: harvest.harvestedAt })]);
    report.runId = Number(run.rows[0]!.id);
    const context: Context = { client, runId: report.runId, sourceIds, loteSourceId };

    for (const artist of harvest.artists) {
      if (ONLY && !ONLY.includes(artist.loteId)) continue;
      if (COMPOSERS_ONLY.has(artist.loteId)) continue;
      if (artist.musicbrainz.status !== "ok" && artist.deezer.status !== "ok") {
        report.noIdentity.push({ loteId: artist.loteId, artistId: artist.artistId, artist: artist.artistName, musicbrainz: `${artist.musicbrainz.status}: ${artist.musicbrainz.why}`, deezer: `${artist.deezer.status}: ${artist.deezer.why}` });
      }
      await client.query("SAVEPOINT artista");
      try {
        await planArtist(context, artist, loteArtists.get(artist.loteId));
        await client.query("RELEASE SAVEPOINT artista");
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT artista");
        console.error(`ERROR ${artist.loteId}: ${(error as Error).message}`);
        report.artists.push({ loteId: artist.loteId, artistId: artist.artistId, artist: artist.artistName, error: (error as Error).message });
        bump("errores");
      }
      const last = report.artists[report.artists.length - 1]!;
      console.log(JSON.stringify(last));
    }
    await client.query("UPDATE ingest.scrape_runs SET status='ok', finished_at=now(), counters=$2::jsonb WHERE id=$1", [report.runId, JSON.stringify(report.totals)]);
    await client.query(CONFIRM ? "COMMIT" : "ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  writeReports();
}

function writeReports(): void {
  const base = `${OUT_DIR}/etapa3-${CONFIRM ? "confirm" : "dry-run"}-run${report.runId}`;
  writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 1)}\n`);
  const lines: string[] = [
    `# Etapa 3 — discos (${report.mode}, run ${report.runId})`, "",
    `Fuente de la cosecha: \`${HARVEST_FILE}\`. Plan: ~/Desktop/PLAN_NUEVO_LOTE_2026-10-02.md §3.`, "",
    "## Totales", "",
    ...Object.entries(report.totals).sort().map(([key, value]) => `- ${key}: ${value}`), "",
    `- Fichas sin cosechar (compositores u otras): ${report.skipped.length}`,
    `- Fichas sin identidad en MusicBrainz ni Deezer: ${report.noIdentity.length}`,
    `- Discos del lote sin segunda fuente: ${report.loteUnconfirmed.length}`,
    `- Discos del lote hallados con otro año: ${report.loteYearMismatch.length}`,
    `- Discos de Deezer sin ancla (posibles homónimos): ${report.deezerUnanchored.length}`,
    `- Variantes probables de discos ya catalogados: ${report.variants.length}`, "",
    "## Por artista", "",
    "| Lote | Artista | MB | Deezer | En catálogo | Creados | Variantes | Deezer sin ancla | Lote |",
    "|---|---|---|---|---|---|---|---|---|",
    ...report.artists.map((row) => `| ${row["loteId"]} | ${row["artist"]} (${row["artistId"]}) | ${row["musicbrainz"] ?? ""} | ${row["deezer"] ?? ""} | ${row["catalogo"] ?? ""} | ${row["creado"] ?? 0} | ${row["variante probable"] ?? 0} | ${row["deezer sin ancla"] ?? 0} | ${row["error"] ? `ERROR ${row["error"]}` : Object.entries((row["lote"] as Record<string, number>) ?? {}).map(([k, v]) => `${k} ${v}`).join(", ")} |`), "",
    "## Discos del lote sin segunda fuente (no se crean)", "",
    ...report.loteUnconfirmed.map((row) => `- ${row.artist} (${row.artistId}) — «${row.title}»${row.year ? ` (${row.year})` : ""}`), "",
    "## Discos del lote hallados con otro año (no confirmados; la plataforma los trae por su cuenta)", "",
    ...report.loteYearMismatch.map((row) => `- ${row.artist} (${row.artistId}) — «${row.title}» (${row.year ?? "s/a"}) · visto en ${row.seenIn}`), "",
    "## Variantes probables (no se crean)", "",
    ...report.variants.map((row) => `- ${row.artist} (${row.artistId}) — «${row.external}» ≈ «${row.core}» (${row.coreId}) · ${row.source}`), "",
    "## Fichas sin identidad en las plataformas", "",
    ...report.noIdentity.map((row) => `- ${row.artist} (${row.artistId}, ${row.loteId}) — MB ${row.musicbrainz}; Deezer ${row.deezer}`), "",
    "## Fichas no cosechadas", "",
    ...report.skipped.map((row) => `- ${row.loteId}: ${row.why}`), "",
    "## Deezer sin ancla (no se crean: posibles homónimos)", "",
    ...report.deezerUnanchored.map((row) => `- ${row.artist} (${row.artistId}) — «${row.title}» (${row.year ?? "s/a"}, ${row.type ?? "?"}, ${row.label ?? "sin sello"}) ${row.url}`), "",
  ];
  writeFileSync(`${base}.md`, `${lines.join("\n")}\n`);
  console.log(`→ ${base}.md`);
  console.log(JSON.stringify(report.totals));
}

main().finally(() => closeDb()).catch((error) => { console.error(error); process.exitCode = 1; });
