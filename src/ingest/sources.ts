// CRV · Registro y siembra de ingest.sources (PHASES F1, SOURCES.md).
//
// La lista de fuentes es CERRADA (CONTRACT §3, decisión 10): 11 filas de
// `Links for Data Scrapping.xlsx` + YouTube Data API + los dos XLSX como
// seeds internos (spreadsheet). Este módulo NO inventa fuentes: la fila
// base (url/name/type) se lee del propio XLSX; el enriquecimiento
// (access_strategy/trust_level/enabled inicial) es exactamente el que
// SOURCES.md §3 ya registró tras la sonda de verificación del 2026-09-07
// — se copia aquí, no se re-deriva.
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { sources, scrapeRuns } from "../db/schema/ingest.js";
import { moduleLogger } from "../logger/index.js";

const log = moduleLogger("ingest:sources");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
export const LINKS_XLSX_PATH = path.join(ROOT, "Links for Data Scrapping.xlsx");
export const YT_MASTER_XLSX_PATH = path.join(ROOT, "YT Master Spreadsheet.xlsx");

type SiteType = "blogspot" | "wordpress" | "website" | "database" | "instagram" | "spreadsheet" | "youtube_api";
type TrustLevel = "high" | "medium" | "low" | "api";

interface SourceSeedRow {
  slug: string;
  name: string;
  url: string | null;
  siteType: SiteType;
  accessStrategy: string;
  requiresJs: boolean;
  trustLevel: TrustLevel;
  enabled: boolean;
  publicDisplay: boolean;
  notes: string;
}

// Enriquecimiento por slug (derivado del Name del XLSX), tomado literal de
// SOURCES.md §3.1/§3.2 — no son datos nuevos, son los ya auditados.
const ENRICHMENT: Record<string, Omit<SourceSeedRow, "name" | "url" | "slug">> = {
  "descargas-metal-venezolano": {
    siteType: "blogspot", requiresJs: false, trustLevel: "low", enabled: true, publicDisplay: false,
    accessStrategy: "Feed Blogger /feeds/posts/default (Atom/JSON, openSearch:totalResults). 1.355 entradas confirmadas. Requiere filtro de pertinencia (no todo el contenido es venezolano).",
    notes: "robots.txt 200, UTF-8, sin JS.",
  },
  rockzuela: {
    siteType: "blogspot", requiresJs: false, trustLevel: "low", enabled: true, publicDisplay: false,
    accessStrategy: "Feed Blogger /feeds/posts/default (Atom/JSON). 1.127 entradas confirmadas.",
    notes: "robots.txt 200, UTF-8, sin JS.",
  },
  "rock-de-vzla": {
    siteType: "blogspot", requiresJs: false, trustLevel: "low", enabled: true, publicDisplay: false,
    accessStrategy: "Feed Blogger /feeds/posts/default (Atom/JSON). 1.113 entradas confirmadas.",
    notes: "robots.txt 200, UTF-8, sin JS.",
  },
  "hippito-y-sus-chatarritas": {
    siteType: "blogspot", requiresJs: false, trustLevel: "low", enabled: true, publicDisplay: false,
    accessStrategy: "Feed Blogger /feeds/posts/default (Atom/JSON). 1.063 entradas confirmadas.",
    notes: "robots.txt 200, UTF-8, sin JS.",
  },
  "rhv-blogspot": {
    siteType: "blogspot", requiresJs: false, trustLevel: "low", enabled: true, publicDisplay: false,
    accessStrategy: "Feed Blogger /feeds/posts/default (Atom/JSON). 264 entradas confirmadas.",
    notes: "robots.txt 200, UTF-8, sin JS.",
  },
  "rock-hecho-en-venezuela": {
    siteType: "website", requiresJs: false, trustLevel: "medium", enabled: true, publicDisplay: false,
    accessStrategy: "WP REST /wp-json/wp/v2/ para inventario (4 posts + 6 páginas, X-WP-Total) + Cheerio sobre las páginas (contenido en Elementor 3.29.2). Rendimiento esperado bajo.",
    notes: "robots.txt 200, UTF-8, nginx, sin JS para HTML inicial.",
  },
  sincopa: {
    siteType: "database", requiresJs: false, trustLevel: "medium", enabled: true, publicDisplay: false,
    accessStrategy: "Adapter legacyFrameset: vertical.htm -> índices por género -> fichas de artista (337) y disco (290) en rock/pop. Decodificar windows-1252 antes de normalizar. Sin feed ni API.",
    notes: "robots.txt 404 (sin reglas; se aplica cortesía propia). Única fuente que alimenta persons/artist_members/organizations/albums.label_id directamente.",
  },
  "coleccionistas-de-rock-venezolano": {
    siteType: "wordpress", requiresJs: false, trustLevel: "medium", enabled: true, publicDisplay: false,
    accessStrategy: "API pública WordPress.com: https://public-api.wordpress.com/wp/v2/sites/coleccionistasderockvenezolano.wordpress.com/posts (92 posts, X-WP-Total).",
    notes: "robots.txt 200, UTF-8, nginx. Blog del propio proyecto.",
  },
  "el-punk-en-venezuela": {
    siteType: "website", requiresJs: false, trustLevel: "medium", enabled: true, publicDisplay: false,
    accessStrategy: "WP REST /wp-json/wp/v2/pages (0 posts, 17 páginas, X-WP-Total): el adapter DEBE recorrer pages, no posts. Cheerio para el cuerpo narrativo; candidato a asistencia de IA acotada.",
    notes: "robots.txt 200, UTF-8, Cloudflare, WordPress 6.5.10.",
  },
  "rock-y-pop-venezuela-merch-store": {
    siteType: "website", requiresJs: false, trustLevel: "medium", enabled: false, publicDisplay: false,
    accessStrategy: "Sin acceso: tienda Shopify deshabilitada.",
    notes: "HTTP 402 'Store unavailable' confirmado dos auditorías (sigue caída a 2026-09-07). No se elimina del registro; se re-verifica antes de habilitar.",
  },
  hemeroteka: {
    siteType: "instagram", requiresJs: true, trustLevel: "low", enabled: false, publicDisplay: false,
    accessStrategy: "Sin acceso anónimo (aplicación JS, ~2,5 KB de texto visible de 726 KB de HTML). Uso manual asistido únicamente: el operador aporta hallazgos como claims created_by=human. Sin barrido automático. Playwright NO se habilita para esta fuente.",
    notes: "robots.txt 200. Scraping masivo de Instagram no autorizado por esta especificación.",
  },
};

function slugify(name: string): string {
  return name
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // sin tildes
    .toLowerCase()
    .replace(/&/g, "y")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Lee las 11 filas de Links for Data Scrapping.xlsx y las enriquece con SOURCES.md §3. */
export async function readLinksXlsxRows(filePath = LINKS_XLSX_PATH): Promise<SourceSeedRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error(`${filePath}: sin hojas`);

  const rows: SourceSeedRow[] = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // cabecera: URL, Name, Type
    // Columnas reales del XLSX (1-indexadas): 1=URL, 2=Name, 3=Type.
    const urlCell = row.getCell(1).value;
    const url = typeof urlCell === "object" && urlCell !== null && "text" in urlCell
      ? String((urlCell as { text: unknown }).text)
      : urlCell !== null && urlCell !== undefined ? String(urlCell) : null;
    const name = row.getCell(2).text?.trim();
    if (!name) return;

    const slug = slugify(name);
    const enrichment = ENRICHMENT[slug];
    if (!enrichment) {
      throw new Error(
        `Fila del XLSX sin enriquecimiento conocido: "${name}" (slug derivado: "${slug}"). ` +
        `La lista de fuentes es cerrada (CONTRACT §3): si esto es una fuente nueva, requiere ` +
        `aprobación manual (SOURCES.md §6), no una siembra automática.`,
      );
    }
    rows.push({ slug, name, url, ...enrichment });
  });

  return rows;
}

// Los dos XLSX como seeds internos + YouTube Data API (SOURCES.md §2 y §5).
// No vienen del propio Links XLSX: están documentados aparte porque no son
// "filas" de ese archivo sino fuentes de gobierno explícito del contrato.
function internalSeedSources(): SourceSeedRow[] {
  return [
    {
      slug: "yt-master-seed", name: "YT Master Spreadsheet (seed interno)", url: null,
      siteType: "spreadsheet", requiresJs: false, trustLevel: "high", enabled: false, publicDisplay: false,
      accessStrategy: "Importación XLSX directa (no HTTP): ver ingest.seed_uploads y el importador de F2. enabled=false porque no se scrapea vía fetcher.",
      notes: "Seed del catálogo audiovisual (606 filas). Mapeo en DATA_MODEL.md §5.",
    },
    {
      slug: "links-seed", name: "Links for Data Scrapping (seed interno)", url: null,
      siteType: "spreadsheet", requiresJs: false, trustLevel: "high", enabled: false, publicDisplay: false,
      accessStrategy: "Importación XLSX directa (no HTTP): este mismo módulo. enabled=false porque no se scrapea vía fetcher.",
      notes: "Seed de ingest.sources (11 filas; columnas reales URL, Name, Type).",
    },
    {
      slug: "youtube-data-api", name: "YouTube Data API v3", url: "https://developers.google.com/youtube/v3",
      siteType: "youtube_api", requiresJs: false, trustLevel: "api", enabled: true, publicDisplay: false,
      accessStrategy: "videos.list(part=snippet,contentDetails,status) sobre IDs conocidos (hasta 50 por llamada). search.list opcional y acotado solo en enriquecimiento dirigido. PROHIBIDO el scraping visual de youtube.com.",
      notes: "Requiere YOUTUBE_API_KEY (F3); sin ella el sistema funciona igual (rutas deterministas apagadas).",
    },
  ];
}

/**
 * Siembra ingest.sources: 11 filas del XLSX + YouTube Data API + 2 seeds
 * internos = 14 filas (SOURCES.md, línea de apertura). Idempotente por
 * `slug` (UNIQUE): en conflicto solo actualiza campos descriptivos
 * (name/url/site_type/access_strategy/requires_js) — NUNCA sobreescribe
 * `enabled`/`trust_level`/`public_display` si la fila ya existía, para no
 * pisar un cambio manual posterior (p. ej. Deska reactivada a mano).
 */
export async function seedSources(filePath = LINKS_XLSX_PATH): Promise<{ inserted: number; updated: number }> {
  const db = getDb();
  const xlsxRows = await readLinksXlsxRows(filePath);
  const allRows = [...xlsxRows, ...internalSeedSources()];

  if (allRows.length !== 14) {
    throw new Error(`se esperaban 14 fuentes (11 XLSX + youtube_data_api + 2 seeds internos), se obtuvieron ${allRows.length}`);
  }

  // Capturado ANTES del bucle: scrape_runs_time_chk exige finished_at >=
  // started_at, y el default de columna started_at=now() se evalúa en
  // Postgres en el momento del INSERT (al final), después de que el reloj
  // ya avanzó respecto a cualquier `new Date()` de JS tomado antes del
  // bucle — por eso ambos timestamps se fijan aquí explícitamente, nunca
  // se deja uno al default del servidor y el otro a `new Date()`.
  const runStartedAt = new Date();
  let inserted = 0;
  let updated = 0;

  for (const row of allRows) {
    const existing = await db.select({ id: sources.id }).from(sources).where(eq(sources.slug, row.slug));
    if (existing.length > 0) {
      await db.update(sources)
        .set({
          name: row.name,
          url: row.url,
          siteType: row.siteType,
          accessStrategy: row.accessStrategy,
          requiresJs: row.requiresJs,
          notes: row.notes,
          updatedAt: new Date(),
        })
        .where(eq(sources.slug, row.slug));
      updated += 1;
    } else {
      await db.insert(sources).values({
        slug: row.slug,
        name: row.name,
        url: row.url,
        siteType: row.siteType,
        accessStrategy: row.accessStrategy,
        requiresJs: row.requiresJs,
        trustLevel: row.trustLevel,
        enabled: row.enabled,
        publicDisplay: row.publicDisplay,
        notes: row.notes,
      });
      inserted += 1;
    }
  }

  // Run de siembra: registra el hash del XLSX de origen (SOURCES.md §5:
  // "hash del archivo registrado en ingest.scrape_runs.params"). kind más
  // cercano del enum cerrado ingest.run_kind: 'manual' (operador ejecutando
  // una siembra puntual, no un scrape recurrente ni el seed de YT).
  const fs = await import("node:fs/promises");
  const fileBuf = await fs.readFile(filePath);
  const fileHash = createHash("sha256").update(fileBuf).digest("hex");
  await db.insert(scrapeRuns).values({
    kind: "manual",
    status: "ok",
    startedAt: runStartedAt,
    finishedAt: new Date(),
    params: { action: "seed_sources", file: path.basename(filePath), sha256: fileHash },
    counters: { inserted, updated, total: allRows.length },
  });

  log.info({ inserted, updated, total: allRows.length }, "ingest.sources sembrado");
  return { inserted, updated };
}

export interface SourceListItem {
  id: number;
  slug: string;
  name: string;
  siteType: string;
  trustLevel: string;
  enabled: boolean;
}

export async function listSources(): Promise<SourceListItem[]> {
  const db = getDb();
  return db.select({
    id: sources.id,
    slug: sources.slug,
    name: sources.name,
    siteType: sources.siteType,
    trustLevel: sources.trustLevel,
    enabled: sources.enabled,
  }).from(sources).orderBy(sql`${sources.slug}`);
}

/**
 * Propone una fuente NUEVA (CONTRACT decisión 10 / SOURCES.md §6): se crea
 * SIEMPRE con enabled=false y un ítem en review_queue(new_source); nunca se
 * habilita directamente. Requiere aprobación manual explícita después.
 */
export async function proposeSource(input: {
  name: string; url: string; siteType: SiteType; justification: string;
}): Promise<{ sourceId: number; reviewId: number }> {
  const db = getDb();
  const slug = slugify(input.name);

  const [source] = await db.insert(sources).values({
    slug,
    name: input.name,
    url: input.url,
    siteType: input.siteType,
    enabled: false,
    trustLevel: "low",
    notes: `Propuesta pendiente de aprobación manual: ${input.justification}`,
  }).returning({ id: sources.id });
  if (!source) throw new Error("no se pudo crear la fuente propuesta");

  const { reviewQueue } = await import("../db/schema/ingest.js");
  const [review] = await db.insert(reviewQueue).values({
    kind: "new_source",
    payload: { sourceId: source.id, name: input.name, url: input.url, justification: input.justification },
    notes: `Alta propuesta de fuente: ${input.name}`,
  }).returning({ id: reviewQueue.id });
  if (!review) throw new Error("no se pudo crear el ítem de revisión");

  log.info({ sourceId: source.id, reviewId: review.id }, "fuente propuesta (pendiente de aprobación)");
  return { sourceId: source.id, reviewId: review.id };
}
