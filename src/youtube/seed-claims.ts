// A1 · La hoja maestra de YouTube como discografía, no como lista de videos.
//
// `importYouTubeMasterSheet` deja las 606 filas en ingest.seed_uploads y abre
// una revisión por cada release que no encuentra álbum canónico ("no se crea
// automáticamente"). El resultado es que el dato mejor documentado del archivo
// —258 artistas y 598 discos con año y tipo, escritos a mano por el propietario
// del proyecto— vive como JSON en review_queue y nunca llega al core.
//
// Este módulo lo mete por la puerta normal: convierte cada fila en RawRecord y
// lo pasa por adapter → normalizeRecord → persistClaim → ER → merge, igual que
// cualquier otra fuente. No abre ninguna vía nueva.
//
// Dos decisiones que el lector merece ver explicadas:
//
//  * SALE COMO CANDIDATO (confidence "low", createdBy "system") aunque la
//    fuente tenga trust_level 'high'. Quien escribió la hoja es una persona,
//    pero quien la está leyendo aquí es un programa: la decisión humana se
//    expresa después, aprobando el lote (`review approve-batch
//    --source=yt-master-seed`). Así el core mantiene una sola puerta y estas
//    598 filas quedan con el mismo rastro de auditoría que las demás.
//  * SE RESPETA LA CLASIFICACIÓN QUE YA EXISTE. Un 'media' (music_video,
//    live_concert, documentary) NO produce álbum: sigue siendo un video, y
//    convertirlo en disco sería inventar una publicación. Un 'review' (los
//    tipos compuestos tipo "Solo Artist, Studio Album" o "B-Sides") sí produce
//    álbum pero SIN album_type: la hoja afirma que el disco existe, lo ambiguo
//    es su tipo, y esa ambigüedad ya tiene su manual_review abierta.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getPool } from "../db/client.js";
import { YT_MASTER_XLSX_PATH } from "../ingest/sources.js";
import { ingestRecords, type IngestionResult } from "../ingest/runner.js";
import { canonicalVideoUrl, collectReleaseYears, releaseIdentity } from "./normalization.js";
import type { Evidence, RawRecord } from "../adapters/contracts.js";
import { moduleLogger } from "../logger/index.js";

const log = moduleLogger("youtube:seed-claims");

export const SEED_SOURCE_SLUG = "yt-master-seed";
const EXTRACTOR = "yt-master-seed";
const EXTRACTOR_VERSION = "1";

export interface SeedClaimsResult {
  rows: number;
  /** Filas sin artista o sin disco: no hay identidad que afirmar. */
  skipped: number;
  artists: number;
  albums: number;
  /** Filas audiovisuales cuyo artista sí entra pero que no producen disco. */
  mediaOnly: number;
  /** Álbumes emitidos sin album_type porque el tipo de la hoja es compuesto. */
  albumsSinTipo: number;
  claimsInserted: number;
  claimsReused: number;
  runId?: number;
}

export interface SeedRow {
  upload_order: number;
  artist_name_raw: string | null;
  album_name_raw: string | null;
  album_year_raw: number | null;
  type_raw: string | null;
  video_id: string | null;
  row_number: number | null;
  content_kind: string | null;
  normalized_type: string | null;
}

/**
 * La evidencia de una fila es el video cuando lo hay, y el propio libro cuando
 * no: 86 filas de la hoja son discografía sin video, y siguen siendo evidencia
 * de que el disco existe. Inventarles una URL web sería peor que apuntar al
 * archivo real que las contiene.
 */
function evidenceFor(row: SeedRow, filePath: string): Evidence {
  const excerpt = [row.artist_name_raw, row.album_name_raw, row.album_year_raw, row.type_raw]
    .filter((value) => value !== null && value !== "")
    .join(" · ");
  // Ojo: el hash del claim incluye esta evidencia. Si la hoja se reordena,
  // cambia `row:N` y re-emitir duplica cada hecho (pasó el 2026-09-13 al
  // importar desde Google; los duplicados quedaron `superseded`).
  const url = row.video_id
    ? canonicalVideoUrl(row.video_id)
    : `${pathToFileURL(filePath).toString()}#row=${row.row_number ?? row.upload_order}`;
  return { url, selector: `row:${row.row_number ?? row.upload_order}`, excerpt };
}

export async function readSeedRows(): Promise<SeedRow[]> {
  const { rows } = await getPool().query<SeedRow>(`
    SELECT upload_order, artist_name_raw, album_name_raw, album_year_raw, type_raw,
           video_id, row_number, content_kind, normalized_type
      FROM ingest.seed_uploads
     ORDER BY upload_order`);
  return rows;
}

/** Traduce las filas ya importadas a registros crudos, sin tocar la base. */
export function seedRecords(rows: SeedRow[], filePath = YT_MASTER_XLSX_PATH): {
  records: RawRecord[]; skipped: number; mediaOnly: number; albumsSinTipo: number;
} {
  const records: RawRecord[] = [];
  const artistasVistos = new Set<string>();
  let skipped = 0; let mediaOnly = 0; let albumsSinTipo = 0;
  const yearsByRelease = collectReleaseYears(rows.flatMap((row) => {
    const artist = row.artist_name_raw?.trim(); const album = row.album_name_raw?.trim();
    return artist && album && row.content_kind !== "media" ? [{ artist, album, year: row.album_year_raw }] : [];
  }));

  for (const row of rows) {
    const artist = row.artist_name_raw?.trim();
    const album = row.album_name_raw?.trim();
    if (!artist || !album) { skipped += 1; continue; }
    const where = evidenceFor(row, filePath);

    // Un artista se afirma una sola vez aunque tenga ocho discos en la hoja.
    if (!artistasVistos.has(artist.toLowerCase())) {
      artistasVistos.add(artist.toLowerCase());
      records.push({
        entityKind: "artist", identity: artist, extractor: EXTRACTOR, extractorVersion: EXTRACTOR_VERSION,
        fields: [{ field: "name", value: artist, evidence: where }],
      });
    }

    // Un videoclip o un documental no son una publicación discográfica.
    if (row.content_kind === "media") { mediaOnly += 1; continue; }

    const fields: RawRecord["fields"] = [
      { field: "title", value: album, evidence: where },
      { field: "artist_name", value: artist, evidence: where },
    ];
    if (row.album_year_raw !== null) fields.push({ field: "release_year", value: String(row.album_year_raw), evidence: where });
    if (row.content_kind === "release" && row.normalized_type) {
      fields.push({ field: "album_type", value: row.normalized_type, evidence: where });
    } else {
      albumsSinTipo += 1;
    }
    if (row.video_id) fields.push({ field: "youtube_url", value: canonicalVideoUrl(row.video_id), evidence: where });

    records.push({
      entityKind: "album",
      // "artista::título": el core no admite un disco sin artista y dos bandas
      // pueden tener un "Vol. 1"; es la misma clave que usa Sincopa. Un mismo
      // título con otro año (Spiteri 1981) lleva el año en la identidad.
      identity: releaseIdentity(artist, album, row.album_year_raw, yearsByRelease),
      extractor: EXTRACTOR, extractorVersion: EXTRACTOR_VERSION, fields,
    });
  }
  return { records, skipped, mediaOnly, albumsSinTipo };
}

/** Emite los claims de la hoja ya importada. Idempotente: el hash los reusa. */
export async function ingestSeedClaims(options: { dryRun?: boolean } = {}): Promise<SeedClaimsResult> {
  const rows = await readSeedRows();
  if (rows.length === 0) {
    throw new Error("ingest.seed_uploads está vacío: importa la hoja primero con `crv seed import-yt`");
  }
  const { records, skipped, mediaOnly, albumsSinTipo } = seedRecords(rows);
  const ingestion: IngestionResult = await ingestRecords(SEED_SOURCE_SLUG, records, {
    confidence: "low",
    ...(options.dryRun === true ? { dryRun: true } : {}),
  });

  const result: SeedClaimsResult = {
    rows: rows.length, skipped, mediaOnly, albumsSinTipo,
    artists: records.filter((record) => record.entityKind === "artist").length,
    albums: records.filter((record) => record.entityKind === "album").length,
    claimsInserted: ingestion.claimsInserted,
    claimsReused: ingestion.claimsReused,
    ...(ingestion.runId === undefined ? {} : { runId: ingestion.runId }),
  };
  log.info({ ...result, dryRun: options.dryRun === true }, "claims de la hoja maestra emitidos");
  return result;
}

export const SEED_FILE_BASENAME = path.basename(YT_MASTER_XLSX_PATH);
