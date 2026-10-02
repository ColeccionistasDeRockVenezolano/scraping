// CRV · PLAN_GENEROS etapa 4 contra Postgres real: fuentes externas de
// géneros. Ficha de evaluación y autorización, resolución de identidad
// auditable, importación como sugerencia (nunca como sobrescritura), umbral
// de precisión antes del volumen, y apagado sin perder lo editorial.
//
// La red no se toca: el adaptador real de MusicBrainz habla con un `fetcher`
// de prueba que devuelve respuestas con su forma, así que también se prueba
// cómo las lee.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { normalizeRecord } from "../../src/normalization/claims.js";
import { persistClaim, type ClaimToPersist } from "../../src/claims/persistence.js";
import { mergeClaim } from "../../src/merge/engine.js";
import { applyTaxonomyOperations, planTaxonomyFile } from "../../src/genres/admin.js";
import { runGenreBackfill } from "../../src/genres/backfill.js";
import { decideGenre, listGenreQueue, genreEntityDetail } from "../../src/genres/curation.js";
import { runAccept } from "../../src/genres/external/accept.js";
import { runExternalImport } from "../../src/genres/external/import.js";
import { loadSheetsFile } from "../../src/genres/external/sheets.js";
import {
  ExternalSourceError, insertSuggestion, openExternalCase, purgeSuggestions, recordPrecision, requireExternalSource,
  setExternalAuthorization, upsertExternalSource,
} from "../../src/genres/external/store.js";
import type { JsonFetcher } from "../../src/genres/external/http.js";

const ACTOR = "herra:ana";
const CONTEXT = { actor: ACTOR, reason: "prueba de contrato de la etapa 4" };

/** Respuestas con la forma de MusicBrainz; ninguna sale a la red. */
const ARTISTS: Record<string, Record<string, unknown>> = {
  "mbid-banda": {
    id: "mbid-banda", name: "Banda Externa QA", country: "VE", area: { name: "Venezuela" },
    genres: [{ name: "hard rock", count: 5 }],
    tags: [{ name: "venezuelan", count: 4 }, { name: "salsa", count: 1 }],
    "release-groups": [
      { id: "rg-uno", title: "Disco Externo", "first-release-date": "1988-03-01" },
      { id: "rg-dos", title: "Disco Confirmado", "first-release-date": "1991-01-01" },
      { id: "rg-tres", title: "Disco Ambiguo", "first-release-date": "1975-01-01" },
    ],
  },
  // Dos fichas igual de buenas: mismo nombre exacto y mismo país, sin nada que
  // las distinga. Es la forma real que tomó el 2026-09-23 contra MusicBrainz.
  "mbid-gemela-a": {
    id: "mbid-gemela-a", name: "Banda Gemela QA", country: "VE", area: { name: "Venezuela" },
    genres: [{ name: "hard rock", count: 9 }], tags: [], "release-groups": [],
  },
  "mbid-gemela-b": {
    id: "mbid-gemela-b", name: "Banda Gemela QA", country: "VE", area: { name: "Venezuela" },
    genres: [{ name: "salsa", count: 9 }], tags: [], "release-groups": [],
  },
};
const RELEASE_GROUPS: Record<string, Record<string, unknown>> = {
  "rg-uno": { id: "rg-uno", genres: [{ name: "thrash metal", count: 4 }], tags: [] },
  "rg-dos": { id: "rg-dos", genres: [{ name: "salsa", count: 3 }], tags: [] },
  "rg-tres": { id: "rg-tres", genres: [{ name: "hard rock", count: 2 }], tags: [] },
};

let requests = 0;
const fetcher: JsonFetcher = async (url) => {
  requests += 1;
  const lookup = /\/artist\/([^?]+)/u.exec(url);
  const group = /\/release-group\/([^?]+)/u.exec(url);
  if (url.includes("/artist?query=")) {
    const query = decodeURIComponent(url);
    if (query.includes("Banda Gemela QA")) {
      return { status: 200, payload: { artists: [
        { id: "mbid-gemela-a", name: "Banda Gemela QA" },
        { id: "mbid-gemela-b", name: "Banda Gemela QA" },
      ] } };
    }
    const wanted = query.includes("Banda Externa QA") || query.includes("Banda Externa");
    return { status: 200, payload: { artists: wanted ? [{ id: "mbid-banda", name: "Banda Externa QA" }] : [] } };
  }
  if (lookup) return { status: 200, payload: ARTISTS[lookup[1]!] ?? {} };
  if (group) return { status: 200, payload: RELEASE_GROUPS[group[1]!] ?? {} };
  throw new Error(`URL inesperada en la prueba: ${url}`);
};

describe("géneros: fuentes externas autorizadas (PLAN_GENEROS etapa 4)", () => {
  let container: PgContainer;
  let artist: number;
  let source: number;
  const albums: Record<string, number> = {};

  const pool = () => getPool();
  const one = async (sql: string, params: unknown[] = []): Promise<number> =>
    Number((await pool().query<{ id: string }>(sql, params)).rows[0]!.id);
  const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    (await pool().query(sql, params)).rows as T[];
  const withClient = async <T>(work: (client: import("pg").PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool().connect();
    try { return await work(client); } finally { client.release(); }
  };

  const assignments = (albumId: number) => rows<{
    slug: string; role: string; status: string; decision_kind: string; source_kind: string;
    external_ref: string | null; evidence: unknown; raw_value: string | null;
  }>(`
    SELECT g.slug, ag.role, ag.status, ag.decision_kind, ag.source_kind, ag.external_ref, ag.evidence, ag.raw_value
      FROM ingest.album_genres ag JOIN ingest.genres g ON g.id = ag.genre_id
     WHERE ag.album_id = $1 ORDER BY g.slug`, [albumId]);
  const openCases = (albumId: number) => rows<{ id: string; genre_case: string }>(`
    SELECT id::text, payload->>'genreCase' AS genre_case FROM ingest.review_queue
     WHERE album_id = $1 AND payload->>'origin' = 'genres-external' AND status IN ('open','in_progress') ORDER BY id`, [albumId]);

  const importAlbums = (over: Partial<Parameters<typeof runExternalImport>[0]> = {}) => runExternalImport({
    sourceSlug: "musicbrainz", level: "album", scope: "targets", confirm: true,
    actor: ACTOR, reason: "prueba", fetcher, entityIds: Object.values(albums), ...over,
  });

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    process.env["GENRES_PROJECTION_ENABLED"] = "true";
    process.env["GENRES_EXTERNAL_ENABLED"] = "true";
    // Sin contacto no se sale a la red ni con un fetcher de prueba: es la
    // misma regla que exigen MusicBrainz y Discogs.
    process.env["GENRES_EXTERNAL_CONTACT"] = "pruebas@crv.invalid";
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
    await applyTaxonomyOperations(await planTaxonomyFile(), { actor: "prueba", reason: "taxonomía aprobada" }, { confirm: true });

    artist = await one("INSERT INTO public.artists(name) VALUES('Banda Externa QA') RETURNING id");
    for (const [title, year] of [["Disco Externo", 1988], ["Disco Confirmado", 1991], ["Disco Ambiguo", null]] as const) {
      albums[title] = await one("INSERT INTO public.albums(artist_id,title,release_year) VALUES($1,$2,$3) RETURNING id", [artist, title, year]);
    }
    // Una clasificación editorial ya decidida: la fuente externa no puede tocarla.
    await decideGenre({
      action: "confirm_primary", kind: "album", entityId: albums["Disco Confirmado"]!, genreSlug: "hard-rock",
      actor: ACTOR, reason: "decidido por CRV antes de mirar fuera",
    });

    const [sheet] = await loadSheetsFile();
    source = (await withClient((client) => upsertExternalSource(client, sheet!, CONTEXT))).id;
  }, 180_000);

  afterAll(async () => {
    delete process.env["GENRES_PROJECTION_ENABLED"];
    delete process.env["GENRES_EXTERNAL_ENABLED"];
    delete process.env["GENRES_EXTERNAL_CONTACT"];
    resetEnvCache();
    await closeDb();
    await container?.stop();
  }, 60_000);

  it("la ficha se carga en evaluación y sin autorizar no se consulta la fuente", async () => {
    const ficha = await withClient((client) => requireExternalSource(client, "musicbrainz"));
    expect(ficha).toMatchObject({ status: "evaluating", importEnabled: false, bulkEnabled: false, precisionMeasured: null });
    expect(ficha.license).toMatch(/CC0/u);
    expect(ficha.attribution).not.toBe("");

    await expect(importAlbums()).rejects.toThrow(/no está autorizada|autorizada/u);
    // Habilitar la importación de una fuente sin autorizar tampoco se permite.
    await expect(withClient((client) => setExternalAuthorization(client, "musicbrainz", { importEnabled: true }, CONTEXT)))
      .rejects.toBeInstanceOf(ExternalSourceError);
  });

  it("autorizada pero sin importación habilitada, solo se puede medir la muestra", async () => {
    await withClient((client) => setExternalAuthorization(client, "musicbrainz", { status: "authorized" }, CONTEXT));
    await expect(importAlbums()).rejects.toThrow(/importación de musicbrainz está apagada/u);

    // La muestra mide contra lo que CRV ya confirmó y no escribe sugerencias.
    const sample = await runExternalImport({
      sourceSlug: "musicbrainz", level: "album", scope: "sample", confirm: true,
      actor: ACTOR, reason: "muestra", fetcher,
    });
    expect(sample.candidates).toBe(1);
    expect(sample.agreement).toMatchObject({ disagree: 1 });
    expect(sample.precision).toBe(0);
    expect(sample.suggestions.inserted).toBe(0);
    expect(await assignments(albums["Disco Confirmado"]!)).toEqual([
      expect.objectContaining({ slug: "hard-rock", status: "confirmed", decision_kind: "human" }),
    ]);
  });

  it("la carga masiva no exige umbral: una fuente basta (regla del 2026-09-26)", async () => {
    await withClient((client) => setExternalAuthorization(client, "musicbrainz", { importEnabled: true }, CONTEXT));
    const ensayo = await runExternalImport({
      sourceSlug: "musicbrainz", level: "album", scope: "pending", confirm: false, actor: ACTOR, reason: "ensayo", fetcher,
    });
    expect(ensayo.candidates).toBeGreaterThan(0);
    expect(await rows<{ n: string }>(
      "SELECT count(*)::text AS n FROM ingest.album_genres WHERE source_kind = 'external'")).toEqual([{ n: "0" }]);


    // Con una muestra que sí alcanza el umbral, el volumen se habilita.
    await withClient((client) => recordPrecision(client, "musicbrainz", { precision: 0.9, sampleSize: 20, report: "muestra revisada" }));
    const enabled = await withClient((client) => setExternalAuthorization(client, "musicbrainz", { bulkEnabled: true }, CONTEXT));
    expect(enabled.bulkEnabled).toBe(true);
    await withClient((client) => setExternalAuthorization(client, "musicbrainz", { bulkEnabled: false }, CONTEXT));
  });

  it("identifica con varias señales, importa como sugerencia y conserva fuente, identificador, fecha y evidencia", async () => {
    const report = await importAlbums();
    expect(report.identities.matched).toBe(2);
    expect(report.identities.ambiguous).toBe(1);

    const [row] = await assignments(albums["Disco Externo"]!);
    expect(row).toMatchObject({
      slug: "thrash-metal", role: "secondary", status: "suggested", decision_kind: "rule",
      source_kind: "external", external_ref: "rg-uno", raw_value: "thrash metal",
    });
    const evidence = (row!.evidence as Array<Record<string, unknown>>)[0]!;
    expect(evidence).toMatchObject({ sourceSlug: "musicbrainz", externalId: "rg-uno", tagKind: "editorial_genre" });
    expect(String(evidence["url"])).toContain("release-group/rg-uno");
    expect(Date.parse(String(evidence["fetchedAt"]))).toBeGreaterThan(0);

    // La identidad queda auditable: puntaje y señales, no «coincide el nombre».
    const identity = await rows<{ external_id: string; score: string; signals: Array<{ name: string }>; status: string }>(`
      SELECT external_id, score::text, signals, status FROM ingest.genre_external_identities
       WHERE entity_kind='album' AND entity_id=$1`, [albums["Disco Externo"]!]);
    expect(identity[0]).toMatchObject({ external_id: "rg-uno", status: "matched" });
    expect(identity[0]!.signals.map((signal) => signal.name)).toEqual(
      expect.arrayContaining(["artist_confirmed", "title_exact", "year_exact"]));
    expect(Number(identity[0]!.score)).toBeGreaterThanOrEqual(0.85);

    // Y el aporte queda medido.
    const [registered] = await rows<{ mode: string; stats: Record<string, unknown> }>(
      "SELECT mode, stats FROM ingest.genre_external_imports WHERE dry_run = false ORDER BY id DESC LIMIT 1");
    expect(registered!.mode).toBe("bulk");
    expect(registered!.stats["coverageAdded"]).toBe(1);
  });

  it("no toca lo confirmado por CRV: lo que discrepa va a revisión", async () => {
    const confirmed = await assignments(albums["Disco Confirmado"]!);
    expect(confirmed.find((row) => row.slug === "hard-rock")).toMatchObject({
      role: "primary", status: "confirmed", decision_kind: "human",
    });
    // La propuesta ajena existe, pero como sugerencia y con su caso abierto.
    expect(confirmed.find((row) => row.slug === "salsa")).toMatchObject({ status: "suggested", source_kind: "external" });
    expect((await openCases(albums["Disco Confirmado"]!)).map((row) => row.genre_case)).toContain("external_disagreement");
  });

  it("una identidad dudosa no sugiere nada y va a la cola", async () => {
    expect(await assignments(albums["Disco Ambiguo"]!)).toEqual([]);
    expect((await openCases(albums["Disco Ambiguo"]!)).map((row) => row.genre_case)).toEqual(["external_ambiguous_identity"]);
    const [identity] = await rows<{ status: string }>(
      "SELECT status FROM ingest.genre_external_identities WHERE entity_kind='album' AND entity_id=$1", [albums["Disco Ambiguo"]!]);
    expect(identity!.status).toBe("ambiguous");
  });

  it("la sugerencia llega a la Mesa y una persona la convierte en decisión", async () => {
    const queue = await withClient((client) => listGenreQueue(client, { category: "external_suggestion", limit: 50 }));
    const titles = queue.items.map((item) => item.title);
    expect(titles).toContain("Disco Externo");

    const detail = await withClient((client) => genreEntityDetail(client, "album", albums["Disco Externo"]!));
    const identities = detail!["externalIdentities"] as Array<Record<string, unknown>>;
    expect(identities[0]).toMatchObject({ sourceSlug: "musicbrainz", externalId: "rg-uno" });
    expect(String(identities[0]!["attribution"])).toMatch(/MusicBrainz/u);

    const decision = await decideGenre({
      action: "confirm_primary", kind: "album", entityId: albums["Disco Externo"]!, genreSlug: "thrash-metal",
      actor: ACTOR, reason: "la sugerencia externa coincide con la carátula",
    });
    expect(decision.albumGenre).toMatchObject({ after: "Thrash metal" });
    expect(await assignments(albums["Disco Externo"]!)).toEqual([
      expect.objectContaining({ slug: "thrash-metal", role: "primary", status: "confirmed", decision_kind: "human" }),
    ]);
  });

  it("repetir la importación no duplica sugerencias ni casos, y reusa la caché", async () => {
    const before = requests;
    const casesBefore = (await openCases(albums["Disco Confirmado"]!)).length;
    const report = await importAlbums();
    expect(requests).toBe(before);
    expect(report.network.cacheHits).toBeGreaterThan(0);
    expect(report.suggestions.inserted).toBe(0);
    expect((await openCases(albums["Disco Confirmado"]!)).length).toBe(casesBefore);
  });

  it("el recálculo de las reglas no borra las sugerencias externas, y adopta la que el catálogo confirma", async () => {
    const albumId = albums["Disco Ambiguo"]!;
    // Este disco no tiene ninguna sugerencia: le damos una por la vía normal.
    await withClient(async (client) => {
      await client.query(`
        INSERT INTO ingest.album_genres(album_id, genre_id, role, status, confidence, source_kind, claim_ids, raw_value,
                                        evidence, decided_by, decision_rule, decision_kind, external_source_id, external_ref)
        SELECT $1, g.id, 'secondary','suggested','medium','external','{}','hard rock','[]'::jsonb,'externa:musicbrainz',
               'external_suggestion','rule',$2,'rg-tres'
          FROM ingest.genres g WHERE g.slug = 'hard-rock'`, [albumId, source]);
    });

    const sourceId = await one(`
      INSERT INTO ingest.sources(slug,name,site_type,trust_level,enabled)
      VALUES('externa-qa','Fuente QA','website','high',true) RETURNING id`);
    const normalized = normalizeRecord({
      entityKind: "album", identity: `Externa QA::${albumId}`, extractor: "externa-fixture", extractorVersion: "1",
      fields: [{ field: "genre", value: "Hard Rock", evidence: { url: "https://fixture.invalid/externa/1" } }],
    })[0]!;
    const claim: ClaimToPersist = { ...normalized, sourceId, confidence: "high", albumId };
    await mergeClaim(claim, await persistClaim(claim));
    await runGenreBackfill({ confirm: true, actor: "prueba" });

    // La fila pasa a ser de las reglas (el catálogo lo afirma) y suelta la fuente externa…
    expect(await assignments(albumId)).toEqual([
      expect.objectContaining({ slug: "hard-rock", status: "confirmed", decision_kind: "rule", source_kind: "catalog_source", external_ref: null }),
    ]);
    // …mientras que la sugerencia de otro disco, sin claim que la respalde, sigue en pie.
    expect(await assignments(albums["Disco Confirmado"]!)).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: "salsa", status: "suggested", source_kind: "external" }),
    ]));
  });

  it("cierra la revisión de identidad cuando se confirma y no reabre una decisión humana", async () => {
    const albumId = albums["Disco Ambiguo"]!;
    await pool().query(`
      UPDATE ingest.genre_external_identities
         SET status = 'matched', decision_kind = 'human', decided_by = $2,
             reason = 'Identidad cotejada por una persona'
       WHERE entity_kind = 'album' AND entity_id = $1 AND external_id = 'rg-tres'`, [albumId, ACTOR]);

    const report = await importAlbums({ entityIds: [albumId] });
    expect(report.identities.matched).toBe(1);
    expect(await openCases(albumId)).toEqual([]);
    expect(await rows<{ status: string; resolved_by: string }>(`
      SELECT status, resolved_by FROM ingest.review_queue
       WHERE album_id = $1 AND payload->>'genreCase' = 'external_ambiguous_identity'`, [albumId]))
      .toEqual([{ status: "approved", resolved_by: "system" }]);

    const fingerprint = `external:manual-review:album:${albumId}`;
    await withClient(async (client) => {
      const caseId = await openExternalCase(client, "album", albumId, {
        genreCase: "external_disagreement", fingerprint,
        detail: { externalSourceId: source, externalSource: "musicbrainz" }, note: "revisión humana",
      });
      expect(caseId).not.toBeNull();
      await client.query(`
        UPDATE ingest.review_queue SET status = 'approved', resolved_by = 'human', resolved_at = now()
         WHERE id = $1`, [caseId]);
      expect(await openExternalCase(client, "album", albumId, {
        genreCase: "external_disagreement", fingerprint,
        detail: { externalSourceId: source, externalSource: "musicbrainz" }, note: "revisión humana",
      })).toBeNull();
    });
  });

  it("retirar la fuente borra sus propuestas sin resolver y conserva las decisiones humanas", async () => {
    const purged = await withClient(async (client) => {
      await client.query("BEGIN");
      await setExternalAuthorization(client, "musicbrainz", { importEnabled: false, bulkEnabled: false }, CONTEXT);
      const result = await purgeSuggestions(client, source);
      await client.query("COMMIT");
      return result;
    });
    expect(purged.album).toBeGreaterThan(0);

    expect(await rows("SELECT 1 FROM ingest.album_genres WHERE source_kind='external' AND status='suggested'")).toEqual([]);
    // Lo confirmado por una persona sigue intacto, venga de donde venga.
    expect(await assignments(albums["Disco Externo"]!)).toEqual([
      expect.objectContaining({ slug: "thrash-metal", status: "confirmed", decision_kind: "human" }),
    ]);
    expect(await assignments(albums["Disco Confirmado"]!)).toEqual([
      expect.objectContaining({ slug: "hard-rock", status: "confirmed", decision_kind: "human" }),
    ]);
    const ficha = await withClient((client) => requireExternalSource(client, "musicbrainz"));
    expect(ficha).toMatchObject({ importEnabled: false, bulkEnabled: false, status: "authorized" });
  });

  it("un género de artista nunca aterriza en un disco", async () => {
    await withClient((client) => setExternalAuthorization(client, "musicbrainz", { importEnabled: true }, CONTEXT));
    const before = await rows<{ n: string }>("SELECT count(*)::text AS n FROM ingest.album_genres");
    const report = await runExternalImport({
      sourceSlug: "musicbrainz", level: "artist", scope: "targets", confirm: true,
      actor: ACTOR, reason: "géneros de artista", fetcher, entityIds: [artist],
    });
    // El artista ya muestra hard rock por sus discos (0036): la fuente coincide
    // y no hay nada nuevo que proponer.
    expect(report.suggestions.inserted).toBe(0);
    const artistRows = await rows<{ slug: string; status: string; source_kind: string }>(`
      SELECT g.slug, ag.status, ag.source_kind FROM ingest.artist_genres ag JOIN ingest.genres g ON g.id = ag.genre_id
       WHERE ag.artist_id = $1 AND ag.source_kind <> 'albums'`, [artist]);
    expect(artistRows).toEqual([]);
    expect(await rows<{ slug: string }>(`
      SELECT g.slug FROM ingest.artist_genres ag JOIN ingest.genres g ON g.id = ag.genre_id
       WHERE ag.artist_id = $1 AND ag.source_kind = 'albums'`, [artist])).toEqual(expect.arrayContaining([{ slug: "hard-rock" }]));
    expect(await rows<{ n: string }>("SELECT count(*)::text AS n FROM ingest.album_genres")).toEqual(before);
  });

  it("un artista dudoso bloquea sus discos: se cuentan como dudosos y abren un solo caso", async () => {
    const gemela = await one("INSERT INTO public.artists(name) VALUES('Banda Gemela QA') RETURNING id");
    const discos: number[] = [];
    for (const title of ["Gemelo Uno", "Gemelo Dos"]) {
      discos.push(await one("INSERT INTO public.albums(artist_id,title) VALUES($1,$2) RETURNING id", [gemela, title]));
    }

    const report = await runExternalImport({
      sourceSlug: "musicbrainz", level: "album", scope: "targets", confirm: true,
      actor: ACTOR, reason: "artista con homónimo", fetcher, entityIds: discos,
    });

    // El resumen tiene que decir lo mismo que el detalle: no son fichas «sin
    // candidato», es una identidad dudosa la que las frena.
    expect(report.identities).toMatchObject({ matched: 0, ambiguous: 2, none: 0 });
    expect(report.suggestions.inserted).toBe(0);
    for (const disco of discos) expect(await assignments(disco)).toEqual([]);

    // Un solo caso, sobre el artista: resolverlo desbloquea toda su discografía.
    expect(report.cases.opened).toBe(1);
    const casos = await rows<{ genre_case: string; entity_kind: string }>(`
      SELECT payload->>'genreCase' AS genre_case, payload->>'entityKind' AS entity_kind FROM ingest.review_queue
       WHERE artist_a_id = $1 AND payload->>'origin' = 'genres-external' AND status IN ('open','in_progress')`, [gemela]);
    expect(casos).toEqual([{ genre_case: "external_ambiguous_identity", entity_kind: "artist" }]);

    // Repetirlo no abre un segundo caso ni cambia el recuento.
    const otra = await runExternalImport({
      sourceSlug: "musicbrainz", level: "album", scope: "targets", confirm: true,
      actor: ACTOR, reason: "misma pregunta", fetcher, entityIds: discos,
    });
    expect(otra.cases.opened).toBe(0);
    expect(otra.identities.ambiguous).toBe(2);
  });

  // Confirmación en bloque de lo que propuso la fuente (decisión de Brian del
  // 2026-09-24): la fuente sigue proponiendo, pero la persona acepta de una vez
  // en vez de ficha por ficha.
  describe("accept: confirmar en bloque", () => {
    let disco: number;

    const acepta = (over: Partial<Parameters<typeof runAccept>[0]> = {}) => runAccept({
      sourceSlug: "musicbrainz", level: "album", confirm: true, actor: ACTOR,
      reason: "aceptar lo de la fuente", secondaries: "leave", entityIds: [disco], ...over,
    });

    beforeAll(async () => {
      disco = await one("INSERT INTO public.albums(artist_id,title) VALUES($1,'Disco Para Aceptar') RETURNING id", [artist]);
      await withClient(async (client) => {
        // La fuente nombró primero el detalle y después el cajón, como hace Discogs.
        for (const [slug, raw] of [["thrash-metal", "thrash metal"], ["metal", "metal"]] as const) {
          await insertSuggestion(client, {
            kind: "album", entityId: disco, genreId: Number((await client.query(
              "SELECT id FROM ingest.genres WHERE slug=$1", [slug])).rows[0]!.id),
            sourceId: source, sourceSlug: "musicbrainz", externalId: "rg-aceptar", externalUrl: null,
            evidenceUrl: "https://musicbrainz.org/release-group/rg-aceptar", rawValue: raw, tagKind: "editorial_genre", tagCount: 4, fetchedAt: new Date(),
          });
        }
        await setExternalAuthorization(client, "musicbrainz", { importEnabled: true, bulkEnabled: true }, CONTEXT);
      });
    });

    it("una fuente bloqueada no se confirma en bloque; sin volumen sí", async () => {
      await withClient((client) => setExternalAuthorization(client, "musicbrainz", { status: "blocked" }, CONTEXT));
      await expect(acepta({ confirm: false })).rejects.toThrow(/bloqueada/u);
      await withClient((client) => setExternalAuthorization(client, "musicbrainz", { status: "authorized", importEnabled: true, bulkEnabled: false }, CONTEXT));
      expect((await acepta({ confirm: false })).primaries).toBe(1);
      await withClient((client) => setExternalAuthorization(client, "musicbrainz", { importEnabled: true, bulkEnabled: true }, CONTEXT));
    });

    it("en seco no escribe", async () => {
      const ensayo = await acepta({ confirm: false });
      expect(ensayo.primaries).toBe(1);
      expect((await assignments(disco)).every((row) => row.status === "suggested")).toBe(true);
    });

    it("el principal es el género más preciso, y el resto queda como propuesta", async () => {
      const report = await acepta();
      expect(report.primaries).toBe(1);
      expect(report.accepted[0]).toMatchObject({ entityId: disco, primary: "thrash-metal" });
      const filas = await assignments(disco);
      expect(filas.find((row) => row.slug === "thrash-metal")).toMatchObject({ role: "primary", status: "confirmed" });
      // La familia que el hijo vuelve redundante queda superseded, no confirmada.
      expect(filas.find((row) => row.slug === "metal")!.status).not.toBe("confirmed");
    });

    it("queda a nombre de la fuente, no de la persona, y ligado a su run", async () => {
      const registro = await rows<{ actor: string; run_id: string | null; action: string }>(`
        SELECT actor, run_id::text, action FROM ingest.genre_assignment_log
         WHERE entity_kind = 'album' AND entity_id = $1 AND action = 'confirm_primary' ORDER BY id DESC LIMIT 1`, [disco]);
      expect(registro[0]!.actor).toBe("auto:musicbrainz");
      expect(registro[0]!.run_id).not.toBeNull();
    });

    it("no vuelve a tocar una ficha que ya tiene principal confirmado", async () => {
      const otra = await acepta();
      expect(otra.candidates).toBe(0);
      expect(otra.primaries).toBe(0);
    });

    it("jamás pisa lo que decidió una persona", async () => {
      const report = await runAccept({
        sourceSlug: "musicbrainz", level: "album", confirm: true, actor: ACTOR,
        reason: "intento sobre lo editorial", secondaries: "leave", entityIds: [albums["Disco Confirmado"]!],
      });
      expect(report.candidates).toBe(0);
      const filas = await assignments(albums["Disco Confirmado"]!);
      expect(filas.find((row) => row.role === "primary" && row.status === "confirmed")).toMatchObject({
        slug: "hard-rock", decision_kind: "human",
      });
    });
  });
});
