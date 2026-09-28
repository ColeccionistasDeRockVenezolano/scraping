// CRV · PLAN_GENEROS etapa 3 contra Postgres real: curaduría editorial en la
// Mesa de Cotejo con sesión de herra, prioridad de la cola, decisiones
// humanas con run y diario, reversión a las reglas, lotes verificables,
// artista separado del disco y publicación en el catálogo.
import { randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
import {
  applyGenreBatch, batchMembers, decideGenre, genreEntityDetail, GenreCurationError, listBatchGroups, listGenreQueue,
} from "../../src/genres/curation.js";
import { getAlbumDetail, listAlbums } from "../../src/api/repositories/albums.js";
import { getArtistDetail } from "../../src/api/repositories/artists.js";
import { getTrackDetail } from "../../src/api/repositories/tracks.js";
import { HerraAccounts } from "../../src/api/herra-accounts.js";
import { buildServer } from "../../src/cotejo/server.js";

function herraHash(password: string): string {
  const salt = randomBytes(16);
  return `scrypt$16384$8$5$${salt.toString("hex")}$${scryptSync(password, salt, 64, { N: 16_384, r: 8, p: 5, maxmem: 64 * 1024 * 1024 }).toString("hex")}`;
}

describe("géneros: curaduría editorial en la Mesa (PLAN_GENEROS etapa 3)", () => {
  let container: PgContainer;
  let artist: number;
  let high: number;
  let medium: number;
  let track: number;
  let evidence = 0;
  const albums: Record<string, number> = {};
  const ACTOR = "herra:ana";

  const pool = () => getPool();
  const one = async (sql: string, params: unknown[] = []): Promise<number> =>
    Number((await pool().query<{ id: string }>(sql, params)).rows[0]!.id);
  const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    (await pool().query(sql, params)).rows as T[];
  const withClient = async <T>(work: (client: import("pg").PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool().connect();
    try { return await work(client); } finally { client.release(); }
  };

  async function album(title: string): Promise<number> {
    const id = await one("INSERT INTO public.albums(artist_id,title) VALUES($1,$2) RETURNING id", [artist, title]);
    albums[title] = id;
    return id;
  }

  async function genreClaim(sourceId: number, albumId: number, value: string) {
    evidence += 1;
    const normalized = normalizeRecord({
      entityKind: "album", identity: `Curaduria QA::disco ${albumId}`, extractor: "genres-fixture", extractorVersion: "1",
      fields: [{ field: "genre", value, evidence: { url: `https://fixture.invalid/curaduria/${evidence}` } }],
    })[0]!;
    const input: ClaimToPersist = { ...normalized, sourceId, confidence: "high", albumId };
    return mergeClaim(input, await persistClaim(input));
  }

  const assignments = (albumId: number) => rows<{ slug: string; role: string; status: string; decision_kind: string }>(`
    SELECT g.slug, ag.role, ag.status, ag.decision_kind FROM ingest.album_genres ag JOIN ingest.genres g ON g.id = ag.genre_id
     WHERE ag.album_id = $1 ORDER BY g.slug`, [albumId]);
  const albumGenre = async (albumId: number) =>
    (await rows<{ genre: string | null }>("SELECT genre FROM public.albums WHERE id=$1", [albumId]))[0]!.genre;
  const openCases = (albumId: number) => rows<{ id: string; genre_case: string }>(`
    SELECT id::text, payload->>'genreCase' AS genre_case FROM ingest.review_queue
     WHERE album_id = $1 AND payload->>'origin' LIKE 'genres%' AND status IN ('open','in_progress') ORDER BY id`, [albumId]);

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    process.env["GENRES_PROJECTION_ENABLED"] = "true";
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
    artist = await one("INSERT INTO public.artists(name) VALUES('Banda Curaduría QA') RETURNING id");
    high = await one("INSERT INTO ingest.sources(slug,name,site_type,trust_level,enabled) VALUES('cur-alta','Curaduría alta','website','high',true) RETURNING id");
    medium = await one("INSERT INTO ingest.sources(slug,name,site_type,trust_level,enabled) VALUES('cur-media','Curaduría media','blogspot','medium',true) RETURNING id");
    await applyTaxonomyOperations(await planTaxonomyFile(), { actor: "prueba", reason: "taxonomía aprobada" }, { confirm: true });

    await genreClaim(high, await album("Desacuerdo"), "Jazz");
    await genreClaim(medium, albums["Desacuerdo"]!, "Thrash Metal");
    await genreClaim(high, await album("Lote uno"), "Latin World/Rock");
    await genreClaim(high, await album("Lote dos"), "Latin World/Rock");
    await genreClaim(high, await album("Confirmado"), "Hard Rock");
    await album("Sin género");
    track = await one("INSERT INTO public.tracks(album_id,title,track_number) VALUES($1,'Pista QA',1) RETURNING id", [albums["Desacuerdo"]!]);
    await runGenreBackfill({ confirm: true, actor: "prueba" });
  }, 180_000);

  afterAll(async () => {
    delete process.env["GENRES_PROJECTION_ENABLED"];
    resetEnvCache();
    await closeDb();
    await container?.stop();
  }, 60_000);

  it("la cola muestra cada caso en su categoría y 'Sin clasificar' como un estado más", async () => {
    const all = await withClient((client) => listGenreQueue(client, { kind: "album", limit: 50 }));
    const byTitle = new Map(all.items.map((item) => [item.title, item]));
    expect(byTitle.get("Desacuerdo")?.categories).toEqual(["disagreement"]);
    expect(byTitle.get("Lote uno")?.categories).toContain("compound");
    expect(byTitle.get("Sin género")?.categories).toEqual(["unclassified"]);
    expect(byTitle.has("Confirmado")).toBe(false);
    // Conflictos antes que el resto (sin radio en esta base).
    expect(all.items[0]!.title).toBe("Desacuerdo");
    expect(all.counts.disagreement).toBe(1);

    const detail = await withClient((client) => genreEntityDetail(client, "album", albums["Desacuerdo"]!));
    expect(detail!["status"]).toBe("pending");
    const sources = detail!["sources"] as Array<{ level: string; rawValue: string }>;
    expect(sources.map((source) => source.rawValue).sort()).toEqual(["Jazz", "Thrash Metal"]);
    expect(sources.every((source) => source.level === "album")).toBe(true);
  });

  it("confirmar el principal cierra el caso a nombre de la persona, proyecta albums.genre y queda en el diario", async () => {
    const id = albums["Desacuerdo"]!;
    const reviewIds = (await openCases(id)).map((row) => Number(row.id));
    const result = await decideGenre({ action: "confirm_primary", kind: "album", entityId: id, genreSlug: "thrash-metal", actor: ACTOR, reason: "la ficha de la banda lo dice", reviewIds });
    expect(result.closedReviewIds).toEqual(reviewIds);
    expect(result.albumGenre).toMatchObject({ after: "Thrash metal", changed: true });
    expect(await albumGenre(id)).toBe("Thrash metal");
    expect(await assignments(id)).toContainEqual({ slug: "thrash-metal", role: "primary", status: "confirmed", decision_kind: "human" });
    const [closed] = await rows<{ status: string; resolved_by: string }>("SELECT status::text, resolved_by::text FROM ingest.review_queue WHERE id=$1", [reviewIds[0]]);
    expect(closed).toEqual({ status: "approved", resolved_by: "human" });
    const log = await rows<{ actor: string; action: string; run_id: string }>("SELECT actor, action, run_id::text FROM ingest.genre_assignment_log WHERE entity_id=$1", [id]);
    expect(log).toEqual([{ actor: ACTOR, action: "confirm_primary", run_id: String(result.runId) }]);
    const journal = await rows<{ table_name: string }>("SELECT DISTINCT table_name FROM ingest.change_journal WHERE run_id=$1", [result.runId]);
    expect(journal.map((row) => row.table_name)).toEqual(expect.arrayContaining(["ingest.album_genres", "public.albums"]));

    // Publicado en el catálogo: disco, lista filtrada por familia y pista (hereda del disco).
    const detail = await getAlbumDetail(id);
    expect(detail).toMatchObject({ genreStatus: "confirmed", primaryGenre: { slug: "thrash-metal", family: "metal" } });
    expect(detail!.genres.map((genre) => genre.slug)).toEqual(["thrash-metal"]);
    const metal = await listAlbums({ limit: 50, offset: 0, genre: "metal" });
    expect(metal.rows.map((row) => row.title)).toEqual(["Desacuerdo"]);
    expect((await listAlbums({ limit: 50, offset: 0, genre: "jazz" })).total).toBe(0);
    expect(await getTrackDetail(track)).toMatchObject({ genreOrigin: "album", primaryGenre: { slug: "thrash-metal" } });

    // Un recálculo posterior no reabre el caso ni cambia la decisión humana.
    await runGenreBackfill({ confirm: true, actor: "prueba" });
    expect(await openCases(id)).toEqual([]);
    expect(await albumGenre(id)).toBe("Thrash metal");
  });

  it("nunca hay dos principales confirmados y revertir vuelve a lo que dicen las reglas hoy", async () => {
    const id = albums["Desacuerdo"]!;
    await decideGenre({ action: "confirm_primary", kind: "album", entityId: id, genreSlug: "jazz", actor: ACTOR, reason: "cambio de criterio" });
    const primaries = (await assignments(id)).filter((row) => row.role === "primary" && row.status === "confirmed");
    expect(primaries.map((row) => row.slug)).toEqual(["jazz"]);
    expect(await albumGenre(id)).toBe("Jazz");
    await expect(pool().query(
      "UPDATE ingest.album_genres SET role='primary' WHERE album_id=$1 AND genre_id=(SELECT id FROM ingest.genres WHERE slug='thrash-metal')", [id],
    )).rejects.toThrow(/album_genres_one_primary_uk/);

    for (const slug of ["jazz", "thrash-metal"]) {
      await decideGenre({ action: "revert", kind: "album", entityId: id, genreSlug: slug, actor: ACTOR, reason: "vuelve a las fuentes" });
    }
    const after = await assignments(id);
    expect(after.every((row) => row.decision_kind === "rule" && row.status === "suggested")).toBe(true);
    // Sin principal, la proyección muestra el texto de la fuente de mayor rango y queda pendiente.
    expect(await albumGenre(id)).toBe("Jazz");
    expect((await getAlbumDetail(id))!.genreStatus).toBe("pending");
    const actions = await rows<{ action: string }>("SELECT action FROM ingest.genre_assignment_log WHERE entity_id=$1 ORDER BY id", [id]);
    expect(actions.map((row) => row.action)).toEqual(["confirm_primary", "demote_primary", "confirm_primary", "revert", "revert"]);
  });

  it("confirmar el género del artista no toca ningún disco ni pista", async () => {
    const before = await rows("SELECT album_id, genre_id, role, status, decision_kind FROM ingest.album_genres ORDER BY id");
    const shown = await rows("SELECT id, genre FROM public.albums ORDER BY id");
    await decideGenre({ action: "confirm_primary", kind: "artist", entityId: artist, genreSlug: "rock", actor: ACTOR, reason: "trayectoria de la banda" });
    expect(await rows("SELECT album_id, genre_id, role, status, decision_kind FROM ingest.album_genres ORDER BY id")).toEqual(before);
    expect(await rows("SELECT id, genre FROM public.albums ORDER BY id")).toEqual(shown);
    expect((await getArtistDetail(artist))!.primaryGenre?.slug).toBe("rock");
    // La pista sigue con lo de su álbum (pendiente), no con el rock del artista.
    expect(await getTrackDetail(track)).toMatchObject({ genreOrigin: "album", primaryGenre: null, genreStatus: "pending" });
    const detail = await withClient((client) => genreEntityDetail(client, "album", albums["Desacuerdo"]!));
    expect(detail!["artistContext"]).toMatchObject({ label: "del artista, no del disco" });
  });

  it("el lote exige la lista completa y vigente, y la aplica en un solo run", async () => {
    const groups = await withClient(listBatchGroups);
    const group = groups.find((item) => item.normalized.includes("latin world"));
    expect(group).toMatchObject({ kind: "album", entities: 2 });
    const members = await withClient((client) => batchMembers(client, "album", "latin world/rock"));
    expect(members.map((member) => member.title).sort()).toEqual(["Lote dos", "Lote uno"]);

    await expect(applyGenreBatch({
      action: "confirm_primary", kind: "album", rawValue: "Latin World/Rock", genreSlug: "rock",
      expectedReviewIds: [members[0]!.reviewId], actor: ACTOR, reason: "lote incompleto",
    })).rejects.toBeInstanceOf(GenreCurationError);
    expect(await albumGenre(albums["Lote uno"]!)).not.toBe("Rock");

    const result = await applyGenreBatch({
      action: "confirm_primary", kind: "album", rawValue: "Latin World/Rock", genreSlug: "rock",
      expectedReviewIds: members.map((member) => member.reviewId), actor: ACTOR, reason: "la fuente solo dice rock con certeza",
    });
    expect(result.applied).toBe(2);
    for (const title of ["Lote uno", "Lote dos"]) {
      expect(await albumGenre(albums[title]!)).toBe("Rock");
      expect(await openCases(albums[title]!)).toEqual([]);
    }
    const runs = await rows<{ run_id: string }>("SELECT DISTINCT run_id::text FROM ingest.genre_assignment_log WHERE reason LIKE '%(lote%'");
    expect(runs).toEqual([{ run_id: String(result.runId) }]);
  });

  it("evidencia insuficiente saca la ficha de la cola sin inventar nada; reabrir la devuelve", async () => {
    const id = albums["Sin género"]!;
    const inQueue = async () => (await withClient((client) => listGenreQueue(client, { category: "unclassified", kind: "album", limit: 200 })))
      .items.some((item) => item.entityId === id);
    expect(await inQueue()).toBe(true);
    await decideGenre({ action: "insufficient_evidence", kind: "album", entityId: id, actor: ACTOR, reason: "ninguna fuente lo dice" });
    expect(await inQueue()).toBe(false);
    expect(await assignments(id)).toEqual([]);
    expect(await albumGenre(id)).toBeNull();
    await decideGenre({ action: "reopen", kind: "album", entityId: id, actor: ACTOR, reason: "apareció una reseña" });
    expect(await inQueue()).toBe(true);
    await expect(decideGenre({ action: "reopen", kind: "album", entityId: id, actor: ACTOR, reason: "otra vez" }))
      .rejects.toMatchObject({ code: "conflict" });
  });

  it("solicitar un término nuevo abre un caso que el recálculo no cierra", async () => {
    const id = albums["Confirmado"]!;
    const result = await decideGenre({
      action: "request_new_term", kind: "album", entityId: id, proposedName: "Latin world", familySlug: "rock",
      actor: ACTOR, reason: "término frecuente en Sincopa",
    });
    expect(result.newReviewId).toBeGreaterThan(0);
    await runGenreBackfill({ confirm: true, actor: "prueba" });
    const queue = await withClient((client) => listGenreQueue(client, { category: "new_term", limit: 10 }));
    expect(queue.items.map((item) => item.entityId)).toEqual([id]);
    expect(queue.items[0]!.rawValues).toEqual(["Latin world"]);
  });

  describe("la Mesa exige sesión de administrador de herra para escribir", () => {
    let dir: string;
    let db: DatabaseSync;
    let accounts: HerraAccounts;
    let app: ReturnType<typeof buildServer>;

    beforeAll(async () => {
      dir = mkdtempSync(path.join(tmpdir(), "crv-cotejo-herra-"));
      const file = path.join(dir, "roadmap.db");
      db = new DatabaseSync(file);
      db.exec(`
        CREATE TABLE projects (id INTEGER PRIMARY KEY, slug TEXT NOT NULL);
        CREATE TABLE users (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, name TEXT NOT NULL COLLATE NOCASE,
          first_name TEXT, last_name TEXT, access_code_hash TEXT, session_version INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'approved');
        CREATE TABLE admins (id INTEGER PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE, password_hash TEXT NOT NULL,
          role TEXT NOT NULL, project_id INTEGER, session_version INTEGER NOT NULL DEFAULT 0);
        INSERT INTO projects VALUES (1, 'coleccionistas-rock-venezolano');`);
      const hash = herraHash("clave");
      db.prepare("INSERT INTO users (id, project_id, name, access_code_hash) VALUES (1, 1, 'lector', ?)").run(hash);
      db.prepare("INSERT INTO admins (id, username, password_hash, role, project_id) VALUES (1, 'ana', ?, 'admin', 1)").run(hash);
      db.prepare("INSERT INTO admins (id, username, password_hash, role, project_id) VALUES (2, 'jefe', ?, 'superadmin', NULL)").run(hash);
      accounts = new HerraAccounts(file, "coleccionistas-rock-venezolano");
      app = buildServer({ herra: accounts });
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
      accounts.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });

    const login = async (username: string) => {
      const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "clave" } });
      expect(response.statusCode).toBe(200);
      return { cookie: (response.headers["set-cookie"] as string).split(";", 1)[0]!, csrf: response.json().csrf as string };
    };
    const logCount = async () => Number((await rows<{ n: string }>("SELECT count(*)::text AS n FROM ingest.genre_assignment_log"))[0]!.n);
    const payload = (reason: string) => ({ action: "add_secondary", kind: "album", entityId: albums["Confirmado"]!, genreSlug: "blues-rock", reason, decidedBy: "alguien-inventado" });

    it("401 sin sesión, 403 sin rol de administrador o sin CSRF, y ninguna escribe", async () => {
      const before = await logCount();
      const anonymous = await app.inject({ method: "POST", url: "/api/genres/decisions", payload: payload("sin sesión") });
      expect(anonymous.statusCode).toBe(401);

      const reader = await login("lector");
      const denied = await app.inject({ method: "POST", url: "/api/genres/decisions", headers: { cookie: reader.cookie, "x-crv-csrf": reader.csrf }, payload: payload("lector") });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({ code: "admin_required" });

      const admin = await login("ana");
      const noCsrf = await app.inject({ method: "POST", url: "/api/genres/decisions", headers: { cookie: admin.cookie }, payload: payload("sin csrf") });
      expect(noCsrf.statusCode).toBe(403);
      const batch = await app.inject({ method: "POST", url: "/api/genres/batch", payload: { action: "confirm_primary", kind: "album", rawValue: "x", genreSlug: "rock", expectedReviewIds: [1], reason: "lote anónimo" } });
      expect(batch.statusCode).toBe(401);
      expect(await logCount()).toBe(before);

      // Leer no exige sesión.
      expect((await app.inject({ method: "GET", url: "/api/genres/queue?limit=5" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: `/api/genres/entity/album/${albums["Confirmado"]!}` })).statusCode).toBe(200);
    });

    it("un administrador decide y la firma sale de la sesión, no del navegador", async () => {
      const admin = await login("ana");
      const response = await app.inject({ method: "POST", url: "/api/genres/decisions", headers: { cookie: admin.cookie, "x-crv-csrf": admin.csrf }, payload: payload("se oye blues en el disco") });
      expect(response.statusCode).toBe(200);
      const [last] = await rows<{ actor: string; action: string }>("SELECT actor, action FROM ingest.genre_assignment_log ORDER BY id DESC LIMIT 1");
      expect(last).toEqual({ actor: "herra:ana", action: "confirm_secondary" });
      const boss = await login("jefe");
      const reverted = await app.inject({ method: "POST", url: "/api/genres/decisions", headers: { cookie: boss.cookie, "x-crv-csrf": boss.csrf },
        payload: { action: "revert", kind: "album", entityId: albums["Confirmado"]!, genreSlug: "blues-rock", reason: "no hay evidencia escrita" } });
      expect(reverted.statusCode).toBe(200);
      expect((await assignments(albums["Confirmado"]!)).map((row) => row.slug)).toEqual(["hard-rock"]);
    });

    it("una sesión que herra invalida deja de escribir en la siguiente petición", async () => {
      const admin = await login("ana");
      db.prepare("UPDATE admins SET session_version = session_version + 1 WHERE id = 1").run();
      const response = await app.inject({ method: "POST", url: "/api/genres/decisions", headers: { cookie: admin.cookie, "x-crv-csrf": admin.csrf }, payload: payload("sesión vieja") });
      expect(response.statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: admin.cookie } })).statusCode).toBe(401);
    });
  });
});
