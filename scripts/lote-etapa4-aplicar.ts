// CRV · Etapa 4 del nuevo lote (plan ~/Desktop/PLAN_NUEVO_LOTE_2026-10-02.md §3):
// aplica la cosecha de scripts/lote-etapa4-cosecha.ts, UN run reversible por
// bloque (`crv runs undo <run>`). Solo rellena vacíos; nunca pisa.
//
//   · pistas:   discos SIN pistas reciben la lista de una plataforma
//               (MusicBrainz > Deezer > iTunes > Discogs > búsqueda en iTunes);
//               la duración que falte en esa lista sale de otra lista del mismo
//               disco con el mismo título de pista (único a ambos lados).
//               Discos CON pistas sin duración: duración por título normalizado,
//               único a ambos lados, con dos pistas en común como mínimo (una si
//               el disco tiene una sola), nunca por posición.
//   · portadas: cover_url remoto (Cover Art Archive > Deezer > iTunes > Discogs);
//               después `npm run media:localize` la descarga y la sustituye.
//   · sellos:   label_id desde MusicBrainz o Discogs. El sello se reconoce por
//               nombre normalizado (o alias) entre las organizaciones; si no
//               existe, lo crea el motor como `record_label`.
//   · fotos:    picture_url del artista (Wikidata > Discogs > Deezer).
//
// Cada dato entra como claim de su plataforma con la URL de la página como
// evidencia y pasa por el motor (mergeClaim), en tandas de 50 discos con su
// propia transacción, todas del mismo run. Sin --confirm cada tanda se deshace
// (el run queda con confirm=false y sin escrituras); el informe lleva una
// muestra de 40 para revisar antes de confirmar.
//
//   ./scripts/with-node22.sh npx tsx scripts/lote-etapa4-aplicar.ts --block=pistas|portadas|sellos|fotos [--confirm] [--exclude=albumId,…]
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { PoolClient } from "pg";
import { persistClaim, type ClaimToPersist } from "../src/claims/persistence.js";
import { closeDb, getPool } from "../src/db/client.js";
import { bindRun } from "../src/db/run-binding.js";
import { compareKey } from "../src/ingest/lote-investigacion.js";
import { mergeClaim } from "../src/merge/engine.js";
import { bareTitle } from "./lib/store-api.js";
import type { AlbumHarvest, ArtistHarvest, Cover, HarvestTrack, Label, PhotoHarvest, Tracklist } from "./lote-etapa4-cosecha.js";

const OUT_DIR = "reports/nuevo-lote-2026-10-02";
const HARVEST_FILE = `${OUT_DIR}/etapa4-cosecha.json`;
const OPERATOR = "claude-code (delegado por Brian)";
const BLOCKS = ["pistas", "portadas", "sellos", "fotos"] as const;
type Block = typeof BLOCKS[number];
const BLOCK = process.argv.find((arg) => arg.startsWith("--block="))?.slice("--block=".length) as Block | undefined;
if (!BLOCK || !BLOCKS.includes(BLOCK)) throw new Error(`--block=${BLOCKS.join("|")}`);
const CONFIRM = process.argv.includes("--confirm");
const EXCLUDE = new Set((process.argv.find((arg) => arg.startsWith("--exclude="))?.slice("--exclude=".length) ?? "").split(",").filter(Boolean).map(Number));
const SAMPLE = 40;
const CHUNK = 50;

type SourceKey = "musicbrainz" | "deezer" | "itunes" | "discogs" | "wikidata";
const SOURCES: Record<SourceKey, { slug: string; name: string; notes: string }> = {
  musicbrainz: { slug: "musicbrainz", name: "MusicBrainz (API)", notes: "" },
  deezer: { slug: "deezer", name: "Deezer (API)", notes: "" },
  itunes: { slug: "itunes", name: "iTunes Search (API)", notes: "" },
  discogs: { slug: "discogs", name: "Discogs (API)", notes: "" },
  wikidata: { slug: "wikidata-api", name: "Wikidata (API)", notes: "Imágenes P18 (Wikimedia Commons) de fichas enlazadas desde MusicBrainz. Etapa 4 del nuevo lote 2026-10-02: scripts/lote-etapa4-cosecha.ts." },
};
const sourceOf = (platform: string): SourceKey => (platform === "itunes-busqueda" ? "itunes" : platform) as SourceKey;
const NOTES: Record<Block, string> = {
  pistas: "Nuevo lote 2026-10-02, etapa 4: listas de pistas y duraciones desde MusicBrainz, Deezer, iTunes y Discogs (solo discos sin pistas o pistas sin duración)",
  portadas: "Nuevo lote 2026-10-02, etapa 4: portadas desde Cover Art Archive, Deezer, iTunes y Discogs (solo discos sin portada)",
  sellos: "Nuevo lote 2026-10-02, etapa 4: sellos desde MusicBrainz y Discogs (solo discos sin sello)",
  fotos: "Nuevo lote 2026-10-02, etapa 4: fotos de artista desde Wikidata, Discogs y Deezer (solo fichas sin foto)",
};

// --- Claims ----------------------------------------------------------------------

interface Context { client: PoolClient; runId: number; sourceIds: Record<SourceKey, number> }
interface ClaimInput {
  kind: "album" | "track" | "artist" | "organization"; platform: string; identity: string; label: string;
  field: string; value: unknown; url: string; excerpt: string; targets?: Partial<ClaimToPersist>;
}

function claim(context: Context, input: ClaimInput): ClaimToPersist {
  return {
    entityKind: input.kind,
    identity: input.identity, identitySecondary: input.identity, originalIdentity: input.label,
    field: input.field, rawValue: input.value, normalizedValue: input.value,
    rawHash: createHash("sha256").update(JSON.stringify([input.identity, input.field, input.value, input.targets ?? null])).digest("hex"),
    extractor: `etapa4-${input.platform}`, extractorVersion: "1",
    evidence: { url: input.url, excerpt: input.excerpt.slice(0, 1000) },
    sourceId: context.sourceIds[sourceOf(input.platform)], runId: context.runId, confidence: "medium",
    // La escritura la habilita la decisión de Brian (plan §2.5), aplicada por el operador.
    createdBy: "human",
    ...input.targets,
  } as ClaimToPersist;
}

async function write(context: Context, input: ClaimInput, create = false) {
  const built = claim(context, input);
  const persisted = await persistClaim(built, context.client);
  return mergeClaim(built, persisted, {
    client: context.client,
    ...(create ? { humanResolution: { verdict: "different" as const, decidedBy: OPERATOR, reference: "etapa 4 del nuevo lote: disco sin pistas" } } : {}),
  });
}

// --- Selección ----------------------------------------------------------------------

const TRACK_ORDER = ["musicbrainz", "deezer", "itunes", "discogs", "itunes-busqueda"];
const COVER_ORDER = ["musicbrainz", "deezer", "itunes", "discogs", "itunes-busqueda"];
const PHOTO_ORDER = ["wikidata", "discogs", "deezer"];
const byOrder = <T extends { source: string }>(rows: T[], order: string[]) => [...rows].sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source));

/** Títulos que aparecen una sola vez en la lista (tras normalizar). */
function unique<T>(items: T[], title: (item: T) => string): Map<string, T> {
  const count = new Map<string, number>();
  for (const item of items) count.set(bareTitle(title(item)), (count.get(bareTitle(title(item))) ?? 0) + 1);
  const out = new Map<string, T>();
  for (const item of items) {
    const key = bareTitle(title(item));
    if (key && count.get(key) === 1) out.set(key, item);
  }
  return out;
}

/** La lista que entra: limpia, con posiciones únicas y las duraciones que falten tomadas de otra lista del disco. */
function chooseTracklist(album: AlbumHarvest): { list: Tracklist; tracks: Array<HarvestTrack & { durationFrom?: string }>; problems: string[] } | null {
  const lists = byOrder(album.tracklists, TRACK_ORDER).filter((list) => list.tracks.length > 0 && list.tracks.every((track) => track.title.trim()));
  const list = lists[0];
  if (!list) return null;
  const problems: string[] = [];
  const seen = new Set<string>();
  const tracks: Array<HarvestTrack & { durationFrom?: string }> = [];
  for (const track of list.tracks) {
    let position = track.position;
    while (seen.has(`${track.disc}-${position}`)) position += 1;
    if (position !== track.position) problems.push(`posición ${track.disc}-${track.position} repetida → ${position}`);
    seen.add(`${track.disc}-${position}`);
    tracks.push({ ...track, title: track.title.replace(/\s+/g, " ").trim(), position });
  }
  for (const other of lists.slice(1)) {
    const theirs = unique(other.tracks.filter((track) => track.seconds), (track) => track.title);
    const ours = unique(tracks, (track) => track.title);
    for (const [key, track] of ours) {
      if (track.seconds !== null) continue;
      const match = theirs.get(key);
      if (match) { track.seconds = match.seconds; track.durationFrom = other.source; }
    }
  }
  return { list, tracks, problems };
}

function durationFills(album: AlbumHarvest, current: Array<{ id: number; title: string; seconds: number | null }>) {
  const ours = unique(current, (track) => track.title);
  for (const list of byOrder(album.tracklists, TRACK_ORDER)) {
    const theirs = unique(list.tracks.filter((track) => track.seconds), (track) => track.title);
    const shared = [...ours.keys()].filter((key) => theirs.has(key));
    if (shared.length < Math.min(2, current.length)) continue;
    const fills = shared.map((key) => ({ track: ours.get(key)!, seconds: theirs.get(key)!.seconds!, external: theirs.get(key)!.title }))
      .filter(({ track }) => track.seconds === null);
    if (fills.length) return { list, shared: shared.length, fills };
  }
  return null;
}

// --- Bloques --------------------------------------------------------------------------

interface Row { albumId?: number; artistId?: number; artist: string; title: string; source: string; url: string; detail: string; problems?: string[] }
const report = { block: BLOCK, mode: CONFIRM ? "confirm" : "dry-run", runId: 0, applied: [] as Row[], skipped: [] as Row[], totals: {} as Record<string, number> };
const bump = (key: string, by = 1) => { report.totals[key] = (report.totals[key] ?? 0) + by; };

async function blockTracks(context: Context, albums: AlbumHarvest[]): Promise<void> {
  for (const album of albums) {
    if (EXCLUDE.has(album.albumId) || album.tracklists.length === 0) continue;
    const current = (await context.client.query<{ id: string; title: string; seconds: number | null }>(
      "SELECT id::text, title, duration_seconds AS seconds FROM public.tracks WHERE album_id=$1 ORDER BY disc_number, track_number", [album.albumId]))
      .rows.map((row) => ({ id: Number(row.id), title: row.title, seconds: row.seconds }));
    const base = { albumId: album.albumId, artistId: album.artistId, artist: album.artist, title: album.title };
    if (current.length === 0) {
      const chosen = chooseTracklist(album);
      if (!chosen) { report.skipped.push({ ...base, source: "", url: "", detail: "listas vacías o con títulos vacíos" }); bump("pistas: descartado"); continue; }
      const { list, tracks, problems } = chosen;
      const type = (await context.client.query<{ type: string }>("SELECT album_type::text AS type FROM public.albums WHERE id=$1", [album.albumId])).rows[0]?.type;
      if (type === "single" && tracks.length > 8) {
        report.skipped.push({ ...base, source: list.source, url: list.url, detail: `sencillo con ${tracks.length} pistas en ${list.source}: ¿otro disco del mismo título?` });
        bump("pistas: sencillo con lista larga");
        continue;
      }
      for (const track of tracks) {
        const identity = `etapa4:${list.source}:${list.url}#${track.disc}-${track.position}`;
        const outcome = await write(context, {
          kind: "track", platform: list.source, identity, label: `${album.artist} — ${album.title} — ${track.title}`,
          field: "title", value: track.title, url: list.url,
          excerpt: `${album.artist} — ${list.externalTitle}: ${track.disc}-${track.position} «${track.title}»${track.seconds ? ` (${track.seconds} s)` : ""}; ${list.via}`,
          targets: { parentAlbumId: album.albumId, discNumber: track.disc, trackNumber: track.position },
        }, true);
        if (!outcome.created || outcome.entityId === undefined) throw new Error(`no se creó la pista «${track.title}» del disco ${album.albumId}: ${outcome.action} ${outcome.detail}`);
        if (track.seconds) {
          const from = track.durationFrom ?? list.source;
          const fromList = album.tracklists.find((row) => row.source === from) ?? list;
          await write(context, {
            kind: "track", platform: from, identity, label: track.title, field: "duration_seconds", value: track.seconds, url: fromList.url,
            excerpt: `«${track.title}» ${track.seconds} s (${from})`, targets: { trackId: outcome.entityId },
          });
          bump("pistas: con duración");
        }
        bump("pistas: creadas");
      }
      report.applied.push({ ...base, source: list.source, url: list.url, detail: `${tracks.length} pistas (${list.via})`, problems });
      bump("discos: lista creada");
      bump(`discos: lista de ${list.source}`);
      continue;
    }
    const fills = durationFills(album, current);
    if (!fills) {
      if (current.some((track) => track.seconds === null)) { report.skipped.push({ ...base, source: "", url: "", detail: "duraciones: menos de 2 pistas en común" }); bump("duraciones: sin coincidencia"); }
      continue;
    }
    for (const fill of fills.fills) {
      await write(context, {
        kind: "track", platform: fills.list.source, identity: `etapa4:${fills.list.source}:${fills.list.url}#${bareTitle(fill.track.title)}`, label: fill.track.title,
        field: "duration_seconds", value: fill.seconds, url: fills.list.url,
        excerpt: `«${fill.external}» ${fill.seconds} s en ${fills.list.externalTitle} (${fills.shared} pistas en común)`, targets: { trackId: fill.track.id },
      });
      bump("duraciones: rellenadas");
    }
    report.applied.push({ ...base, source: fills.list.source, url: fills.list.url, detail: `${fills.fills.length} duraciones (${fills.shared} pistas en común)` });
    bump("discos: duraciones");
  }
}

async function blockCovers(context: Context, albums: AlbumHarvest[]): Promise<void> {
  for (const album of albums) {
    if (EXCLUDE.has(album.albumId) || album.covers.length === 0) continue;
    const cover: Cover = byOrder(album.covers, COVER_ORDER)[0]!;
    const outcome = await write(context, {
      kind: "album", platform: cover.source, identity: `etapa4:${cover.source}:${cover.page}`, label: `${album.artist} — ${album.title}`,
      field: "cover_url", value: cover.url, url: cover.page, excerpt: `Portada de ${album.artist} — ${album.title}; ${cover.via}`, targets: { albumId: album.albumId },
    });
    const row = { albumId: album.albumId, artistId: album.artistId, artist: album.artist, title: album.title, source: cover.source, url: cover.url, detail: `${outcome.action} · ${cover.page}` };
    if (outcome.action === "applied") { report.applied.push(row); bump(`portadas: ${cover.source}`); } else { report.skipped.push(row); bump(`portadas: ${outcome.action}`); }
  }
}

const labelKey = (name: string) => compareKey(name).replace(/\b(records|record|recordings|music|musica|discos|disco|ediciones|producciones|entertainment|ltd|inc|s a|c a|ca|sa|srl)\b/g, "").replace(/\s+/g, " ").trim();

async function blockLabels(context: Context, albums: AlbumHarvest[]): Promise<void> {
  const orgs = (await context.client.query<{ id: string; name: string; type: string }>(`
    SELECT o.id::text, o.name, o.organization_type::text AS type FROM public.organizations o
    UNION ALL SELECT a.organization_id::text, a.alias, o.organization_type::text FROM ingest.organization_aliases a JOIN public.organizations o ON o.id=a.organization_id`)).rows;
  const index = new Map<string, Array<{ id: number; type: string }>>();
  for (const org of orgs) {
    for (const key of new Set([compareKey(org.name), labelKey(org.name)])) {
      if (!key) continue;
      const list = index.get(key) ?? [];
      if (!list.some((item) => item.id === Number(org.id))) list.push({ id: Number(org.id), type: org.type });
      index.set(key, list);
    }
  }
  const created = new Map<string, number>();
  // Un sello que el motor manda a revisión va a la cola una sola vez, no una por disco.
  const inReview = new Set<string>();
  for (const album of albums) {
    if (EXCLUDE.has(album.albumId) || album.labels.length === 0) continue;
    const label: Label = album.labels.find((row) => row.source === "musicbrainz") ?? album.labels[0]!;
    const base = { albumId: album.albumId, artistId: album.artistId, artist: album.artist, title: album.title, source: label.source, url: label.url };
    // El sello que lleva el nombre del artista es autoedición: se acepta igual (es el sello impreso).
    const exact = index.get(compareKey(label.name)) ?? [];
    const loose = exact.length ? exact : index.get(labelKey(label.name)) ?? [];
    const labels = loose.filter((org) => org.type === "record_label");
    const pool = labels.length ? labels : loose;
    let orgId: number | null = pool.length === 1 ? pool[0]!.id : created.get(compareKey(label.name)) ?? null;
    let how = pool.length === 1 ? "existente" : "creado";
    if (orgId === null && pool.length > 1) {
      report.skipped.push({ ...base, detail: `«${label.name}»: ${pool.length} organizaciones con ese nombre (${pool.map((org) => org.id).join(", ")})` });
      bump("sellos: ambiguo");
      continue;
    }
    if (orgId === null && inReview.has(compareKey(label.name))) {
      report.skipped.push({ ...base, detail: `«${label.name}»: ya en la cola de revisión de organizaciones` });
      bump("sellos: a revisión");
      continue;
    }
    if (orgId === null) {
      const identity = `etapa4:${label.source}:label:${label.externalId}`;
      const outcome = await write(context, {
        kind: "organization", platform: label.source, identity, label: label.name, field: "name", value: label.name, url: label.url,
        excerpt: `Sello «${label.name}» (${label.source} ${label.externalId}) de ${album.artist} — ${album.title}`,
      });
      if (outcome.entityId === undefined) {
        inReview.add(compareKey(label.name));
        report.skipped.push({ ...base, detail: `«${label.name}»: el motor no lo reconoce ni lo crea (${outcome.action}: ${outcome.detail})` });
        bump("sellos: a revisión");
        continue;
      }
      orgId = outcome.entityId;
      how = outcome.created ? "creado" : "reconocido por el motor";
      if (outcome.created) {
        await write(context, {
          kind: "organization", platform: label.source, identity, label: label.name, field: "organization_type", value: "record_label", url: label.url,
          excerpt: `«${label.name}» es un sello discográfico (${label.source})`, targets: { organizationId: orgId },
        });
        bump("sellos: organizaciones creadas");
      }
      created.set(compareKey(label.name), orgId);
      index.set(compareKey(label.name), [{ id: orgId, type: "record_label" }]);
    }
    const outcome = await write(context, {
      kind: "album", platform: label.source, identity: `etapa4:${label.source}:${label.url}`, label: `${album.artist} — ${album.title}`,
      field: "label_id", value: orgId, url: label.url,
      excerpt: `Sello «${label.name}»${label.catalogNumber ? ` (${label.catalogNumber})` : ""} de ${album.artist} — ${album.title}; ${label.via}`, targets: { albumId: album.albumId },
    });
    const row = { ...base, detail: `«${label.name}» → organización ${orgId} (${how}) · ${outcome.action}` };
    if (outcome.action === "applied") { report.applied.push(row); bump(`sellos: ${label.source}`); } else { report.skipped.push(row); bump(`sellos: ${outcome.action}`); }
  }
}

async function blockPhotos(context: Context, artists: ArtistHarvest[]): Promise<void> {
  for (const artist of artists) {
    if (EXCLUDE.has(artist.artistId) || artist.photos.length === 0) continue;
    const photo: PhotoHarvest = byOrder(artist.photos, PHOTO_ORDER)[0]!;
    const outcome = await write(context, {
      kind: "artist", platform: photo.source, identity: `etapa4:${photo.source}:${photo.page}`, label: artist.artist,
      field: "picture_url", value: photo.url, url: photo.page, excerpt: `Foto de ${artist.artist}; ${photo.via}`, targets: { artistId: artist.artistId },
    });
    const row = { artistId: artist.artistId, artist: artist.artist, title: "", source: photo.source, url: photo.url, detail: `${outcome.action} · ${photo.page}` };
    if (outcome.action === "applied") { report.applied.push(row); bump(`fotos: ${photo.source}`); } else { report.skipped.push(row); bump(`fotos: ${outcome.action}`); }
  }
}

// --- Principal ---------------------------------------------------------------------------

/**
 * Los discos creados en la etapa 3 solo valen con sus ids exactos: lo hallado
 * por título en la discografía de la ficha se descarta (la cosecha anterior a
 * esta regla lo traía).
 */
function exactOnly(album: AlbumHarvest): AlbumHarvest {
  if (!album.refs.some((ref) => ref.via === "creado en la etapa 3")) return album;
  const keep = <T extends { via: string }>(rows: T[]) => rows.filter((row) => !row.via.startsWith("discografía"));
  return { ...album, refs: keep(album.refs), tracklists: keep(album.tracklists), covers: keep(album.covers), labels: keep(album.labels) };
}

async function main(): Promise<void> {
  const harvest = JSON.parse(readFileSync(HARVEST_FILE, "utf8")) as { harvestedAt: string; complete: boolean; albums: AlbumHarvest[]; artists: ArtistHarvest[] };
  // --parcial: ensayo en seco sobre una cosecha a medias (para probar el aplicador mientras cosecha).
  if (!harvest.complete && (CONFIRM || !process.argv.includes("--parcial"))) throw new Error(`${HARVEST_FILE} es parcial: la cosecha no terminó`);
  harvest.albums = harvest.albums.map(exactOnly);
  // El run se abre y se cierra en su propia transacción (en seco queda marcado
  // confirm=false y sin escrituras). Los discos van en tandas de CHUNK, cada una
  // en su transacción ligada al run: el motor toma un bloqueo consultivo por
  // claim y miles de pistas en una sola transacción agotan la tabla de bloqueos.
  const client = await getPool().connect();
  try {
    const sourceIds = {} as Record<SourceKey, number>;
    for (const [key, source] of Object.entries(SOURCES) as Array<[SourceKey, typeof SOURCES[SourceKey]]>) {
      await client.query(`INSERT INTO ingest.sources(slug,name,site_type,trust_level,enabled,notes) VALUES($1,$2,'database','medium',false,$3) ON CONFLICT (slug) DO NOTHING`,
        [source.slug, source.name, source.notes]);
      sourceIds[key] = Number((await client.query<{ id: string }>("SELECT id::text FROM ingest.sources WHERE slug=$1", [source.slug])).rows[0]!.id);
    }
    const run = await client.query<{ id: string }>(
      "INSERT INTO ingest.scrape_runs(kind,source_id,status,params) VALUES('manual',$1,'running',$2::jsonb) RETURNING id::text",
      [sourceIds.musicbrainz, JSON.stringify({ action: `lote_etapa4_${BLOCK}`, operator: OPERATOR, note: NOTES[BLOCK!], stage: 4, confirm: CONFIRM, harvest: HARVEST_FILE, harvestedAt: harvest.harvestedAt, exclude: [...EXCLUDE] })]);
    report.runId = Number(run.rows[0]!.id);
    const context: Context = { client, runId: report.runId, sourceIds };
    const transaction = async (work: () => Promise<void>) => {
      await client.query("BEGIN");
      try {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('merge:duplicates'))");
        await bindRun(client, report.runId);
        await work();
        await client.query(CONFIRM ? "COMMIT" : "ROLLBACK");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    };
    // Un disco que falla se deshace solo; el resto sigue.
    const guarded = async <T extends { albumId?: number; artistId: number }>(items: T[], work: (item: T[]) => Promise<void>, label: (item: T) => string) => {
      for (let start = 0; start < items.length; start += CHUNK) {
        await transaction(async () => {
          for (const item of items.slice(start, start + CHUNK)) {
            await client.query("SAVEPOINT ficha");
            try {
              await work([item]);
              await client.query("RELEASE SAVEPOINT ficha");
            } catch (error) {
              await client.query("ROLLBACK TO SAVEPOINT ficha");
              report.skipped.push({ ...(item.albumId === undefined ? {} : { albumId: item.albumId }), artistId: item.artistId, artist: label(item), title: "", source: "", url: "", detail: `ERROR ${(error as Error).message}` });
              bump("errores");
            }
          }
        });
        if ((start / CHUNK) % 10 === 0) console.log(`${Math.min(start + CHUNK, items.length)}/${items.length} ${JSON.stringify(report.totals)}`);
      }
    };
    try {
      if (BLOCK === "pistas") await guarded(harvest.albums, (rows) => blockTracks(context, rows), (row) => `${row.artist} — ${row.title}`);
      if (BLOCK === "portadas") await guarded(harvest.albums, (rows) => blockCovers(context, rows), (row) => `${row.artist} — ${row.title}`);
      // Sellos: pocos claims; una sola transacción, para que los sellos creados sirvan a los discos siguientes también en seco.
      if (BLOCK === "sellos") await transaction(() => blockLabels(context, harvest.albums));
      if (BLOCK === "fotos") await guarded(harvest.artists, (rows) => blockPhotos(context, rows), (row) => row.artist);
      await client.query("UPDATE ingest.scrape_runs SET status='ok', finished_at=now(), counters=$2::jsonb WHERE id=$1", [report.runId, JSON.stringify(report.totals)]);
    } catch (error) {
      await client.query("UPDATE ingest.scrape_runs SET status='failed', finished_at=now(), counters=$2::jsonb WHERE id=$1", [report.runId, JSON.stringify(report.totals)]);
      throw error;
    }
  } finally {
    client.release();
  }
  writeReports();
}

/** Muestra fija (misma en seco y al confirmar): cada n-ésimo elemento aplicado. */
function sample<T>(rows: T[]): T[] {
  if (rows.length <= SAMPLE) return rows;
  const step = rows.length / SAMPLE;
  return Array.from({ length: SAMPLE }, (_, index) => rows[Math.floor(index * step)]!);
}

function writeReports(): void {
  const base = `${OUT_DIR}/etapa4-${BLOCK}-${report.mode}-run${report.runId}`;
  writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 1)}\n`);
  const line = (row: Row) => `- ${row.artist}${row.title ? ` — «${row.title}»` : ""} (${row.albumId ?? row.artistId}) · ${row.source} · ${row.detail}${row.problems?.length ? ` · ⚠ ${row.problems.join("; ")}` : ""}${row.url ? ` · ${row.url}` : ""}`;
  const lines = [
    `# Etapa 4 — ${BLOCK} (${report.mode}, run ${report.runId})`, "",
    `Cosecha: \`${HARVEST_FILE}\`. Plan: ~/Desktop/PLAN_NUEVO_LOTE_2026-10-02.md §3.`, "",
    "## Totales", "", ...Object.entries(report.totals).sort().map(([key, value]) => `- ${key}: ${value}`), "",
    `## Muestra de ${Math.min(SAMPLE, report.applied.length)} (de ${report.applied.length} aplicados)`, "", ...sample(report.applied).map(line), "",
    "## Con avisos", "", ...report.applied.filter((row) => row.problems?.length).map(line), "",
    "## No aplicados", "", ...report.skipped.map(line), "",
    "## Todos los aplicados", "", ...report.applied.map(line), "",
  ];
  writeFileSync(`${base}.md`, `${lines.join("\n")}\n`);
  console.log(`→ ${base}.md`);
  console.log(JSON.stringify(report.totals));
}

main().finally(() => closeDb()).catch((error) => { console.error(error); process.exitCode = 1; });
