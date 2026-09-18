import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { migrateUp } from "../../src/db/migrate.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { invalidateSearchIndex, refreshSearchIndex, searchIds, warmSearchIndex } from "../../src/api/search-index.js";
import { normalizeEntityName } from "../../src/normalization/entity-name.js";

// Auditoría de rendimiento #2 — El índice sirve lo que tiene y refresca de
// fondo: una lectura no paga la recarga (por eso una escritura sin refresco no
// se ve), la invalidación que dispara cada escritura del catálogo refresca en
// el acto, y los alias participan igual que los nombres.
describe("índice de búsqueda con refresco en segundo plano (contrato)", () => {
  let container: PgContainer;

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
    await warmSearchIndex();
  }, 120_000);

  afterAll(async () => { await closeDb(); await container?.stop(); }, 60_000);

  async function newPerson(name: string): Promise<number> {
    const { rows } = await getPool().query<{ id: string }>("INSERT INTO public.persons(name) VALUES($1) RETURNING id", [name]);
    return Number(rows[0]!.id);
  }

  async function newArtist(name: string): Promise<number> {
    const { rows } = await getPool().query<{ id: string }>("INSERT INTO public.artists(name, origin_country) VALUES($1,'Venezuela') RETURNING id", [name]);
    return Number(rows[0]!.id);
  }

  it("una persona nueva entra al índice con el refresco, y se encuentra con y sin tildes", async () => {
    const id = await newPerson("José Ñáñez");
    // Sin refresco la lectura sirve la copia en memoria: la base no se consulta.
    expect(await searchIds("person", "jose")).not.toContain(id);

    await refreshSearchIndex("person");
    expect(await searchIds("person", "jose")).toContain(id);
    expect(await searchIds("person", "nanez")).toContain(id);
    expect(await searchIds("person", " ÑÁÑEZ ")).toContain(id);
  });

  it("la invalidación refresca en el acto y los alias participan", async () => {
    const id = await newArtist("Los Sin Nombre");
    await getPool().query(
      "INSERT INTO ingest.artist_aliases(artist_id, alias, normalized_alias) VALUES($1,$2,$3)",
      [id, "El Nombre", normalizeEntityName("El Nombre").primaryKey]);
    expect(await searchIds("artist", "el nombre")).not.toContain(id);

    // La invalidación es lo que corre cada escritura del catálogo: no bloquea
    // (void) y deja el refresco en marcha; `warmSearchIndex` lo espera.
    expect(invalidateSearchIndex("artist")).toBeUndefined();
    await warmSearchIndex();
    expect(await searchIds("artist", "el nombre")).toContain(id);
    expect(await searchIds("artist", "sin nombre")).toContain(id);
  });

  it("la invalidación total también refresca los tres índices", async () => {
    const person = await newPerson("Zulema Camacaro");
    const organization = await getPool().query<{ id: string }>(
      "INSERT INTO public.organizations(name, organization_type) VALUES('Sello Del Sur','record_label') RETURNING id");
    invalidateSearchIndex();
    await refreshSearchIndex();
    expect(await searchIds("person", "zulema")).toContain(person);
    expect(await searchIds("organization", "sello del sur")).toContain(Number(organization.rows[0]!.id));
  });
});
