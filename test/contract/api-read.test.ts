// CRV · E7A — API de lectura (docs/PHASES.md §E7A). Contra una PostgreSQL
// desechable: aplica el core, migra, siembra el caso de aceptación Caramelos
// De Cianuro / Las Paticas De La Abuela directamente en las tablas core +
// media (sin pasar por el pipeline de ingestión: esta suite prueba la API,
// no el merge engine) y ejercita cada ruta con `app.inject()`.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb, getDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { buildApp } from "../../src/api/app.js";
import {
  albumCredits, albums, artists, organizations, persons, trackCredits, tracks,
} from "../../src/db/schema/core.js";
import { artistAliases, trackAliases, sources, claims, reviewQueue } from "../../src/db/schema/ingest.js";
import { videoAlbums, videoArtists, videoTracks, youtubeVideos } from "../../src/db/schema/media.js";

const ADMIN_TOKEN = "token-de-prueba-lectura-admin-0123456789";
const admin = { authorization: `Bearer ${ADMIN_TOKEN}` };

describe("API de lectura (E7A) — caso Caramelos De Cianuro", () => {
  let container: PgContainer;
  let app: FastifyInstance;

  let artistId: number;
  let albumId: number;
  let trackIds: number[];
  let sourceId: number;
  let boriMilanId: number;

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    process.env["CRV_OPERATOR_TOKEN"] = ADMIN_TOKEN;
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();

    const db = getDb();

    const [source] = await db.insert(sources).values({
      slug: "fixture-api", name: "Fixture API", siteType: "website", trustLevel: "high", enabled: true,
    }).returning({ id: sources.id });
    sourceId = source!.id;

    const [artist] = await db.insert(artists).values({
      name: "Caramelos De Cianuro", artistType: "band", originCity: "Caracas",
    }).returning({ id: artists.id });
    artistId = artist!.id;
    await db.insert(artistAliases).values({
      artistId, alias: "Caramelos de Cianuro", normalizedAlias: "caramelos de cianuro", isPrimary: true,
    });

    const personNames = [
      "Asier Cazalis", "Miguel Gonzáles \"El Enano\"", "Luis \"Golding\" Barrios",
      "Pablo Martínez", "Boris Milan", "Carlos Rondon",
    ];
    const insertedPersons = await db.insert(persons).values(personNames.map((name) => ({ name }))).returning({ id: persons.id, name: persons.name });
    const personId = (name: string): number => insertedPersons.find((p) => p.name === name)!.id;
    boriMilanId = personId("Boris Milan");

    const [studio] = await db.insert(organizations).values({
      name: "Mad Box's Studios", organizationType: "recording_studio", country: "Venezuela",
    }).returning({ id: organizations.id });

    const [album] = await db.insert(albums).values({
      artistId, title: "Las Paticas De La Abuela", releaseYear: 1992, albumType: "ep",
      youtubeUrl: "https://www.youtube.com/watch?v=Q-pRpO2sYSI",
    }).returning({ id: albums.id });
    albumId = album!.id;

    const trackTitles: Array<[number, string]> = [
      [1, "Chan², Chaca², Chan²"], [2, "Tu Mamá Te Va a Pegar"], [3, "La Bruja"], [4, "Nadando a Través De La Galaxia"],
    ];
    const insertedTracks = await db.insert(tracks).values(
      trackTitles.map(([trackNumber, title]) => ({ albumId, trackNumber, title })),
    ).returning({ id: tracks.id, trackNumber: tracks.trackNumber });
    trackIds = trackTitles.map(([n]) => insertedTracks.find((t) => t.trackNumber === n)!.id);

    await db.insert(albumCredits).values([
      { albumId, personId: personId("Asier Cazalis"), creditType: "musician", role: "Lead Vocals & Bass" },
      { albumId, personId: personId("Miguel Gonzáles \"El Enano\""), creditType: "musician", role: "Guitar & Backing Vocals" },
      { albumId, personId: personId("Luis \"Golding\" Barrios"), creditType: "musician", role: "Guitar & Backing Vocals" },
      { albumId, personId: personId("Pablo Martínez"), creditType: "musician", role: "Drums & Backing Vocals" },
      { albumId, artistId, creditType: "producer", role: "Produced by" },
      { albumId, artistId, creditType: "writer", role: "Written by" },
      { albumId, personId: boriMilanId, creditType: "recording", role: "Recorded by" },
      { albumId, personId: boriMilanId, creditType: "mixing", role: "Mixed by" },
      { albumId, personId: personId("Pablo Martínez"), creditType: "artwork", role: "Artwork & Illustration" },
      { albumId, personId: personId("Carlos Rondon"), creditType: "photography", role: "Photography" },
      { albumId, organizationId: studio!.id, creditType: "recording", role: "Recorded at" },
    ]);

    await db.insert(trackCredits).values({
      trackId: trackIds[0]!, personId: personId("Asier Cazalis"), creditType: "musician", role: "Lead Vocals & Bass",
    });
    await db.insert(trackAliases).values({
      trackId: trackIds[2]!, alias: "Hechicera", normalizedAlias: "hechicera", isPrimary: true,
    });

    const [video] = await db.insert(youtubeVideos).values({
      videoId: "Q-pRpO2sYSI", url: "https://www.youtube.com/watch?v=Q-pRpO2sYSI",
      title: "Caramelos De Cianuro - Las Paticas De La Abuela (1992) Full EP",
      channelTitle: "Coleccionistas De Rock Venezolano", publicationStatus: "published",
    }).returning({ id: youtubeVideos.id });
    await db.insert(videoAlbums).values({ videoId: video!.id, albumId, albumKind: "full_album", isPrimaryLink: true });
    await db.insert(videoArtists).values({ videoId: video!.id, artistId, relationKind: "performer" });
    const starts = [0, 247, 475, 615];
    await db.insert(videoTracks).values(trackIds.map((trackId, index) => ({
      videoId: video!.id, trackId, startSeconds: starts[index]!,
    })));

    const [originClaim] = await db.insert(claims).values({
      sourceId, entityKind: "artist", artistId, field: "origin_city",
      rawValue: "Caracas", rawHash: createHash("sha256").update("fixture-hash-1").digest("hex"), confidence: "high", status: "accepted",
    }).returning({ id: claims.id });

    await db.insert(reviewQueue).values({
      kind: "possible_duplicate", status: "open", priority: 7, albumId, claimAId: originClaim!.id, notes: "fixture de revisión",
    });

    app = await buildApp();
  }, 120_000);

  afterAll(async () => { await app?.close(); await closeDb(); delete process.env["CRV_OPERATOR_TOKEN"]; resetEnvCache(); await container.stop(); }, 60_000);

  it("GET /health reporta la base viva", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, database: true });
  });

  it("GET /search encuentra a Caramelos De Cianuro por alias y a Boris Milan", async () => {
    const res = await app.inject({ method: "GET", url: "/search?q=caramelos" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.artist).toEqual([{ type: "artist", id: artistId, label: "Caramelos De Cianuro", context: "Caracas", albumId: null }]);
    expect(body.album).toEqual([]);

    const byTitle = await app.inject({ method: "GET", url: "/search?q=Paticas" });
    expect(byTitle.json().album[0]).toMatchObject({ type: "album", id: albumId, label: "Las Paticas De La Abuela", context: "Caramelos De Cianuro" });

    const byAlias = await app.inject({ method: "GET", url: "/search?q=cianuro&types=artist" });
    expect(byAlias.json().artist).toHaveLength(1);
    expect(byAlias.json().person).toEqual([]);

    const person = await app.inject({ method: "GET", url: "/search?q=Boris Milan" });
    expect(person.json().person[0]).toMatchObject({ type: "person", id: boriMilanId, label: "Boris Milan" });
  });

  it("GET /search exige q y valida types", async () => {
    const missing = await app.inject({ method: "GET", url: "/search" });
    expect(missing.statusCode).toBe(400);
    const badType = await app.inject({ method: "GET", url: "/search?q=x&types=nope" });
    expect(badType.statusCode).toBe(400);
  });

  it("GET /artists/:id devuelve la ficha con discografía", async () => {
    const res = await app.inject({ method: "GET", url: `/artists/${artistId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe("Caramelos De Cianuro");
    expect(body.discography).toEqual([
      expect.objectContaining({ albumId, title: "Las Paticas De La Abuela", releaseYear: 1992, albumType: "ep" }),
    ]);
    expect(body.aliases).toEqual([{ id: expect.any(Number), alias: "Caramelos de Cianuro", aliasType: "name_variant", isPrimary: true }]);
  });

  it("GET /artists/:id inexistente responde 404 con forma consistente", async () => {
    const res = await app.inject({ method: "GET", url: "/artists/999999" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("GET /albums/:id trae pistas, créditos y video (Las Paticas De La Abuela)", async () => {
    const res = await app.inject({ method: "GET", url: `/albums/${albumId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.title).toBe("Las Paticas De La Abuela");
    expect(body.artist).toEqual({ id: artistId, name: "Caramelos De Cianuro" });

    expect(body.tracklist).toHaveLength(4);
    expect(body.tracklist.map((t: { title: string }) => t.title)).toEqual([
      "Chan², Chaca², Chan²", "Tu Mamá Te Va a Pegar", "La Bruja", "Nadando a Través De La Galaxia",
    ]);
    expect(body.tracklist[0].credits).toEqual([
      expect.objectContaining({ creditType: "musician", role: "Lead Vocals & Bass", personName: "Asier Cazalis" }),
    ]);

    expect(body.creditsByType.musician).toHaveLength(4);
    expect(body.creditsByType.producer[0]).toMatchObject({ role: "Produced by", artistName: "Caramelos De Cianuro" });
    expect(body.creditsByType.recording).toHaveLength(2);
    expect(body.creditsByType.recording.map((c: { role: string }) => c.role).sort()).toEqual(["Recorded at", "Recorded by"]);
    expect(body.creditsByType.artwork[0]).toMatchObject({ personName: "Pablo Martínez" });
    expect(body.creditsByType.photography[0]).toMatchObject({ personName: "Carlos Rondon" });

    expect(body.youtubeLinks).toEqual([
      { videoId: "Q-pRpO2sYSI", title: "Caramelos De Cianuro - Las Paticas De La Abuela (1992) Full EP", kind: "full_album", isPrimaryLink: true },
    ]);
  });

  it("GET /albums pagina y filtra por artista", async () => {
    const res = await app.inject({ method: "GET", url: `/albums?artistId=${artistId}&limit=10` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ pagination: { total: 1 }, data: [{ id: albumId }] });
  });

  it("GET /tracks lista por disco, filtra por título y alias, y pagina", async () => {
    const byAlbum = await app.inject({ method: "GET", url: `/tracks?albumId=${albumId}` });
    expect(byAlbum.statusCode).toBe(200);
    const page = byAlbum.json();
    expect(page.pagination).toMatchObject({ total: 4, limit: 50, offset: 0 });
    expect(page.data.map((t: { trackNumber: number; albumTitle: string; artistName: string }) =>
      [t.trackNumber, t.albumTitle, t.artistName])).toEqual([
      [1, "Las Paticas De La Abuela", "Caramelos De Cianuro"],
      [2, "Las Paticas De La Abuela", "Caramelos De Cianuro"],
      [3, "Las Paticas De La Abuela", "Caramelos De Cianuro"],
      [4, "Las Paticas De La Abuela", "Caramelos De Cianuro"],
    ]);
    expect(page.data[0]).toMatchObject({ title: "Chan², Chaca², Chan²", discNumber: 1, creditCount: 1 });

    const byText = await app.inject({ method: "GET", url: "/tracks?q=bruja" });
    expect(byText.json().data.map((t: { title: string }) => t.title)).toEqual(["La Bruja"]);

    // El alias propio también encuentra la pista (CRUD simétrico con las fichas).
    const byAlias = await app.inject({ method: "GET", url: "/tracks?q=hechicera" });
    expect(byAlias.json().data.map((t: { title: string }) => t.title)).toEqual(["La Bruja"]);

    const limited = await app.inject({ method: "GET", url: `/tracks?albumId=${albumId}&limit=2&offset=2` });
    expect(limited.json().data.map((t: { trackNumber: number }) => t.trackNumber)).toEqual([3, 4]);
    expect(limited.json().pagination.total).toBe(4);
  });

  it("GET /tracks/:id trae contexto, alias y créditos propios, y 404 si no existe", async () => {
    const res = await app.inject({ method: "GET", url: `/tracks/${trackIds[0]}` });
    expect(res.statusCode).toBe(200);
    const track = res.json();
    expect(track).toMatchObject({
      title: "Chan², Chaca², Chan²", albumId, albumTitle: "Las Paticas De La Abuela",
      artistId, artistName: "Caramelos De Cianuro", discNumber: 1, trackNumber: 1, creditCount: 1,
      youtubeStartSeconds: null,
    });
    expect(track.aliases).toEqual([]);
    expect(track.credits).toEqual([
      expect.objectContaining({ creditType: "musician", role: "Lead Vocals & Bass", personName: "Asier Cazalis" }),
    ]);

    const withAlias = await app.inject({ method: "GET", url: `/tracks/${trackIds[2]}` });
    expect(withAlias.json().aliases).toEqual([
      { id: expect.any(Number), alias: "Hechicera", aliasType: "name_variant", isPrimary: true },
    ]);
    expect(withAlias.json().credits).toEqual([]);

    const missing = await app.inject({ method: "GET", url: "/tracks/999999" });
    expect(missing.statusCode).toBe(404);
  });

  it("GET /persons/:id trae bandas y créditos de disco/pista", async () => {
    const res = await app.inject({ method: "GET", url: `/persons/${boriMilanId}` });
    const body = res.json();
    expect(body.name).toBe("Boris Milan");
    expect(body.albumCredits.map((c: { creditType: string }) => c.creditType).sort()).toEqual(["mixing", "recording"]);
  });

  it("GET /persons/:id de un id fusionado responde 404 con movedTo (E11.2)", async () => {
    const mergedId = Number((await getPool().query("INSERT INTO public.persons(name) VALUES('Fusionada Fixture') RETURNING id")).rows[0].id);
    const survivorId = Number((await getPool().query("INSERT INTO public.persons(name) VALUES('Superviviente Fixture') RETURNING id")).rows[0].id);
    await getPool().query("DELETE FROM public.persons WHERE id=$1", [mergedId]);
    await getPool().query(
      "INSERT INTO ingest.entity_redirects(entity_kind,from_id,to_id) VALUES('person',$1,$2)", [mergedId, survivorId]);

    const res = await app.inject({ method: "GET", url: `/persons/${mergedId}` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: "not_found", message: expect.any(String), details: { movedTo: { kind: "person", id: survivorId } } },
    });
  });

  it("GET /persons/:id de una persona absorbida por una organización responde movedTo con la organización (E11.2)", async () => {
    const absorbedId = Number((await getPool().query("INSERT INTO public.persons(name) VALUES('Absorbida Fixture') RETURNING id")).rows[0].id);
    const orgId = Number((await getPool().query("INSERT INTO public.organizations(name) VALUES('Estudio Absorbente Fixture') RETURNING id")).rows[0].id);
    await getPool().query("DELETE FROM public.persons WHERE id=$1", [absorbedId]);
    // La conversión de persona a organización no crea redirección de persona a
    // persona: el destino queda en la auditoría `absorbed_person`.
    await getPool().query(`
      INSERT INTO ingest.merge_audit(entity_kind,organization_id,field,old_value,reason,confidence,performed_by)
      VALUES('organization',$1,'absorbed_person',$2::jsonb,'fixture de absorción','high','human')`,
    [orgId, JSON.stringify({ person: { id: absorbedId, name: "Absorbida Fixture" } })]);

    const res = await app.inject({ method: "GET", url: `/persons/${absorbedId}` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.details.movedTo).toEqual({ kind: "organization", id: orgId });
  });

  it("GET /organizations/:id trae discos del sello y artistas acreditados", async () => {
    const list = await app.inject({ method: "GET", url: "/organizations?q=Mad Box" });
    const orgId = list.json().data[0].id;
    const res = await app.inject({ method: "GET", url: `/organizations/${orgId}` });
    const body = res.json();
    expect(body.name).toBe("Mad Box's Studios");
    expect(body.creditedArtists).toEqual([{ artistId, artistName: "Caramelos De Cianuro" }]);
  });

  it("GET /youtube/videos/:id relaciona artista, álbum y las 4 pistas con sus timestamps", async () => {
    const list = await app.inject({ method: "GET", url: "/youtube/videos?q=Paticas" });
    expect(list.json().data).toHaveLength(1);
    const videoId = list.json().data[0].id;
    const res = await app.inject({ method: "GET", url: `/youtube/videos/${videoId}` });
    const body = res.json();
    expect(body.videoId).toBe("Q-pRpO2sYSI");
    expect(body.artists).toEqual([{ artistId, artistName: "Caramelos De Cianuro", relationKind: "performer", confidence: "medium" }]);
    expect(body.albums).toEqual([{ albumId, title: "Las Paticas De La Abuela", albumKind: "full_album", isPrimaryLink: true, confidence: "medium" }]);
    expect(body.tracks.map((t: { startSeconds: number }) => t.startSeconds)).toEqual([0, 247, 475, 615]);
  });

  it("GET /claims exige entity+id y lista los claims de la entidad", async () => {
    const missing = await app.inject({ method: "GET", url: "/claims" });
    expect(missing.statusCode).toBe(400);
    const res = await app.inject({ method: "GET", url: `/claims?entity=artist&id=${artistId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toEqual([
      expect.objectContaining({ field: "origin_city", status: "accepted", sourceId, sourceName: "Fixture API" }),
    ]);
  });

  it("GET /sources y /sources/:id exponen la fuente sembrada", async () => {
    const list = await app.inject({ method: "GET", url: "/sources" });
    expect(list.json()).toEqual([expect.objectContaining({ slug: "fixture-api", name: "Fixture API" })]);
    const res = await app.inject({ method: "GET", url: `/sources/${sourceId}` });
    expect(res.json()).toMatchObject({ slug: "fixture-api", lastRun: null });
  });

  it("GET /review-queue y /review-queue/:id exigen cuenta administradora", async () => {
    expect((await app.inject({ method: "GET", url: "/review-queue?status=open" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/persons/duplicate-candidates" })).statusCode).toBe(401);
    const list = await app.inject({ method: "GET", url: "/review-queue?status=open", headers: admin });
    expect(list.json().data).toHaveLength(1);
    const id = list.json().data[0].id;
    const res = await app.inject({ method: "GET", url: `/review-queue/${id}`, headers: admin });
    expect(res.json()).toMatchObject({
      kind: "possible_duplicate", status: "open", albumId,
      claims: [{ field: "origin_city", rawValue: "Caracas", confidence: "high", sourceName: "Fixture API" }],
    });
  });

  it("expone OpenAPI en /docs/json", async () => {
    const res = await app.inject({ method: "GET", url: "/docs/json" });
    expect(res.statusCode).toBe(200);
    const spec = res.json();
    expect(spec.paths["/albums/{id}"]).toBeDefined();
    expect(spec.paths["/tracks/{id}"]).toBeDefined();
    expect(spec.paths["/search"]).toBeDefined();
  });

  it("una ruta inexistente y un error interno devuelven la misma forma de error", async () => {
    const res = await app.inject({ method: "GET", url: "/no-existe" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });
});
