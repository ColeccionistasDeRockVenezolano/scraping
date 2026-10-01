// CRV · El apodo que la fuente pega al final del nombre de una persona no entra
// en el nombre: se guarda como alias (regla de Brian, 2026-10-01, caso
// Canserbero). Contra PostgreSQL real, por la cadena normalización → claim →
// merge, que es donde nacen las fichas.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { normalizeRecord } from "../../src/normalization/claims.js";
import { persistClaim, type ClaimToPersist } from "../../src/claims/persistence.js";
import { mergeClaim } from "../../src/merge/engine.js";

let evidence = 0;

async function ingestPerson(sourceId: number, identity: string): Promise<void> {
  evidence += 1;
  const normalized = normalizeRecord({
    entityKind: "person", identity, extractor: "nickname-fixture", extractorVersion: "1",
    fields: [{ field: "name", value: identity, evidence: { url: `https://fixture.invalid/apodo/${evidence}`, excerpt: identity } }],
  })[0]!;
  const input: ClaimToPersist = { ...normalized, sourceId, confidence: "high" };
  await mergeClaim(input, await persistClaim(input));
}

async function personByName(name: string): Promise<{ id: number } | null> {
  const { rows } = await getPool().query<{ id: string }>("SELECT id::text FROM public.persons WHERE name=$1", [name]);
  return rows[0] ? { id: Number(rows[0].id) } : null;
}

async function aliasesOf(personId: number): Promise<string[]> {
  return (await getPool().query<{ alias: string }>(
    "SELECT alias FROM ingest.person_aliases WHERE person_id=$1 ORDER BY alias", [personId])).rows.map((row) => row.alias);
}

describe("apodo final en el nombre de una persona ingerida", () => {
  let container: PgContainer;
  let sourceId: number;

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
    const { rows } = await getPool().query<{ id: string }>(`
      INSERT INTO ingest.sources(slug,name,url,site_type,trust_level,enabled)
      VALUES('fixture-apodos','Fixture de apodos','https://fixture.invalid','website','high',true) RETURNING id::text`);
    sourceId = Number(rows[0]!.id);
  }, 120_000);

  afterAll(async () => { await closeDb(); await container?.stop(); }, 60_000);

  it("guarda el nombre sin el apodo y el apodo como alias", async () => {
    await ingestPerson(sourceId, 'Tirone González "Canserbero"');
    const person = await personByName("Tirone González");
    expect(person).not.toBeNull();
    // El nombre tal como lo escribió la fuente se conserva, así que nada deja
    // de encontrarse; «Canserbero» se añade suelto para buscarlo por el apodo.
    expect(await aliasesOf(person!.id)).toEqual(['Canserbero', 'Tirone González "Canserbero"']);
    expect(await personByName('Tirone González "Canserbero"')).toBeNull();
  });

  it("no fabrica un duplicado cuando el nombre limpio ya es de otra ficha", async () => {
    await getPool().query("INSERT INTO public.persons(name) VALUES('Julio Rojas')");
    await ingestPerson(sourceId, 'Julio Rojas "Colmillo"');
    // El ER no crea nada: el homónimo lo manda a la mesa («person_match»), que
    // es donde se decide si Colmillo es ese Julio Rojas. Quitar el apodo nunca
    // puede acabar en dos fichas con el mismo nombre.
    const rojas = (await getPool().query<{ name: string }>(
      "SELECT name FROM public.persons WHERE name LIKE 'Julio Rojas%' ORDER BY id")).rows.map((row) => row.name);
    expect(rojas).toEqual(["Julio Rojas"]);
    const pendientes = (await getPool().query<{ kind: string }>(
      "SELECT kind::text AS kind FROM ingest.review_queue WHERE status='open' ORDER BY id")).rows.map((row) => row.kind);
    expect(pendientes).toContain("person_match");
  });

  it("deja el apodo intercalado donde está: así se nombra a la persona", async () => {
    await ingestPerson(sourceId, 'Rafael "Pollo" Brito');
    expect(await personByName('Rafael "Pollo" Brito')).not.toBeNull();
    expect(await personByName("Rafael Brito")).toBeNull();
  });
});
