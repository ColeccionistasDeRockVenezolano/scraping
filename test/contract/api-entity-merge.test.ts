// CRV · E11.10 — Fusión de organizaciones y artistas por la API, y P13 (la
// ficha que queda es la que más referencias tiene) en el detector del CLI.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { buildApp } from "../../src/api/app.js";
import { findDuplicateGroups } from "../../src/review/duplicates.js";
import { findOrganizationCandidates } from "../../src/review/organization-candidates.js";

const TOKEN = "token-de-prueba-merge-entidades-0123456789";
const OPERATOR = "Tester Entidades";

describe("fusión de organizaciones y artistas (E11.10)", () => {
  let container: PgContainer;
  let app: FastifyInstance;

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    process.env["CRV_OPERATOR_TOKEN"] = TOKEN;
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
    app = await buildApp();
  }, 120_000);

  afterAll(async () => { await app?.close(); await closeDb(); await container.stop(); }, 60_000);

  const one = async (sql: string, params: unknown[] = []): Promise<number> =>
    Number((await getPool().query<{ id: string }>(sql, params)).rows[0]!.id);
  const headers = { authorization: `Bearer ${TOKEN}`, "x-crv-operator": OPERATOR };

  it("fusiona dos organizaciones: previsualización, fusión, créditos y redirección", async () => {
    const band = await one("INSERT INTO public.artists(name) VALUES('Banda Org QA') RETURNING id");
    const album = await one("INSERT INTO public.albums(artist_id,title) VALUES($1,'Disco Org QA') RETURNING id", [band]);
    const keep = await one("INSERT INTO public.organizations(name,biography) VALUES('Sello Org QA','bio A') RETURNING id");
    const drop = await one("INSERT INTO public.organizations(name,biography,country) VALUES('Sello Org QA (v2)','bio B','Venezuela') RETURNING id");
    await getPool().query("INSERT INTO public.album_credits(album_id,organization_id,credit_type,role) VALUES($1,$2,'producer','Producción')", [album, keep]);
    await getPool().query("INSERT INTO public.album_credits(album_id,organization_id,credit_type,role) VALUES($1,$2,'recording','Grabado en')", [album, drop]);

    const preview = await app.inject({ method: "GET", url: `/organizations/${keep}/merge-preview?with=${drop}`, headers });
    expect(preview.statusCode).toBe(200);
    const previewBody = preview.json();
    expect(previewBody.kind).toBe("organization");
    // `country` se completa solo; `biography` se contradice.
    expect(previewBody.fieldsFilledFromDrop).toContain("country");
    expect(previewBody.fieldConflicts.map((item: { field: string }) => item.field)).toContain("biography");
    expect(previewBody.sharedAlbums.map((item: { title: string }) => item.title)).toEqual(["Disco Org QA"]);

    const merged = await app.inject({
      method: "POST", url: `/organizations/${keep}/merge`, headers,
      payload: {
        dropId: drop, previewHash: previewBody.previewHash, keepDropNameAsAlias: true,
        fieldChoices: { biography: "drop" }, note: "prueba de fusión de organizaciones",
      },
    });
    expect(merged.statusCode).toBe(200);
    expect(merged.json()).toMatchObject({ kind: "organization", keepId: keep, dropId: drop, fieldsCorrected: ["biography"] });

    // Los dos créditos quedan en la ficha que sobrevive y el id perdido redirige.
    const credits = (await getPool().query<{ n: string }>(
      "SELECT count(*)::text AS n FROM public.album_credits WHERE organization_id=$1", [keep])).rows[0]!;
    expect(Number(credits.n)).toBe(2);
    const gone = await app.inject({ method: "GET", url: `/organizations/${drop}` });
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error.details.movedTo).toEqual({ kind: "organization", id: keep });
  });

  it("fusiona dos sellos: los discos enlazados (albums.label_id) pasan a la ficha que queda", async () => {
    const band = await one("INSERT INTO public.artists(name) VALUES('Banda Sello QA') RETURNING id");
    const keep = await one("INSERT INTO public.organizations(name) VALUES('Sello Enlace QA') RETURNING id");
    const drop = await one("INSERT INTO public.organizations(name) VALUES('Sello Enlace QA (dup)') RETURNING id");
    const albumKeep = await one("INSERT INTO public.albums(artist_id,title,label_id) VALUES($1,'Disco Sello QA A',$2) RETURNING id", [band, keep]);
    const albumDrop = await one("INSERT INTO public.albums(artist_id,title,label_id) VALUES($1,'Disco Sello QA B',$2) RETURNING id", [band, drop]);

    const preview = await app.inject({ method: "GET", url: `/organizations/${keep}/merge-preview?with=${drop}`, headers });
    expect(preview.statusCode).toBe(200);
    const merged = await app.inject({
      method: "POST", url: `/organizations/${keep}/merge`, headers,
      payload: { dropId: drop, previewHash: preview.json().previewHash, keepDropNameAsAlias: true, note: "dos sellos con la misma razón social" },
    });
    expect(merged.statusCode).toBe(200);

    // La FK albums_label_id_fkey la descubre el motor en el catálogo: los dos
    // discos quedan enlazados al sello que sobrevive, sin caso especial.
    const labels = (await getPool().query<{ id: string; label_id: string | null }>(
      "SELECT id::text, label_id::text FROM public.albums WHERE id=ANY($1::int[]) ORDER BY id",
      [[albumKeep, albumDrop]])).rows;
    expect(labels).toEqual([
      { id: String(albumKeep), label_id: String(keep) },
      { id: String(albumDrop), label_id: String(keep) },
    ]);
  });

  it("fusiona dos artistas y responde sin credenciales con 401", async () => {
    const keep = await one("INSERT INTO public.artists(name) VALUES('Artista Entidad QA') RETURNING id");
    const drop = await one("INSERT INTO public.artists(name,origin_city) VALUES('Artista Entidad QA (dup)','Caracas') RETURNING id");

    const preview = await app.inject({ method: "GET", url: `/artists/${keep}/merge-preview?with=${drop}`, headers });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().kind).toBe("artist");
    expect(preview.json().fieldsFilledFromDrop).toContain("origin_city");

    const noAuth = await app.inject({
      method: "POST", url: `/artists/${keep}/merge`,
      payload: { dropId: drop, previewHash: preview.json().previewHash, keepDropNameAsAlias: true, note: "sin credenciales" },
    });
    expect(noAuth.statusCode).toBe(401);

    const merged = await app.inject({
      method: "POST", url: `/artists/${keep}/merge`, headers,
      payload: { dropId: drop, previewHash: preview.json().previewHash, keepDropNameAsAlias: true, note: "prueba de fusión de artistas" },
    });
    expect(merged.statusCode).toBe(200);
    const gone = await app.inject({ method: "GET", url: `/artists/${drop}` });
    expect(gone.json().error.details.movedTo).toEqual({ kind: "artist", id: keep });
  });

  it("P13: entre duplicados se queda la ficha con más discos, no la de id menor", async () => {
    // La de id MAYOR es la rica: dos discos contra ninguno.
    await one("INSERT INTO public.artists(name) VALUES('Banda P13 QA') RETURNING id");
    const rich = await one("INSERT INTO public.artists(name) VALUES('Banda P13 QA ') RETURNING id");
    const other = await one("INSERT INTO public.artists(name) VALUES('Otro Artista P13 QA') RETURNING id");
    await getPool().query("INSERT INTO public.albums(artist_id,title) VALUES($1,'Uno P13'),($1,'Dos P13')", [rich]);
    expect(other).toBeGreaterThan(0);

    const scan = await findDuplicateGroups();
    const group = scan.groups.find((item) => item.kind === "artist" && item.names.some((name) => name.includes("P13 QA")));
    expect(group).toBeDefined();
    expect(group!.keepId).toBe(rich);
    expect(group!.dropIds).toContain(rich - 1);
  });

  it("el detector de organizaciones quita las palabras de estudio de la clave", async () => {
    const studio = await one("INSERT INTO public.organizations(name) VALUES('Estudio Variante QA') RETURNING id");
    const plain = await one("INSERT INTO public.organizations(name) VALUES('Variante QA') RETURNING id");

    const scan = await findOrganizationCandidates({ queryable: getPool() });
    const candidate = scan.candidates.find((item) =>
      [item.a.id, item.b.id].includes(studio) && [item.a.id, item.b.id].includes(plain));
    expect(candidate).toBeDefined();
    expect(candidate!.features.map((feature) => feature.key)).toContain("key_equal");
    expect(candidate!.score).toBeGreaterThanOrEqual(0.6);
    expect(candidate!.priority).toBe(3);
  });

  it("las rutas nuevas quedan visibles en el esquema OpenAPI", async () => {
    const docs = await app.inject({ method: "GET", url: "/docs/json" });
    const paths = Object.keys(docs.json().paths);
    for (const path of ["/persons/{id}/merge", "/organizations/{id}/merge-preview", "/artists/{id}/merge", "/merge-runs/{runId}/undo", "/persons/duplicate-candidates", "/persons/{id}/convert"]) {
      expect(paths).toContain(path);
    }
  });
});
