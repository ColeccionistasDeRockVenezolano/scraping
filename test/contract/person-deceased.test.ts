import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { applyPersonCorrections, type PersonCorrectionPlan } from "../../src/review/person-corrections.js";
import { getArtistDetail, listArtists } from "../../src/api/repositories/artists.js";
import { getPersonDetail, listPersons } from "../../src/api/repositories/persons.js";

// Caso Canserbero (Brian, 2026-09-30): la cruz «(†)» sale del nombre y pasa a
// `persons.is_deceased`; el artista de una sola persona fallecida lo hereda.
describe("fallecidos: op mark_deceased y lecturas de la API", () => {
  let container: PgContainer;
  const ids: Record<string, number> = {};
  let plan: PersonCorrectionPlan;

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
    const pool = getPool();
    const one = async (sql: string, params: unknown[] = []) => Number((await pool.query<{ id: string }>(sql, params)).rows[0]!.id);
    ids["canserbero"] = await one(`INSERT INTO public.persons(name) VALUES ('Tirone González "Canserbero" (†)') RETURNING id`);
    ids["viva"] = await one("INSERT INTO public.persons(name) VALUES ('Ana Rojas') RETURNING id");
    ids["fecha"] = await one("INSERT INTO public.persons(name,death_date) VALUES ('Con Fecha','2015-01-20') RETURNING id");
    ids["solo"] = await one("INSERT INTO public.artists(name) VALUES ('Canserbero') RETURNING id");
    ids["banda"] = await one("INSERT INTO public.artists(name) VALUES ('Banda Con Un Muerto') RETURNING id");
    ids["sinNadie"] = await one("INSERT INTO public.artists(name) VALUES ('Sin Integrantes') RETURNING id");
    await pool.query("INSERT INTO public.artist_members(artist_id,person_id,role) VALUES ($1,$2,'Titular del proyecto')", [ids["solo"], ids["canserbero"]]);
    await pool.query("INSERT INTO public.artist_members(artist_id,person_id,role) VALUES ($1,$2,'Bass'),($1,$3,'Drums')", [ids["banda"], ids["fecha"], ids["viva"]]);
    plan = {
      decidedAt: "2026-09-30", evidence: "prueba de contrato",
      corrections: [{
        op: "mark_deceased", person: { id: ids["canserbero"]!, name: 'Tirone González "Canserbero" (†)' },
        cleanName: 'Tirone González "Canserbero"', why: "la cruz es una marca, no el nombre",
      }],
    };
  }, 120_000);
  afterAll(async () => { await closeDb(); await container?.stop(); }, 60_000);

  it("--dry-run no deja rastro", async () => {
    const result = await applyPersonCorrections(plan, "prueba", { dryRun: true });
    expect(result.outcomes[0]!.status).toBe("applied");
    const row = (await getPool().query("SELECT name, is_deceased FROM public.persons WHERE id=$1", [ids["canserbero"]])).rows[0]!;
    expect(row).toEqual({ name: 'Tirone González "Canserbero" (†)', is_deceased: null });
  });

  it("limpia el nombre, marca fallecido, audita y la segunda vez no cambia nada", async () => {
    const first = await applyPersonCorrections(plan, "prueba", { dryRun: false });
    expect(first.outcomes[0]!.status).toBe("applied");
    const row = (await getPool().query("SELECT name, is_deceased FROM public.persons WHERE id=$1", [ids["canserbero"]])).rows[0]!;
    expect(row).toEqual({ name: 'Tirone González "Canserbero"', is_deceased: true });
    const audited = await getPool().query("SELECT field FROM ingest.merge_audit WHERE person_id=$1 AND run_id=$2 ORDER BY field", [ids["canserbero"], first.runId]);
    expect(audited.rows.map((r) => r.field)).toEqual(["is_deceased", "name"]);
    const second = await applyPersonCorrections(plan, "prueba", { dryRun: false });
    expect(second.outcomes[0]!.status).toBe("skipped");
  });

  it("set_dates rellena lo vacío y nunca pisa una fecha guardada; mark_deceased y create_titular guardan fechas", async () => {
    const plan2: PersonCorrectionPlan = {
      decidedAt: "2026-09-30", evidence: "prueba de contrato",
      corrections: [
        { op: "set_dates", person: { id: ids["viva"]!, name: "Ana Rojas" }, birthDate: "1970-02-03", why: "fuente de ficha" },
        { op: "set_dates", person: { id: ids["fecha"]!, name: "Con Fecha" }, deathDate: "2000-01-01", why: "no debe pisar" },
        { op: "mark_deceased", person: { id: ids["canserbero"]!, name: 'Tirone González "Canserbero"' }, birthDate: "1988-03-11", deathDate: "2015-01-20", why: "fechas de ficha" },
        { op: "create_titular", name: "Germán Freytes", artist: { id: ids["sinNadie"]!, name: "Sin Integrantes" }, role: "Titular del proyecto", deceased: true, birthDate: "1943-05-28", deathDate: "1984-07-19", why: "solista sin persona" },
      ],
    };
    const first = await applyPersonCorrections(plan2, "prueba", { dryRun: false });
    expect(first.outcomes.map((o) => o.status)).toEqual(["applied", "skipped", "applied", "applied"]);
    const rows = Object.fromEntries((await getPool().query("SELECT name, birth_date::text AS b, death_date::text AS d, is_deceased FROM public.persons")).rows.map((r) => [r.name, r]));
    expect(rows["Ana Rojas"]).toMatchObject({ b: "1970-02-03", d: null });
    expect(rows["Con Fecha"]).toMatchObject({ d: "2015-01-20" });
    expect(rows['Tirone González "Canserbero"']).toMatchObject({ b: "1988-03-11", d: "2015-01-20", is_deceased: true });
    expect(rows["Germán Freytes"]).toMatchObject({ b: "1943-05-28", d: "1984-07-19", is_deceased: true });
    expect(await getArtistDetail(ids["sinNadie"]!)).toMatchObject({ isDeceased: true });
    const second = await applyPersonCorrections(plan2, "prueba", { dryRun: false });
    expect(second.outcomes.map((o) => o.status)).toEqual(["skipped", "skipped", "skipped", "skipped"]);
  });

  it("la API marca fallecida a la persona por columna o por fecha, y no a la viva", async () => {
    expect((await getPersonDetail(ids["canserbero"]!))).toMatchObject({ isDeceased: true, isDeceasedFlag: true });
    expect((await getPersonDetail(ids["fecha"]!))).toMatchObject({ isDeceased: true, isDeceasedFlag: null });
    expect((await getPersonDetail(ids["viva"]!))).toMatchObject({ isDeceased: false, isDeceasedFlag: null });
    const list = await listPersons({ limit: 50, offset: 0 });
    expect(Object.fromEntries(list.rows.map((row) => [row.name, row.isDeceased]))).toMatchObject({ "Tirone González \"Canserbero\"": true, "Ana Rojas": false, "Con Fecha": true });
  });

  it("el artista hereda la muerte de su titular, no la de un integrante de una banda", async () => {
    const solo = await getArtistDetail(ids["solo"]!);
    expect(solo).toMatchObject({ isDeceased: true });
    expect(solo!.members[0]).toMatchObject({ personName: 'Tirone González "Canserbero"', personIsDeceased: true });
    expect(await getArtistDetail(ids["banda"]!)).toMatchObject({ isDeceased: false });
    // «Sin Integrantes» recibió su titular fallecido en la prueba anterior.
    expect(await getArtistDetail(ids["sinNadie"]!)).toMatchObject({ isDeceased: true });
    const list = await listArtists({ limit: 50, offset: 0 });
    expect(Object.fromEntries(list.rows.map((row) => [row.name, row.isDeceased])))
      .toEqual({ Canserbero: true, "Banda Con Un Muerto": false, "Sin Integrantes": true });
  });
});
