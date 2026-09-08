// Contratos de borde para adapters. Ningún adapter escribe en PostgreSQL: solo
// descubre páginas y convierte snapshots ya almacenados en registros crudos.
import type { CheerioAPI } from "cheerio";
import { z } from "zod";

export const claimEntityKindSchema = z.enum([
  "artist", "person", "organization", "album", "track", "artist_membership",
  "person_organization", "album_credit", "track_credit", "album_format", "youtube_video",
]);

export const evidenceSchema = z.object({
  url: z.string().url(),
  excerpt: z.string().max(20_000).optional(),
  selector: z.string().max(300).optional(),
  position: z.number().int().nonnegative().optional(),
}).strict();

export const rawFieldSchema = z.object({
  field: z.string().min(1).max(80),
  value: z.unknown(),
  evidence: evidenceSchema,
}).strict();

/** Salida sin normalizar de un parser; se valida antes de persistir claims. */
export const rawRecordSchema = z.object({
  entityKind: claimEntityKindSchema,
  identity: z.string().min(1).max(250),
  fields: z.array(rawFieldSchema).min(1),
  extractor: z.string().min(1).max(80),
  extractorVersion: z.string().min(1).max(40),
}).strict();

export type RawRecord = z.infer<typeof rawRecordSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;

export const manualEvidenceInputSchema = z.object({
  evidenceUrl: z.string().url(),
  excerpt: z.string().trim().min(1).max(20_000),
  notes: z.string().trim().min(1).max(2_000).optional(),
}).strict();

export type ManualEvidenceInput = z.infer<typeof manualEvidenceInputSchema>;

export interface PageRef {
  url: string;
  /** Canal confirmado: feed/API antes que HTML renderizado. */
  kind: "html" | "json" | "xml";
}

export interface StoredPage extends PageRef {
  rawPageId: number;
  body: string;
}

export interface SourceAdapter {
  readonly slug: string;
  readonly requiresBrowser: false;
  /** Hard ceiling for this adapter's discovery frontier. Never crawl open-ended links. */
  readonly crawlLimit?: number;
  listPages(rootUrl: string): AsyncIterable<PageRef>;
  extract(page: CheerioAPI, url: string): RawRecord[];
  /**
   * Structured channels (Blogger/WordPress JSON) need their original body,
   * rather than an HTML-shaped view of it. HTML adapters can omit this.
   */
  extractSnapshot?(page: StoredPage): RawRecord[];
  /** Bounded, same-source discovery from an already cached snapshot. */
  discover?(page: StoredPage): PageRef[];
  /** Decodes a cached byte stream before it becomes a StoredPage. */
  decodeBody?(body: Buffer): string;
  /** Prevent a discovered document from expanding the approved source scope. */
  isAllowedUrl?(url: string, rootUrl: string): boolean;
}

/** Registro discriminado: una fuente conocida no implica scraping disponible. */
export type AdapterRegistration =
  | {
      readonly slug: string;
      readonly status: "functional";
      readonly mode: "automatic";
      readonly automation: "enabled";
      readonly adapter: SourceAdapter;
      readonly reason: string;
    }
  | {
      readonly slug: string;
      readonly status: "limited";
      readonly mode: "manual";
      readonly automation: "disabled";
      readonly acceptsManualEvidence: true;
      readonly reason: string;
      isAllowedEvidenceUrl(url: string, rootUrl: string): boolean;
    }
  | {
      readonly slug: string;
      readonly status: "limited";
      readonly mode: "disabled";
      readonly automation: "disabled";
      readonly acceptsManualEvidence: false;
      readonly reason: string;
    };
