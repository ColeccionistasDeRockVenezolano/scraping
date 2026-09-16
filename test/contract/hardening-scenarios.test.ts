// CRV · E11 — escenarios de endurecimiento (plan §FASE 11, PHASES §E11).
//
// Cada `describe` es uno de los trece escenarios que la auditoría final exige
// probar contra una base real. Todos corren en un único PostgreSQL desechable
// (nunca contra crv-postgres) y por la puerta normal del sistema: fetcher →
// raw_pages → adapter → normalizeRecord → persistClaim → ER → merge. Donde el
// escenario es una garantía del esquema (media.*) se prueba la restricción
// directamente, porque es ella —y no el código— la última línea de defensa.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { migrateUp } from "../../src/db/migrate.js";
import { closeDb, getDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { sources } from "../../src/db/schema/ingest.js";
import { normalizeRecord } from "../../src/normalization/claims.js";
import { mergeClaim, type MergeOptions, type MergeOutcome } from "../../src/merge/engine.js";
import { persistClaim, type Actor, type ClaimToPersist, type Confidence } from "../../src/claims/persistence.js";
import type { RawRecord, SourceAdapter } from "../../src/adapters/contracts.js";
import type { ResolutionInput } from "../../src/er/types.js";
import { fetchAndCache } from "../../src/cache/raw-pages.js";
import { ingestAdapterSnapshots, loadStoredAdapterPages } from "../../src/ingest/runner.js";
import { importYouTubeMasterSheet } from "../../src/youtube/pipeline.js";
import { ingestSeedClaims } from "../../src/youtube/seed-claims.js";
import { canonicalVideoUrl } from "../../src/youtube/normalization.js";

let evidenceCounter = 0;
const sourceIds = new Map<string, number>();
const sourceId = (slug: string): number => {
  const id = sourceIds.get(slug);
  if (id === undefined) throw new Error(`fuente de prueba no registrada: ${slug}`);
  return id;
};

/** Un registro completo por la misma secuencia de dos fases que usa el runner. */
async function applyRecord(options: {
  source: string;
  kind: RawRecord["entityKind"];
  identity: string;
  fields: Array<[string, unknown]>;
  confidence?: Confidence;
  createdBy?: Actor;
  /** Página fija: repetirla es volver a leer la misma evidencia (mismo raw_hash). */
  page?: string;
}): Promise<MergeOutcome[]> {
  evidenceCounter += 1;
  const page = options.page ?? String(evidenceCounter);
  const record: RawRecord = {
    entityKind: options.kind, identity: options.identity,
    extractor: "hardening-contract", extractorVersion: "1",
    fields: options.fields.map(([field, value]) => ({
      field, value,
      evidence: { url: `https://fixture.invalid/hardening/${options.source}/${page}`, excerpt: String(value) },
    })),
  };
  const inputs: ClaimToPersist[] = normalizeRecord(record).map((claim) => ({
    ...claim, sourceId: sourceId(options.source), confidence: options.confidence ?? "high",
    ...(options.createdBy === undefined ? {} : { createdBy: options.createdBy }),
  }));
  const persisted = [];
  for (const input of inputs) persisted.push(await persistClaim(input));
  const outcomes: MergeOutcome[] = [];
  for (const [index, input] of inputs.entries()) outcomes.push(await mergeClaim(input, persisted[index]!));
  return outcomes;
}

/** Un claim suelto, con contexto de ER o una decisión humana explícita. */
async function applyOne(options: {
  source: string;
  kind: ClaimToPersist["entityKind"];
  identity: string;
  field: string;
  value: unknown;
  confidence?: Confidence;
  createdBy?: Actor;
  resolutionInput?: ResolutionInput;
  merge?: MergeOptions;
}): Promise<{ claimId: number; outcome: MergeOutcome }> {
  evidenceCounter += 1;
  const normalized = normalizeRecord({
    entityKind: options.kind, identity: options.identity, extractor: "hardening-contract", extractorVersion: "1",
    fields: [{ field: options.field, value: options.value, evidence: {
      url: `https://fixture.invalid/hardening/${options.source}/${evidenceCounter}`, excerpt: String(options.value),
    } }],
  })[0]!;
  const input: ClaimToPersist = {
    ...normalized, sourceId: sourceId(options.source), confidence: options.confidence ?? "high",
    ...(options.createdBy === undefined ? {} : { createdBy: options.createdBy }),
    ...(options.resolutionInput === undefined ? {} : { resolutionInput: options.resolutionInput }),
  };
  const persisted = await persistClaim(input);
  return { claimId: persisted.id, outcome: await mergeClaim(input, persisted, options.merge ?? {}) };
}

const count = async (table: string, where = "TRUE", params: unknown[] = []): Promise<number> =>
  Number((await getPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE ${where}`, params)).rows[0]!.n);

const idOf = async (sql: string, params: unknown[]): Promise<number> => {
  const { rows } = await getPool().query<{ id: string }>(sql, params);
  if (rows.length !== 1) throw new Error(`se esperaba una fila y hubo ${rows.length}: ${sql}`);
  return Number(rows[0]!.id);
};

/** Error de PostgreSQL con su SQLSTATE, para afirmar qué restricción saltó. */
async function pgErrorCode(sql: string, params: unknown[]): Promise<string | undefined> {
  try {
    await getPool().query(sql, params);
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

const TRACKED_TABLES = [
  "ingest.seed_uploads", "media.youtube_videos", "ingest.review_queue", "ingest.claims", "ingest.claim_evidence",
  "ingest.entity_resolution_decisions", "ingest.merge_audit", "ingest.conflicts", "public.artists", "public.albums",
] as const;

async function snapshot(): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const table of TRACKED_TABLES) result[table] = await count(table);
  return result;
}

describe("E11 · escenarios de endurecimiento", () => {
  let container: PgContainer;
  let server: Server;
  let baseUrl: string;
  let dataDir: string;
  const requests: string[] = [];

  beforeAll(async () => {
    container = await startPgContainer();
    server = createServer((req, res) => {
      const url = req.url ?? "/";
      requests.push(url);
      if (url === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><body><h1>Banda Triple Scrape</h1></body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("sin dirección de servidor");
    baseUrl = `http://127.0.0.1:${address.port}`;

    dataDir = await mkdtemp(path.join(tmpdir(), "crv-hardening-"));
    process.env["DATABASE_URL"] = container.databaseUrl;
    process.env["DATA_DIR"] = dataDir;
    process.env["CRAWL_DELAY_MS"] = "0";
    process.env["CRAWL_MAX_RETRIES"] = "0";
    delete process.env["YOUTUBE_API_KEY"];
    delete process.env["DEEPSEEK_API_KEY"];
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();

    for (const slug of ["hardening-web", "hardening-a", "hardening-b", "hardening-c"]) {
      const [row] = await getDb().insert(sources).values({
        slug, name: `Fixture ${slug} (no fuente de producción)`,
        url: slug === "hardening-web" ? baseUrl : "https://fixture.invalid",
        siteType: "website", trustLevel: "high", enabled: true,
      }).returning();
      sourceIds.set(slug, row!.id);
    }
  }, 180_000);

  afterAll(async () => {
    await closeDb();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await container.stop();
    await rm(dataDir, { recursive: true, force: true });
  }, 60_000);

  describe("1 · la misma página scrapeada tres veces", () => {
    it("una sola raw page, un solo claim, una sola evidencia y un solo artista", async () => {
      const url = `${baseUrl}/banda`;
      const adapter: SourceAdapter = {
        slug: "hardening-web", requiresBrowser: false,
        async *listPages() { yield { url, kind: "html" as const }; },
        extract($, pageUrl) {
          const name = $("h1").text();
          return [{
            entityKind: "artist", identity: name, extractor: "hardening-html", extractorVersion: "1",
            fields: [{ field: "name", value: name, evidence: { url: pageUrl, selector: "h1", excerpt: name } }],
          }];
        },
      };
      const where = "source_id=$1";
      const runs = [];
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        // TTL 0: fuerza la descarga real en cada vuelta; el dedupe tiene que
        // venir del hash del contenido, no del caché por edad.
        const fetched = await fetchAndCache("hardening-web", url, 0);
        expect(fetched.cached).toBe(false);
        const pages = await loadStoredAdapterPages("hardening-web", adapter);
        expect(pages).toHaveLength(1);
        runs.push(await ingestAdapterSnapshots("hardening-web", adapter, pages, { confidence: "high" }));
        expect(await count("ingest.raw_pages", where, [sourceId("hardening-web")])).toBe(1);
      }
      expect(requests.filter((item) => item === "/banda")).toHaveLength(3);
      expect(runs.map((run) => [run.claimsInserted, run.claimsReused])).toEqual([[1, 0], [0, 1], [0, 1]]);
      expect(await count("ingest.claims", where, [sourceId("hardening-web")])).toBe(1);
      expect(await count("ingest.claim_evidence", "claim_id IN (SELECT id FROM ingest.claims WHERE source_id=$1)", [sourceId("hardening-web")])).toBe(1);
      expect(await count("public.artists", "name='Banda Triple Scrape'")).toBe(1);
      expect(await count("ingest.merge_audit", "artist_id=(SELECT id FROM public.artists WHERE name='Banda Triple Scrape')")).toBe(1);
      // Cada pasada sí deja su run: la trazabilidad de la operación no se deduplica.
      expect(await count("ingest.scrape_runs", "source_id=$1", [sourceId("hardening-web")])).toBe(3);
    }, 60_000);
  });

  describe("2 · el mismo XLSX importado tres veces", () => {
    it("la hoja real y sus claims no crecen después de la primera importación", async () => {
      const imports = [];
      const seedClaims = [];
      const snapshots = [];
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        imports.push(await importYouTubeMasterSheet());
        seedClaims.push(await ingestSeedClaims());
        snapshots.push(await snapshot());
      }
      expect(imports[0]!.inserted).toBeGreaterThan(0);
      for (const later of imports.slice(1)) {
        expect(later).toMatchObject({ inserted: 0, updated: 0, unchanged: imports[0]!.inserted });
      }
      expect(seedClaims[0]!.claimsInserted).toBeGreaterThan(0);
      for (const later of seedClaims.slice(1)) expect(later.claimsInserted).toBe(0);
      expect(snapshots[1]).toEqual(snapshots[0]);
      expect(snapshots[2]).toEqual(snapshots[0]);
      // La hoja sale como candidata (confidence low): no escribe el core sola.
      expect(snapshots[0]!["public.albums"]).toBe(0);
      expect(await count("ingest.seed_uploads", "video_id IS NOT NULL")).toBe(await count("media.youtube_videos"));
    }, 900_000);
  });

  describe("3 · la misma URL de YouTube con parámetros distintos", () => {
    it("cinco variantes de la misma URL son un solo video con URL canónica", async () => {
      const videoId = "HrdnVar_01A";
      const variants: ExcelJS.CellValue[] = [
        `https://www.youtube.com/watch?v=${videoId}&t=42s`,
        `https://youtu.be/${videoId}?si=Xy12Zw`,
        `https://m.youtube.com/watch?feature=share&v=${videoId}&pp=ygUEdGVzdA%3D%3D`,
        `https://www.youtube.com/embed/${videoId}?start=10`,
        { text: "ver video", hyperlink: `https://youtube.com/shorts/${videoId}?feature=share` },
      ];
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Hoja1");
      sheet.addRow(["Upload Order", "Artist Name", "Album Name", "Album Year", "Type of Album", "URL", "Status"]);
      variants.forEach((url, index) => {
        sheet.addRow([32001 + index, "Banda Variantes URL", "Disco Variantes URL", 2001, "Studio Album", url, "Uploaded"]);
      });
      const file = path.join(dataDir, "variantes.xlsx");
      await workbook.xlsx.writeFile(file);

      const first = await importYouTubeMasterSheet(file);
      const reviewsAfterFirst = await count("ingest.review_queue");
      const again = [await importYouTubeMasterSheet(file), await importYouTubeMasterSheet(file)];
      expect(first).toMatchObject({ inserted: 5, updated: 0 });
      for (const later of again) expect(later).toMatchObject({ inserted: 0, updated: 0, unchanged: 5 });

      const videos = await getPool().query<{ url: string; seed_order: number }>(`
        SELECT v.url, s.upload_order AS seed_order FROM media.youtube_videos v
          JOIN ingest.seed_uploads s ON s.id=v.seed_upload_id WHERE v.video_id=$1`, [videoId]);
      expect(videos.rows).toEqual([{ url: canonicalVideoUrl(videoId), seed_order: 32001 }]);
      // La URL cruda de cada fila se conserva como evidencia; el id es uno.
      expect(await count("ingest.seed_uploads", "video_id=$1", [videoId])).toBe(5);
      expect(Number((await getPool().query<{ n: string }>(
        "SELECT count(DISTINCT url_raw)::text AS n FROM ingest.seed_uploads WHERE video_id=$1", [videoId])).rows[0]!.n)).toBe(5);
      expect(await count("ingest.review_queue")).toBe(reviewsAfterFirst);
    }, 60_000);
  });

  describe("4 · dos bandas con nombres parecidos", () => {
    it("Los Paranoias y Los Paranoicos no se fusionan ni se cruzan alias", async () => {
      const first = await applyRecord({ source: "hardening-a", kind: "artist", identity: "Los Paranoias", fields: [["name", "Los Paranoias"]] });
      expect(first[0]).toMatchObject({ action: "applied", created: true });
      const paranoiasId = first[0]!.artistId!;
      // El parecido no basta para fusionar ni para crear: ER lo manda a una persona
      // con Los Paranoias como candidato, y el core no cambia.
      const similar = await applyOne({ source: "hardening-b", kind: "artist", identity: "Los Paranoicos", field: "name", value: "Los Paranoicos" });
      expect(similar.outcome.action).toBe("candidate");
      expect(similar.outcome.artistId).toBeUndefined();
      expect(await count("ingest.review_queue", "claim_a_id=$1 AND status='open' AND kind='ambiguous_alias' AND artist_a_id=$2", [similar.claimId, paranoiasId])).toBe(1);
      expect(await count("public.artists", "name IN ('Los Paranoias','Los Paranoicos')")).toBe(1);

      // La persona decide que son bandas distintas: se crea la segunda, sin alias cruzados.
      const decided = await applyOne({
        source: "hardening-b", kind: "artist", identity: "Los Paranoicos", field: "name", value: "Los Paranoicos",
        createdBy: "human", merge: { humanResolution: { verdict: "different", decidedBy: "hardening-contract" } },
      });
      expect(decided.outcome).toMatchObject({ action: "applied", created: true });
      expect(decided.outcome.artistId).not.toBe(paranoiasId);
      expect(await count("ingest.artist_aliases", "artist_id=$1 AND normalized_alias LIKE '%paranoicos%'", [paranoiasId])).toBe(0);
      expect(await count("ingest.artist_aliases", "artist_id=$1 AND normalized_alias LIKE '%paranoias%'", [decided.outcome.artistId])).toBe(0);
      expect((await getPool().query("SELECT name FROM public.artists WHERE id=$1", [paranoiasId])).rows[0]).toEqual({ name: "Los Paranoias" });
      expect(await count("public.artists", "name IN ('Los Paranoias','Los Paranoicos')")).toBe(2);
    }, 60_000);
  });

  describe("5 · dos personas homónimas", () => {
    it("el nombre solo no elige; el contexto elige al homónimo correcto", async () => {
      await applyRecord({ source: "hardening-a", kind: "artist", identity: "Sentimiento Muerto", fields: [["name", "Sentimiento Muerto"]] });
      await applyRecord({ source: "hardening-a", kind: "artist", identity: "Desorden Público", fields: [["name", "Desorden Público"]] });
      const first = await applyRecord({ source: "hardening-a", kind: "person", identity: "Carlos García", fields: [["name", "Carlos García"]] });
      expect(first[0]).toMatchObject({ action: "applied", created: true });
      const carlosUno = first[0]!.personId!;
      const membership = await applyRecord({
        source: "hardening-a", kind: "artist_membership", identity: "Sentimiento Muerto::Carlos García::Bajo",
        fields: [["artist_name", "Sentimiento Muerto"], ["person_name", "Carlos García"], ["role", "Bajo"], ["from_year", "1988"], ["to_year", "1992"]],
      });
      expect(membership[0]!.action).toBe("applied");

      // Otra fuente habla de otro Carlos García: una persona decide que son distintos.
      const second = await applyOne({
        source: "hardening-b", kind: "person", identity: "Carlos García", field: "name", value: "Carlos García",
        createdBy: "human", merge: { humanResolution: { verdict: "different", decidedBy: "hardening-contract" } },
      });
      expect(second.outcome).toMatchObject({ action: "applied", created: true });
      const carlosDos = second.outcome.personId!;
      expect(carlosDos).not.toBe(carlosUno);
      await getPool().query(`
        INSERT INTO public.artist_members(artist_id, person_id, role, from_year, to_year)
        SELECT id, $1, 'Batería', 2005, 2010 FROM public.artists WHERE name='Desorden Público'`, [carlosDos]);
      const membersBefore = await count("public.artist_members");

      const nameOnly = await applyOne({ source: "hardening-c", kind: "person", identity: "Carlos García", field: "name", value: "Carlos García" });
      expect(nameOnly.outcome.action).toBe("candidate");
      expect(nameOnly.outcome.personId).toBeUndefined();
      expect(await count("public.persons", "name='Carlos García'")).toBe(2);

      const contextual = await applyOne({
        source: "hardening-c", kind: "person", identity: "Carlos Garcia", field: "name", value: "Carlos Garcia",
        resolutionInput: { kind: "PERSON", name: "Carlos Garcia", bands: ["Desorden Público"], roles: ["batería"], period: { from: 2006, to: 2009 } },
      });
      const decision = await getPool().query<{ top: string | null; person_id: string | null }>(`
        SELECT candidates->0->>'candidateId' AS top, person_id::text FROM ingest.entity_resolution_decisions
         WHERE claim_id=$1 ORDER BY id DESC LIMIT 1`, [contextual.claimId]);
      expect(Number(decision.rows[0]!.top)).toBe(carlosDos);
      expect(contextual.outcome.personId === undefined || contextual.outcome.personId === carlosDos).toBe(true);
      expect(await count("public.persons", "name IN ('Carlos García','Carlos Garcia')")).toBe(2);
      expect(await count("public.artist_members")).toBe(membersBefore);
    }, 60_000);
  });

  describe("6 · alias con y sin tildes", () => {
    it("Pacífica y Pacifica solo se unen por un alias explícito", async () => {
      const accented = await applyRecord({ source: "hardening-a", kind: "artist", identity: "Pacífica", fields: [["name", "Pacífica"]] });
      expect(accented[0]).toMatchObject({ action: "applied", created: true });
      const pacificaId = accented[0]!.artistId!;

      const tildeOnly = await applyOne({ source: "hardening-b", kind: "artist", identity: "Pacifica", field: "name", value: "Pacifica" });
      expect(tildeOnly.outcome.action).toBe("candidate");
      expect(await count("public.artists", "name='Pacifica'")).toBe(0);

      const alias = await applyRecord({ source: "hardening-a", kind: "artist", identity: "Pacífica", fields: [["alias", "Pacifica"]] });
      expect(alias[0]).toMatchObject({ action: "applied", artistId: pacificaId });

      const afterAlias = await applyOne({ source: "hardening-c", kind: "artist", identity: "Pacifica", field: "name", value: "Pacifica" });
      expect(afterAlias.outcome.artistId).toBe(pacificaId);
      expect(["applied", "unchanged"]).toContain(afterAlias.outcome.action);
      expect(await count("public.artists", "name IN ('Pacífica','Pacifica')")).toBe(1);
      expect((await getPool().query("SELECT name FROM public.artists WHERE id=$1", [pacificaId])).rows[0]).toEqual({ name: "Pacífica" });
    }, 60_000);
  });

  describe("7 · dos fuentes con años distintos", () => {
    it("el año contradictorio abre un conflicto con ambas evidencias y no sobrescribe", async () => {
      await applyRecord({ source: "hardening-a", kind: "artist", identity: "Caramelos De Cianuro", fields: [["name", "Caramelos De Cianuro"]] });
      const albumFields = (year: string): Array<[string, unknown]> => [
        ["title", "Las Paticas De La Abuela"], ["artist_name", "Caramelos De Cianuro"], ["release_year", year], ["album_type", "ep"],
      ];
      const fromA = await applyRecord({ source: "hardening-a", kind: "album", identity: "Caramelos De Cianuro::Las Paticas De La Abuela", fields: albumFields("1992") });
      expect(fromA[0]).toMatchObject({ action: "applied", created: true });
      const albumId = fromA[0]!.albumId!;

      const fromB = await applyRecord({ source: "hardening-b", kind: "album", identity: "Caramelos De Cianuro::Las Paticas De La Abuela", fields: albumFields("1993"), page: "paticas" });
      expect(fromB.every((outcome) => outcome.albumId === undefined || outcome.albumId === albumId)).toBe(true);
      expect(fromB.find((_, index) => albumFields("1993")[index]![0] === "release_year")!.action).toBe("conflict");

      expect(await count("public.albums", "title='Las Paticas De La Abuela'")).toBe(1);
      expect((await getPool().query("SELECT release_year, album_type::text FROM public.albums WHERE id=$1", [albumId])).rows[0])
        .toEqual({ release_year: 1992, album_type: "ep" });
      const conflicts = await getPool().query<{ id: string; sources: string[]; evidences: string }>(`
        SELECT c.id::text,
               ARRAY[(SELECT s.slug FROM ingest.claims x JOIN ingest.sources s ON s.id=x.source_id WHERE x.id=c.claim_a_id),
                     (SELECT s.slug FROM ingest.claims x JOIN ingest.sources s ON s.id=x.source_id WHERE x.id=c.claim_b_id)] AS sources,
               (SELECT count(*) FROM ingest.claim_evidence e WHERE e.claim_id IN (c.claim_a_id, c.claim_b_id))::text AS evidences
          FROM ingest.conflicts c WHERE c.entity_kind='album' AND c.field='release_year' AND c.status='open'`);
      expect(conflicts.rows).toHaveLength(1);
      expect([...conflicts.rows[0]!.sources].sort()).toEqual(["hardening-a", "hardening-b"]);
      expect(Number(conflicts.rows[0]!.evidences)).toBe(2);
      expect(await count("ingest.review_queue", "status='open' AND conflict_id=$1", [Number(conflicts.rows[0]!.id)])).toBe(1);

      // Releer la MISMA página de B reutiliza el claim: ni conflicto ni revisión nuevos.
      const claimsBefore = await count("ingest.claims", "entity_kind='album'");
      const reread = await applyRecord({ source: "hardening-b", kind: "album", identity: "Caramelos De Cianuro::Las Paticas De La Abuela", fields: albumFields("1993"), page: "paticas" });
      expect(reread.find((_, index) => albumFields("1993")[index]![0] === "release_year")!.action).toBe("conflict");
      expect(await count("ingest.claims", "entity_kind='album'")).toBe(claimsBefore);
      expect(await count("ingest.conflicts", "entity_kind='album' AND field='release_year'")).toBe(1);
      expect(await count("ingest.review_queue", "kind='field_conflict' AND status='open'")).toBe(1);

      // Otra página de B con el mismo 1993 es evidencia nueva (otro raw_hash). Hoy abre
      // un SEGUNDO par con los mismos valores: ruido en la cola, no daño en el core
      // (FINAL_AUDIT.md, Known Issues KI-03). Lo que no puede cambiar: el core queda en
      // 1992 y cada conflicto abierto enfrenta al claim canónico de A con un 1993.
      await applyRecord({ source: "hardening-b", kind: "album", identity: "Caramelos De Cianuro::Las Paticas De La Abuela", fields: albumFields("1993"), page: "paticas-2" });
      expect((await getPool().query("SELECT release_year FROM public.albums WHERE id=$1", [albumId])).rows[0]).toEqual({ release_year: 1992 });
      const open = await getPool().query<{ value_a: unknown; value_b: unknown; slug_a: string; reviews: string }>(`
        SELECT c.value_a, c.value_b, s.slug AS slug_a,
               (SELECT count(*) FROM ingest.review_queue r WHERE r.conflict_id=c.id AND r.status='open')::text AS reviews
          FROM ingest.conflicts c JOIN ingest.claims a ON a.id=c.claim_a_id JOIN ingest.sources s ON s.id=a.source_id
         WHERE c.entity_kind='album' AND c.field='release_year' AND c.status='open'`);
      expect(open.rows).toHaveLength(2);
      for (const row of open.rows) expect(row).toEqual({ value_a: 1992, value_b: 1993, slug_a: "hardening-a", reviews: "1" });
    }, 60_000);
  });

  const FIRST = ["Aurelio", "Beatriz", "Cipriano", "Dalia", "Evaristo", "Fabiola", "Gustavo", "Hortensia", "Ignacio", "Julieta",
    "Leandro", "Marisol", "Nicanor", "Olga", "Patricio", "Quiteria", "Rodolfo", "Soledad", "Teodoro", "Úrsula",
    "Valentín", "Wilmer", "Ximena", "Yolanda", "Zacarías", "Anselmo", "Brígida", "Casimiro", "Delfina", "Eusebio"];
  const LAST = ["Acosta", "Bermúdez", "Contreras", "Duarte", "Escalona", "Figueroa", "Guevara", "Hurtado", "Istúriz", "Jiménez",
    "Landaeta", "Montilla", "Noguera", "Ochoa", "Pacheco", "Quintero", "Rangel", "Salazar", "Tovar", "Urdaneta",
    "Villegas", "Weffer", "Yánez", "Zambrano", "Arvelo", "Briceño", "Colmenares", "Dávila", "Echeverría", "Freites"];
  const INSTRUMENTS = ["Guitar", "Bass", "Drums", "Piano", "Violin", "Trumpet"];
  const MUSICIANS = FIRST.map((first, index) => `${first} ${LAST[index]!}`);
  const ORCHESTRA = "Orquesta Hardening";
  const ALBUM_30 = "Treinta Músicos";

  describe("8 · álbum con 30 músicos", () => {
    const creditAll = async () => {
      const outcomes = [];
      for (const [index, name] of MUSICIANS.entries()) {
        const role = INSTRUMENTS[index % INSTRUMENTS.length]!;
        outcomes.push(...await applyRecord({
          source: "hardening-a", kind: "album_credit", identity: `${ALBUM_30}::${name}::${role}`,
          fields: [["album_title", ALBUM_30], ["artist_name", ORCHESTRA], ["credited_name", name], ["credit_role", role], ["credit_scope", "album"]],
        }));
      }
      return outcomes;
    };

    it("treinta créditos musician, ninguna membresía, y la repetición es un no-op", async () => {
      await applyRecord({ source: "hardening-a", kind: "artist", identity: ORCHESTRA, fields: [["name", ORCHESTRA]] });
      const album = await applyRecord({
        source: "hardening-a", kind: "album", identity: `${ORCHESTRA}::${ALBUM_30}`,
        fields: [["title", ALBUM_30], ["artist_name", ORCHESTRA], ["release_year", "1999"]],
      });
      expect(album[0]).toMatchObject({ action: "applied", created: true });
      for (const name of MUSICIANS) {
        const person = await applyRecord({ source: "hardening-a", kind: "person", identity: name, fields: [["name", name]] });
        expect(person[0], name).toMatchObject({ action: "applied", created: true });
      }
      const where = "album_id=(SELECT id FROM public.albums WHERE title=$1)";
      const first = await creditAll();
      expect(first.filter((outcome) => outcome.action === "applied")).toHaveLength(30);
      expect(await count("public.album_credits", where, [ALBUM_30])).toBe(30);
      expect(await count("public.album_credits", `${where} AND credit_type='musician' AND person_id IS NOT NULL`, [ALBUM_30])).toBe(30);
      expect(await count("public.artist_members", "artist_id=(SELECT id FROM public.artists WHERE name=$1)", [ORCHESTRA])).toBe(0);

      const again = await creditAll();
      expect(again.every((outcome) => outcome.action === "unchanged")).toBe(true);
      expect(await count("public.album_credits", where, [ALBUM_30])).toBe(30);
    }, 180_000);
  });

  describe("9 · pista con múltiples créditos", () => {
    it("varias personas y la misma persona con dos roles son créditos distintos de la misma pista", async () => {
      for (const [number, title] of [[1, "Obertura"], [2, "Interludio"], [3, "Coda"]] as const) {
        const track = await applyRecord({
          source: "hardening-a", kind: "track", identity: `${ORCHESTRA}::${ALBUM_30}::${title}`,
          fields: [["title", title], ["album_title", ALBUM_30], ["artist_name", ORCHESTRA], ["track_number", String(number)]],
        });
        expect(track.map((item) => item.action)).toContain("applied");
      }
      const credits: Array<[string, string]> = [
        [MUSICIANS[0]!, "Guitar"], [MUSICIANS[1]!, "Vocals"], [MUSICIANS[0]!, "Composer"], [MUSICIANS[2]!, "Produced by"],
      ];
      for (const [name, role] of credits) {
        const outcome = await applyRecord({
          source: "hardening-a", kind: "track_credit", identity: `${ALBUM_30}::${name}::${role}::1`,
          fields: [["album_title", ALBUM_30], ["artist_name", ORCHESTRA], ["credited_name", name], ["credit_role", role],
            ["credit_scope", "track"], ["track_numbers", "track 01"]],
        });
        expect(outcome[0], `${name} ${role}`).toMatchObject({ action: "applied" });
      }
      const { rows } = await getPool().query<{ person: string; credit_type: string; role: string }>(`
        SELECT p.name AS person, c.credit_type::text, c.role
          FROM public.track_credits c JOIN public.tracks t ON t.id=c.track_id JOIN public.persons p ON p.id=c.person_id
         WHERE t.title='Obertura' ORDER BY c.id`);
      expect(rows).toEqual([
        { person: MUSICIANS[0], credit_type: "musician", role: "Guitar" },
        { person: MUSICIANS[1], credit_type: "musician", role: "Vocals" },
        { person: MUSICIANS[0], credit_type: "composer", role: "Composer" },
        { person: MUSICIANS[2], credit_type: "producer", role: "Produced by" },
      ]);
      expect(await count("public.track_credits", "track_id IN (SELECT id FROM public.tracks WHERE title IN ('Interludio','Coda'))")).toBe(0);
    }, 60_000);
  });

  describe("10 · video relacionado con varias pistas", () => {
    it("un video cubre varias pistas; la misma ocurrencia no se duplica", async () => {
      const video = await idOf("INSERT INTO media.youtube_videos(video_id,url) VALUES('HrdnTracks1','https://www.youtube.com/watch?v=HrdnTracks1') RETURNING id", []);
      const trackId = (title: string) => idOf("SELECT id FROM public.tracks WHERE title=$1", [title]);
      const insert = "INSERT INTO media.video_tracks(video_id,track_id,start_seconds,end_seconds,confidence) VALUES($1,$2,$3,$4,'high')";
      await getPool().query(insert, [video, await trackId("Obertura"), 0, 200]);
      await getPool().query(insert, [video, await trackId("Interludio"), 200, 330]);
      await getPool().query(insert, [video, await trackId("Coda"), 330, 500]);
      expect(await count("media.video_tracks", "video_id=$1", [video])).toBe(3);

      expect(await pgErrorCode(insert, [video, await trackId("Obertura"), 0, 200])).toBe("23505");
      // Una reprise real (la misma pista en otro minuto) es otra ocurrencia legítima.
      await getPool().query(insert, [video, await trackId("Obertura"), 500, 560]);
      expect(await pgErrorCode(insert, [video, await trackId("Coda"), 600, 590])).toBe("23514");
      expect(await count("media.video_tracks", "video_id=$1", [video])).toBe(4);
    }, 60_000);
  });

  describe("11 · álbum relacionado con varios videos", () => {
    it("un álbum admite varios videos y un solo enlace primario", async () => {
      const albumId = await idOf("SELECT id FROM public.albums WHERE title=$1", [ALBUM_30]);
      const full = await idOf("INSERT INTO media.youtube_videos(video_id,url) VALUES('HrdnAlbumA1','https://www.youtube.com/watch?v=HrdnAlbumA1') RETURNING id", []);
      const live = await idOf("INSERT INTO media.youtube_videos(video_id,url) VALUES('HrdnAlbumB2','https://www.youtube.com/watch?v=HrdnAlbumB2') RETURNING id", []);
      const extra = await idOf("INSERT INTO media.youtube_videos(video_id,url) VALUES('HrdnAlbumC3','https://www.youtube.com/watch?v=HrdnAlbumC3') RETURNING id", []);
      const insert = "INSERT INTO media.video_albums(video_id,album_id,album_kind,is_primary_link,confidence) VALUES($1,$2,$3::media.video_album_kind,$4,$5::ingest.confidence_level)";
      await getPool().query(insert, [full, albumId, "full_album", true, "high"]);
      await getPool().query(insert, [live, albumId, "live_concert", false, "medium"]);
      expect(await count("media.video_albums", "album_id=$1", [albumId])).toBe(2);

      expect(await pgErrorCode(insert, [extra, albumId, "full_album", true, "high"])).toBe("23505");
      expect(await pgErrorCode(insert, [full, albumId, "full_album", false, "high"])).toBe("23505");
      // Un enlace primario nunca descansa en evidencia low.
      const otherAlbum = await idOf("SELECT id FROM public.albums WHERE title='Las Paticas De La Abuela'", []);
      expect(await pgErrorCode(insert, [extra, otherAlbum, "full_album", true, "low"])).toBe("23514");
      expect(await count("media.video_albums", "album_id=$1 AND is_primary_link", [albumId])).toBe(1);
    }, 60_000);
  });

  describe("12 · persona extranjera acreditada en un álbum venezolano", () => {
    it("el crédito se conserva con la nacionalidad de la persona y sin volverla miembro", async () => {
      const name = "Gregorio Lindqvist";
      const person = await applyRecord({
        source: "hardening-a", kind: "person", identity: name,
        fields: [["name", name], ["nationality", "Suecia"], ["is_venezuelan", false]],
      });
      expect(person[0]).toMatchObject({ action: "applied", created: true });
      const membersBefore = await count("public.artist_members");
      const credit = await applyRecord({
        source: "hardening-a", kind: "album_credit", identity: `Las Paticas De La Abuela::${name}::Mastering`,
        fields: [["album_title", "Las Paticas De La Abuela"], ["artist_name", "Caramelos De Cianuro"], ["credited_name", name],
          ["credit_role", "Mastering"], ["credit_scope", "album"]],
      });
      expect(credit[0]!.action).toBe("applied");
      const { rows } = await getPool().query(`
        SELECT c.credit_type::text, p.nationality, p.is_venezuelan, ar.origin_country
          FROM public.album_credits c JOIN public.persons p ON p.id=c.person_id
          JOIN public.albums al ON al.id=c.album_id JOIN public.artists ar ON ar.id=al.artist_id
         WHERE p.name=$1`, [name]);
      expect(rows).toEqual([{ credit_type: "mastering", nationality: "Suecia", is_venezuelan: false, origin_country: "Venezuela" }]);
      expect(await count("public.artist_members")).toBe(membersBefore);
    }, 60_000);
  });

  describe("13 · un invitado no se convierte en miembro", () => {
    it("Guest Vocals queda como crédito guest y artist_members no cambia", async () => {
      const name = "Rosalba Mendoza";
      await applyRecord({ source: "hardening-a", kind: "person", identity: name, fields: [["name", name]] });
      const caramelos = await idOf("SELECT id FROM public.artists WHERE name='Caramelos De Cianuro'", []);
      const membersBefore = await count("public.artist_members", "artist_id=$1", [caramelos]);
      const credit = await applyRecord({
        source: "hardening-a", kind: "album_credit", identity: `Las Paticas De La Abuela::${name}::Guest Vocals`,
        fields: [["album_title", "Las Paticas De La Abuela"], ["artist_name", "Caramelos De Cianuro"], ["credited_name", name],
          ["credit_role", "Guest Vocals"], ["credit_scope", "album"]],
      });
      expect(credit[0]!.action).toBe("applied");
      expect((await getPool().query(`
        SELECT c.credit_type::text, c.role FROM public.album_credits c JOIN public.persons p ON p.id=c.person_id WHERE p.name=$1`, [name])).rows)
        .toEqual([{ credit_type: "guest", role: "Guest Vocals" }]);
      expect(await count("public.artist_members", "artist_id=$1", [caramelos])).toBe(membersBefore);
      expect(await count("public.artist_members", "person_id=(SELECT id FROM public.persons WHERE name=$1)", [name])).toBe(0);
      expect(await count("ingest.claims", "entity_kind='artist_membership' AND raw_value::text LIKE $1", [`%${name}%`])).toBe(0);
    }, 60_000);
  });
});
