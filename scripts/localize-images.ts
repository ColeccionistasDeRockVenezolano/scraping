// Descarga las imágenes canónicas ya asociadas a fichas y sustituye la URL
// remota por una ruta local servida por la aplicación. La URL de origen queda
// exclusivamente en el manifiesto para poder reintentar, auditar y atribuir.
//
// Uso:
//   npm run media:localize -- [--limit N] [--concurrency N] [--associate-only]
//
// Los datos del core se cambian únicamente por updateEntity()/withOperatorRun:
// cada sustitución deja su claim humano y su fila de auditoría.
//
// Con `--candidates <jsonl>`: una candidata cuya ficha YA tiene imagen no se pisa
// ni se descarta en silencio — se propone en `ingest.image_candidates` y se decide
// en Curaduría · Imágenes (/curaduria/imagenes). Regla del catálogo (Brian, 2026-10-04).
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import pg from "pg";
import { withOperatorRun, updateEntity } from "../src/merge/operator.js";

loadDotenv();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STORE = path.join(ROOT, "web", "public", "media");
const MANIFEST_PATH = path.join(STORE, "manifest.json");
const PUBLIC_PREFIX = "/crv/media";
const MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_CHUNK = 100;

type Kind = "artist" | "person" | "organization" | "album";

interface Target { kind: Kind; id: number; sourceUrl: string; mediaLinkId?: number; }
interface ManifestEntry {
  kind: Kind;
  id: number;
  /** Identifica un arte complementario de media.media_links. */
  mediaLinkId?: number;
  sourceUrl: string;
  localPath: string;
  contentType: string;
  bytes: number;
  sha256: string;
  downloadedAt: string;
  associatedAt?: string;
  failure?: string;
}
interface Manifest { version: 1; entries: Record<string, ManifestEntry>; }

/** Candidata de `--candidates` que llegó a una ficha que ya tenía imagen: se propone en Curaduría · Imágenes. */
interface CandidateConflict { kind: "album" | "artist"; id: number; currentUrl: string; candidateUrl: string; }

function arg(name: string): string | undefined {
  const position = process.argv.indexOf(name);
  return position >= 0 ? process.argv[position + 1] : undefined;
}
function integer(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const result = Number(value);
  if (!Number.isInteger(result) || result <= 0) throw new Error(`${name} debe ser un entero positivo`);
  return result;
}
function entryKey(target: Pick<Target, "kind" | "id" | "mediaLinkId">): string {
  return target.mediaLinkId === undefined ? `${target.kind}:${target.id}` : `media-link:${target.mediaLinkId}`;
}
function entityField(kind: Kind): "picture_url" | "cover_url" { return kind === "album" ? "cover_url" : "picture_url"; }
function entityUrl(kind: Kind, file: string): string { return `${PUBLIC_PREFIX}/${kind}/${file}`; }

async function readManifest(): Promise<Manifest> {
  try {
    const parsed = JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as Manifest;
    if (parsed.version !== 1 || typeof parsed.entries !== "object") throw new Error("formato inválido");
    return parsed;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: {} };
    throw new Error(`no se pudo leer ${MANIFEST_PATH}: ${(error as Error).message}`, { cause: error });
  }
}

async function writeManifest(manifest: Manifest): Promise<void> {
  await mkdir(STORE, { recursive: true });
  const temporary = `${MANIFEST_PATH}.tmp`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(temporary, MANIFEST_PATH);
}

async function listTargets(pool: pg.Pool, limit: number | undefined): Promise<{ targets: Target[]; conflicts: CandidateConflict[] }> {
  const { rows } = await pool.query<{ kind: Kind; id: string; source_url: string; media_link_id: string | null }>(`
    WITH candidates AS (
      SELECT 'artist'::text AS kind, id::text, picture_url AS source_url, NULL::text AS media_link_id, 0 AS priority FROM public.artists
        WHERE picture_url ~ '^https?://'
      UNION ALL
      SELECT 'person'::text, id::text, picture_url, NULL::text, 0 FROM public.persons
        WHERE picture_url ~ '^https?://'
      UNION ALL
      SELECT 'organization'::text, id::text, picture_url, NULL::text, 0 FROM public.organizations
        WHERE picture_url ~ '^https?://'
      UNION ALL
      SELECT 'album'::text, id::text, cover_url, NULL::text, 0 FROM public.albums
        WHERE cover_url ~ '^https?://'
      -- Sincopa clasificó estas como fotos de artista. Solo se usan cuando
      -- la ficha aún no tiene foto; una imagen de tipo scan nunca se eleva a
      -- portada o retrato canónico por conjetura.
      UNION ALL
      SELECT 'artist'::text, ml.artist_id::text, ml.url, NULL::text, 1
        FROM media.media_links ml
        JOIN public.artists a ON a.id=ml.artist_id
       WHERE a.picture_url IS NULL AND ml.media_type='artist_photo' AND ml.url ~ '^https?://'
      -- Segunda fuente: Discogs. La imagen se toma de una respuesta ya
      -- cacheada y solo si la identidad fue aceptada antes para esta ficha.
      -- Así la descarga no convierte una búsqueda textual ambigua en una
      -- asociación editorial.
      UNION ALL
      SELECT 'artist'::text, i.entity_id::text, image.img->>'uri', NULL::text, 2
        FROM ingest.genre_external_identities i
        JOIN ingest.genre_external_sources s ON s.id=i.source_id AND s.slug='discogs'
        JOIN public.artists a ON a.id=i.entity_id
        JOIN ingest.genre_external_cache c ON c.source_id=i.source_id
          AND c.url='https://api.discogs.com/artists/' || i.external_id
        CROSS JOIN LATERAL (
          SELECT img FROM jsonb_array_elements(COALESCE(c.payload->'images','[]'::jsonb)) img
          ORDER BY CASE img->>'type' WHEN 'primary' THEN 0 ELSE 1 END
          LIMIT 1
        ) image
       WHERE i.entity_kind='artist' AND i.status='matched' AND a.picture_url IS NULL
         AND image.img->>'uri' ~ '^https?://'
      UNION ALL
      SELECT 'album'::text, i.entity_id::text, image.img->>'uri', NULL::text, 2
        FROM ingest.genre_external_identities i
        JOIN ingest.genre_external_sources s ON s.id=i.source_id AND s.slug='discogs'
        JOIN public.albums a ON a.id=i.entity_id
        JOIN ingest.genre_external_cache c ON c.source_id=i.source_id
          AND c.url='https://api.discogs.com/' || replace(i.external_id,':','s/')
        CROSS JOIN LATERAL (
          SELECT img FROM jsonb_array_elements(COALESCE(c.payload->'images','[]'::jsonb)) img
          ORDER BY CASE img->>'type' WHEN 'primary' THEN 0 ELSE 1 END
          LIMIT 1
        ) image
       WHERE i.entity_kind='album' AND i.status='matched' AND a.cover_url IS NULL
         AND image.img->>'uri' ~ '^https?://'
      -- Los escaneos y fotos complementarias ya fueron asociados por la
      -- ingesta. Se localizan sin elevarlos a portada o retrato canónico.
      UNION ALL
      SELECT ml.entity_kind::text,
        COALESCE(ml.artist_id, ml.person_id, ml.organization_id, ml.album_id)::text,
        ml.url, ml.id::text, 3
        FROM media.media_links ml
       WHERE ml.url ~ '^https?://'
         AND ml.entity_kind IN ('artist','person','organization','album')
    )
    SELECT DISTINCT ON (kind,id,media_link_id) kind,id,source_url,media_link_id FROM candidates
    ORDER BY kind,id,media_link_id NULLS FIRST,priority,source_url`);
  const targets = rows.map((row) => ({
    kind: row.kind, id: Number(row.id), sourceUrl: row.source_url,
    ...(row.media_link_id === null ? {} : { mediaLinkId: Number(row.media_link_id) }),
  }));
  const candidateFile = arg("--candidates");
  const conflicts: CandidateConflict[] = [];
  if (candidateFile) {
    const supplied = (await readFile(path.resolve(candidateFile), "utf8")).split(/\r?\n/u).filter(Boolean)
      .map((line) => JSON.parse(line) as Target)
      .filter((row) => (row.kind === "artist" || row.kind === "person" || row.kind === "organization" || row.kind === "album")
        && Number.isInteger(row.id) && /^https?:\/\//u.test(row.sourceUrl));
    const native = new Set(targets.map(entryKey));
    for (const candidate of supplied) {
      if (native.has(entryKey(candidate))) continue;
      const table = candidate.kind === "album" ? "public.albums" : `public.${candidate.kind}s`;
      const field = entityField(candidate.kind);
      const current = await pool.query<{ value: string | null }>(`SELECT ${field} AS value FROM ${table} WHERE id=$1`, [candidate.id]);
      const currentUrl = current.rows[0]?.value ?? null;
      if (current.rows[0] !== undefined && currentUrl === null) { targets.push(candidate); native.add(entryKey(candidate)); }
      else if (currentUrl !== null && (candidate.kind === "artist" || candidate.kind === "album")) {
        // La ficha ya tiene imagen: la candidata no se descarta — se propone para
        // resolver el conflicto en Curaduría · Imágenes (regla del catálogo, 2026-10-04).
        conflicts.push({ kind: candidate.kind, id: candidate.id, currentUrl, candidateUrl: candidate.sourceUrl });
      }
    }
  }
  targets.sort((left, right) => left.kind.localeCompare(right.kind) || left.id - right.id
    || (left.mediaLinkId ?? -1) - (right.mediaLinkId ?? -1));
  return { targets: limit === undefined ? targets : targets.slice(0, limit), conflicts };
}

function extension(contentType: string, bytes: Uint8Array): string | undefined {
  const normalized = contentType.toLowerCase().split(";", 1)[0] ?? "";
  const fromType: Record<string, string> = {
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif",
  };
  if (fromType[normalized]) return fromType[normalized];
  const signature = Buffer.from(bytes.subarray(0, 16));
  if (signature.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "jpg";
  if (signature.subarray(0, 8).equals(Buffer.from("\x89PNG\r\n\x1a\n", "binary"))) return "png";
  if (signature.subarray(0, 6).toString("ascii") === "GIF87a" || signature.subarray(0, 6).toString("ascii") === "GIF89a") return "gif";
  if (signature.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return undefined;
}

async function imageBytes(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error(`excede el límite de ${MAX_BYTES} bytes`);
  if (!response.body) throw new Error("respuesta sin cuerpo");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new Error(`excede el límite de ${MAX_BYTES} bytes`);
    }
    chunks.push(next.value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

async function exists(file: string): Promise<boolean> {
  try { return (await stat(file)).isFile(); } catch { return false; }
}

async function sourceDownloadUrl(sourceUrl: string): Promise<string> {
  const parsed = new URL(sourceUrl);
  if (parsed.hostname !== "commons.wikimedia.org" || !parsed.pathname.startsWith("/wiki/Special:FilePath/")) return sourceUrl;
  // Special:FilePath responde 302 hacia upload.wikimedia.org; seguimos el redirect
  // con redirect:"manual" para no pasar por api.php, que limita con 429.
  try {
    const probe = await fetch(sourceUrl, {
      redirect: "manual", signal: AbortSignal.timeout(30_000),
      headers: { "user-agent": "CRV-local-media/1.0 (+coleccionistasderockvenezolano.com)" },
    });
    if (probe.status >= 300 && probe.status < 400) {
      const location = probe.headers.get("location");
      if (location) return new URL(location, sourceUrl).toString();
    }
  } catch { /* cae al api.php */ }
  const filename = decodeURIComponent(parsed.pathname.slice("/wiki/Special:FilePath/".length));
  const api = new URL("https://commons.wikimedia.org/w/api.php");
  api.search = new URLSearchParams({ action: "query", format: "json", prop: "imageinfo", iiprop: "url", titles: `File:${filename}` }).toString();
  const response = await fetch(api, { headers: { "user-agent": "CRV-local-media/1.0 (+coleccionistasderockvenezolano.com)" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Commons API HTTP ${response.status}`);
  const payload = await response.json() as { query?: { pages?: Record<string, { imageinfo?: Array<{ url?: string }> }> } };
  const url = Object.values(payload.query?.pages ?? {}).flatMap((page) => page.imageinfo ?? []).map((info) => info.url).find((value): value is string => typeof value === "string");
  if (!url) throw new Error("Commons no devolvió URL directa para el archivo");
  return url;
}

async function download(target: Target, manifest: Manifest): Promise<"downloaded" | "cached" | "failed"> {
  const key = entryKey(target);
  const current = manifest.entries[key];
  if (current && current.sourceUrl === target.sourceUrl && await exists(path.join(ROOT, "web", "public", current.localPath))) return "cached";
  try {
    const downloadUrl = await sourceDownloadUrl(target.sourceUrl);
    const response = await fetch(downloadUrl, {
      redirect: "follow", signal: AbortSignal.timeout(30_000),
      headers: { "user-agent": "CRV-local-media/1.0 (+coleccionistasderockvenezolano.com)" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("image/")) throw new Error(`content-type no es imagen: ${contentType || "ausente"}`);
    const bytes = await imageBytes(response);
    const ext = extension(contentType, bytes);
    if (!ext) throw new Error(`formato de imagen no reconocido: ${contentType}`);
    const directory = target.mediaLinkId === undefined
      ? path.join(STORE, target.kind)
      : path.join(STORE, target.kind, String(target.id));
    const relative = target.mediaLinkId === undefined
      ? path.posix.join("media", target.kind, `${target.id}.${ext}`)
      : path.posix.join("media", target.kind, String(target.id), `link-${target.mediaLinkId}.${ext}`);
    const destination = path.join(ROOT, "web", "public", relative);
    await mkdir(directory, { recursive: true });
    // Un rename evita exponer una imagen a medio escribir si se publica mientras corre el proceso.
    const temporary = `${destination}.part`;
    await writeFile(temporary, bytes);
    await rename(temporary, destination);
    if (current && current.localPath !== relative) await unlink(path.join(ROOT, "web", "public", current.localPath)).catch(() => undefined);
    manifest.entries[key] = {
      kind: target.kind, id: target.id, ...(target.mediaLinkId === undefined ? {} : { mediaLinkId: target.mediaLinkId }),
      sourceUrl: target.sourceUrl, localPath: relative,
      contentType: contentType.split(";", 1)[0]!, bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"), downloadedAt: new Date().toISOString(),
    };
    return "downloaded";
  } catch (error) {
    manifest.entries[key] = {
      kind: target.kind, id: target.id, ...(target.mediaLinkId === undefined ? {} : { mediaLinkId: target.mediaLinkId }),
      sourceUrl: target.sourceUrl, localPath: current?.localPath ?? "",
      contentType: current?.contentType ?? "", bytes: current?.bytes ?? 0, sha256: current?.sha256 ?? "",
      downloadedAt: current?.downloadedAt ?? new Date().toISOString(), failure: (error as Error).message,
    };
    return "failed";
  }
}

async function associate(pool: pg.Pool, entries: ManifestEntry[], chunkSize: number): Promise<number> {
  let written = 0;
  for (let start = 0; start < entries.length; start += chunkSize) {
    const batch = entries.slice(start, start + chunkSize);
    await withOperatorRun({
      name: "localizar-imágenes", operator: "media-localizer",
      note: "Imagen descargada localmente desde una fuente original del catálogo.",
      params: { count: batch.length, first: entryKey(batch[0]!) },
    }, async (context) => {
      for (const entry of batch) {
        if (entry.mediaLinkId === undefined) {
          await updateEntity(context, entry.kind, entry.id, { [entityField(entry.kind)]: entityUrl(entry.kind, path.basename(entry.localPath)) });
          continue;
        }
        const localUrl = `${PUBLIC_PREFIX}/${entry.localPath.slice("media/".length)}`;
        const replaced = await context.client.query<{ url: string }>(
          "UPDATE media.media_links SET url=$1 WHERE id=$2 AND url=$3 RETURNING url",
          [localUrl, entry.mediaLinkId, entry.sourceUrl],
        );
        if (!replaced.rows[0]) {
          const current = await context.client.query<{ url: string }>("SELECT url FROM media.media_links WHERE id=$1", [entry.mediaLinkId]);
          if (current.rows[0]?.url !== localUrl) throw new Error(`media_link ${entry.mediaLinkId} cambió antes de poder localizarse`);
          continue;
        }
        await context.client.query(
          `INSERT INTO ingest.merge_audit(run_id,entity_kind,media_link_id,field,old_value,new_value,reason,confidence,performed_by)
           VALUES($1,'media_link',$2,'url',$3::jsonb,$4::jsonb,$5,'high','human')`,
          [context.runId, entry.mediaLinkId, JSON.stringify(entry.sourceUrl), JSON.stringify(localUrl),
            "Arte complementario descargado localmente desde la fuente original del catálogo."],
        );
      }
    });
    const now = new Date().toISOString();
    for (const entry of batch) entry.associatedAt = now;
    written += batch.length;
    process.stdout.write(`asociadas ${written}/${entries.length}\n`);
  }
  await pool.query("SELECT 1"); // deja explícito que las asociaciones ya hicieron commit antes de informar éxito.
  return written;
}

async function main(): Promise<void> {
  const limitRaw = arg("--limit");
  const limit = limitRaw === undefined ? undefined : integer(limitRaw, 0, "--limit");
  const concurrency = integer(arg("--concurrency"), DEFAULT_CONCURRENCY, "--concurrency");
  const chunkSize = integer(arg("--chunk-size"), DEFAULT_CHUNK, "--chunk-size");
  const delayMs = arg("--delay-ms") === undefined ? 0 : integer(arg("--delay-ms"), 0, "--delay-ms");
  const associateOnly = process.argv.includes("--associate-only");
  const pool = new pg.Pool({ connectionString: process.env["DATABASE_URL"] });
  try {
    const manifest = await readManifest();
    const { targets, conflicts } = await listTargets(pool, limit);
    process.stdout.write(`fichas con URL remota: ${targets.length}\n`);
    let downloaded = 0; let cached = 0; let failed = 0;
    if (!associateOnly) {
      let cursor = 0;
      const worker = async () => {
        while (true) {
          const target = targets[cursor++];
          if (!target) return;
          const outcome = await download(target, manifest);
          if (outcome === "downloaded") downloaded += 1;
          if (outcome === "cached") cached += 1;
          if (outcome === "failed") failed += 1;
          const complete = downloaded + cached + failed;
          if (complete % 50 === 0 || complete === targets.length) process.stdout.write(`descargas ${complete}/${targets.length} (nuevas ${downloaded}, cache ${cached}, fallos ${failed})\n`);
          if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));
      await writeManifest(manifest);
    }
    const ready = targets.map((target) => manifest.entries[entryKey(target)]).filter((entry): entry is ManifestEntry =>
      entry !== undefined && Boolean(entry.localPath) && !entry.failure);
    const associated = await associate(pool, ready, chunkSize);
    await writeManifest(manifest);
    let conflictCandidates = 0;
    if (conflicts.length > 0) {
      const candidateFile = arg("--candidates") ?? "";
      const outcome = await withOperatorRun({
        name: "image_candidates_localize", operator: "media-localizer",
        note: `Candidatas en conflicto (la ficha ya tenía imagen) → Curaduría · Imágenes. Archivo: ${candidateFile}.`,
        params: { file: candidateFile, count: conflicts.length },
      }, async (context) => {
        let inserted = 0;
        for (const conflict of conflicts) {
          const column = conflict.kind === "album" ? "album_id" : "artist_id";
          const result = await context.client.query(
            `INSERT INTO ingest.image_candidates(entity_kind, ${column}, current_url, candidate_url, source, origin, run_id)
             VALUES ($1, $2, $3, $4, 'web', $5, $6)
             ON CONFLICT DO NOTHING`,
            [conflict.kind, conflict.id, conflict.currentUrl, conflict.candidateUrl, `localize:${path.basename(candidateFile)}`, context.runId],
          );
          inserted += result.rowCount ?? 0;
        }
        return inserted;
      });
      conflictCandidates = outcome.result;
      process.stdout.write(`candidatas en conflicto → Curaduría · Imágenes: ${conflictCandidates}/${conflicts.length}\n`);
    }
    process.stdout.write(`${JSON.stringify({ targets: targets.length, downloaded, cached, failed, associated, conflictCandidates, manifest: path.relative(ROOT, MANIFEST_PATH) })}\n`);
    if (failed > 0) process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
