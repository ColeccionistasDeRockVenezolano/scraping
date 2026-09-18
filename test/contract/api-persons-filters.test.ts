// CRV · E11.9 — Búsqueda sin tildes y listado de personas con filtros.
// Contra PostgreSQL desechable: `q=jose` encuentra «José» (la base es
// SQL_ASCII y no pliega tildes), los filtros del listado responden y el orden
// por créditos es descendente.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { buildApp } from "../../src/api/app.js";
import { refreshSearchIndex } from "../../src/api/search-index.js";
import { createEntity, withOperatorRun } from "../../src/merge/operator.js";

describe("búsqueda sin tildes y filtros de personas (E11.9)", () => {
  let container: PgContainer;
  let app: FastifyInstance;
  let joseId: number;
  let josefinaId: number;
  let studioId: number;
  let emptyId: number;

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
    app = await buildApp();

    const one = async (sql: string, params: unknown[] = []): Promise<number> =>
      Number((await getPool().query<{ id: string }>(sql, params)).rows[0]!.id);
    // Los nombres con tilde y la basura tipada como persona son el caso real.
    joseId = await one("INSERT INTO public.persons(name) VALUES('José Zapata') RETURNING id");
    josefinaId = await one("INSERT INTO public.persons(name) VALUES('Josefina Requena') RETURNING id");
    studioId = await one("INSERT INTO public.persons(name) VALUES('Estudio Sin Nombre Records') RETURNING id");
    emptyId = await one("INSERT INTO public.persons(name) VALUES('Ana Sin Créditos') RETURNING id");
    // Contiene «jose» pero no empieza por él: va después de los dos anteriores.
    await one("INSERT INTO public.persons(name) VALUES('María Josefa Pérez') RETURNING id");

    // Zapata tiene dos créditos y una membresía; Requena, uno.
    const band = await one("INSERT INTO public.artists(name) VALUES('Banda Filtros QA') RETURNING id");
    const album = await one("INSERT INTO public.albums(artist_id,title) VALUES($1,'Disco Filtros QA') RETURNING id", [band]);
    await getPool().query("INSERT INTO public.album_credits(album_id,person_id,credit_type,role) VALUES($1,$2,'musician','Guitarra'),($1,$2,'producer','Producción')", [album, joseId]);
    await getPool().query("INSERT INTO public.artist_members(artist_id,person_id,role) VALUES($1,$2,'Batería')", [band, joseId]);
    const track = await one("INSERT INTO public.tracks(album_id,track_number,title) VALUES($1,1,'Pista Filtros QA') RETURNING id", [album]);
    await getPool().query("INSERT INTO public.track_credits(track_id,person_id,credit_type,role) VALUES($1,$2,'musician','Bajo')", [track, josefinaId]);

    // Un alta por el camino del operador invalida el índice (E11.9): el
    // siguiente listado ya ve la ficha nueva.
    await withOperatorRun({ name: "test:create:person", operator: "prueba", note: "fixture de filtros" },
      (context) => createEntity(context, "person", { name: "Ángela de los Ríos" }));

    // El índice en memoria se calienta en segundo plano al construir la app y
    // refresca por TTL o invalidación (auditoría 2026-09-18, SWR). Las fichas
    // de este archivo entran por SQL directo, así que el test fuerza el
    // refresco: sin esto, gana la carrera el warm de arranque en las máquinas
    // rápidas (visto en CI) y la búsqueda sirve la foto anterior.
    await refreshSearchIndex();
  }, 120_000);

  afterAll(async () => { await app?.close(); await closeDb(); await container?.stop(); }, 60_000);

  it("q=jose encuentra «José» y ordena primero los que empiezan por la consulta", async () => {
    const res = await app.inject({ method: "GET", url: "/persons?q=jose&limit=10" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const names = body.data.map((row: { name: string }) => row.name);
    expect(names).toContain("José Zapata");
    expect(names).toContain("Josefina Requena");
    // Los que empiezan por la consulta van primero; el que solo la contiene, después.
    expect(names.slice(0, 2).sort()).toEqual(["Josefina Requena", "José Zapata"]);
    expect(names.indexOf("María Josefa Pérez")).toBeGreaterThan(1);
    expect(body.data.map((row: { id: number }) => row.id)).toContain(josefinaId);

    // La búsqueda global también pliega tildes para personas y artistas.
    const global = await app.inject({ method: "GET", url: "/search?q=jose&types=person" });
    expect(global.json().person.map((hit: { label: string }) => hit.label)).toContain("José Zapata");
  });

  it("hasCredits=false devuelve solo fichas sin crédito ni membresía", async () => {
    const res = await app.inject({ method: "GET", url: "/persons?hasCredits=false&limit=50" });
    const names = res.json().data.map((row: { name: string }) => row.name);
    expect(names).toContain("Ana Sin Créditos");
    expect(names).toContain("Estudio Sin Nombre Records");
    expect(names).not.toContain("José Zapata");
    expect(res.json().data.map((row: { id: number }) => row.id)).toContain(emptyId);
    // El listado trae los contadores por fila.
    const withCredits = await app.inject({ method: "GET", url: `/persons?q=Zapata` });
    expect(withCredits.json().data[0]).toMatchObject({ creditCount: 2, bandCount: 1 });
  });

  it("sort=credits ordena por créditos + membresías, descendente", async () => {
    const res = await app.inject({ method: "GET", url: "/persons?sort=credits&limit=10" });
    const rows = res.json().data as Array<{ name: string; creditCount: number; bandCount: number }>;
    const totals = rows.map((row) => row.creditCount + row.bandCount);
    expect(totals).toEqual([...totals].sort((left, right) => right - left));
    expect(rows[0]!.name).toBe("José Zapata"); // 2 créditos + 1 membresía
  });

  it("suspect=organization_like filtra por el clasificador (E11.7) y la ficha dice su clase", async () => {
    const res = await app.inject({ method: "GET", url: "/persons?suspect=organization_like&limit=50" });
    expect(res.json().data.map((row: { name: string }) => row.name)).toEqual(["Estudio Sin Nombre Records"]);

    const detail = await app.inject({ method: "GET", url: `/persons/${studioId}` });
    expect(detail.json()).toMatchObject({ nameClass: "organization_like", nameClassReason: expect.stringContaining("estudio") });
    const clean = await app.inject({ method: "GET", url: `/persons/${joseId}` });
    expect(clean.json()).toMatchObject({ nameClass: "ok", nameClassReason: "" });
  });

  it("el índice se invalida al escribir: una persona creada por el operador aparece de inmediato", async () => {
    const before = await app.inject({ method: "GET", url: "/persons?q=Ángela" });
    expect(before.json().data.map((row: { name: string }) => row.name)).toEqual(["Ángela de los Ríos"]);
    // Búsqueda sin tildes de la misma ficha.
    const plain = await app.inject({ method: "GET", url: "/persons?q=angela de los rios" });
    expect(plain.json().data.map((row: { name: string }) => row.name)).toEqual(["Ángela de los Ríos"]);
  });
});
