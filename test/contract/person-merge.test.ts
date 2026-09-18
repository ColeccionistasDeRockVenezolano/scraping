import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { migrateUp } from "../../src/db/migrate.js";
import { closeDb, getDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { sources } from "../../src/db/schema/ingest.js";
import { mergeEntities, previewEntityMerge, type EntityMergeField } from "../../src/merge/entity-merge.js";
import { withOperatorRun } from "../../src/merge/operator.js";

// E11.3 — El servicio que comparten la API (POST /persons/:id/merge) y la CLI
// (crv review persons --plan): previsualización con hash del estado y fusión
// en una sola transacción del operador.
describe("fusión de personas con previsualización (E11.3)", () => {
  let container: PgContainer;

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
    await getDb().insert(sources).values({
      slug: "person-merge-fixture", name: "Fusión de personas fixture", siteType: "website", trustLevel: "high", enabled: true,
    });
  }, 120_000);

  afterAll(async () => { await closeDb(); await container?.stop(); }, 60_000);

  async function one(sql: string, params: unknown[] = []): Promise<number> {
    return Number((await getPool().query<{ id: string }>(sql, params)).rows[0]!.id);
  }

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    return Number((await getPool().query<{ n: string }>(sql, params)).rows[0]!.n);
  }

  const newPerson = (name: string, birthDate?: string) => birthDate
    ? one("INSERT INTO public.persons(name,birth_date) VALUES($1,$2::date) RETURNING id", [name, birthDate])
    : one("INSERT INTO public.persons(name) VALUES($1) RETURNING id", [name]);

  /** Fusiona como lo hace la API: run del operador + servicio, en una transacción. */
  const serviceMerge = async (
    keepId: number, dropId: number,
    options: { fieldChoices?: Partial<Record<EntityMergeField, "keep" | "drop">>; keepDropNameAsAlias?: boolean; previewHash?: string; note?: string } = {},
  ) => {
    const preview = await previewEntityMerge(getPool(), "person", keepId, dropId);
    return withOperatorRun({
      name: "test:merge:person", operator: "prueba", note: options.note ?? "prueba del servicio de fusión",
    }, (context) => mergeEntities(context, { kind: "person",
      keepId, dropId,
      previewHash: options.previewHash ?? preview.previewHash,
      keepDropNameAsAlias: options.keepDropNameAsAlias ?? true,
      ...(options.fieldChoices === undefined ? {} : { fieldChoices: options.fieldChoices }),
    }));
  };

  it("la previsualización lista conflictos, campos a completar, bandas compartidas y avisos", async () => {
    const band = await one("INSERT INTO public.artists(name) VALUES('Banda Compartida Fixture') RETURNING id");
    const keep = await newPerson("Fusion Servicio A", "1980-01-01");
    const drop = await newPerson("Fusion Servicio B", "1970-01-01");
    await getPool().query("UPDATE public.persons SET nationality='Venezolana' WHERE id=ANY($1::int[])", [[keep, drop]]);
    await getPool().query("UPDATE public.persons SET biography='Biografía del duplicado', is_venezuelan=true WHERE id=$1", [drop]);
    await getPool().query("INSERT INTO public.artist_members(artist_id,person_id,role) VALUES($1,$2,'Guitar'),($1,$3,'Bass')", [band, keep, drop]);

    const preview = await previewEntityMerge(getPool(), "person", keep, drop);

    expect(preview.fieldConflicts).toEqual([
      { field: "birth_date", keepValue: "1980-01-01", dropValue: "1970-01-01" },
    ]);
    expect(preview.fieldsFilledFromDrop).toEqual(["biography", "is_venezuelan"]);
    expect(preview.sharedBands).toEqual([{ id: band, name: "Banda Compartida Fixture" }]);
    expect(preview.sharedAlbums).toEqual([]);
    expect(preview.reviewsBetween).toEqual([]);
    expect(preview.warnings).toContain("Fechas distintas: probablemente son dos personas.");
    expect(preview.warnings).toContain("Los apellidos no coinciden.");
    // A igualdad de referencias (una banda cada una) gana el id menor.
    expect(preview.recommendedKeepId).toBe(keep);
    expect(preview.previewHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("un hash viejo produce stale_preview y ningún cambio", async () => {
    const keep = await newPerson("Hash Viejo A");
    const drop = await newPerson("Hash Viejo B");
    const preview = await previewEntityMerge(getPool(), "person", keep, drop);
    // La ficha cambia entre la previsualización y la fusión: otra persona la editó.
    await getPool().query("UPDATE public.persons SET nationality='Argentina' WHERE id=$1", [keep]);

    await expect(serviceMerge(keep, drop, { previewHash: preview.previewHash })).rejects.toMatchObject({
      code: "stale_preview",
    });
    expect(await count("SELECT count(*) n FROM public.persons WHERE id=$1", [drop])).toBe(1);
    expect(await count("SELECT count(*) n FROM ingest.merge_audit WHERE person_id=$1 AND field='merged_duplicate'", [keep])).toBe(0);
    expect(await count("SELECT count(*) n FROM ingest.entity_redirects WHERE entity_kind='person' AND from_id=$1", [drop])).toBe(0);
  });

  it("con fieldChoices.biography='drop' la ficha que queda recibe la biografía con claim humano y auditoría", async () => {
    const keep = await newPerson("Eleccion Campo A");
    const drop = await newPerson("Eleccion Campo B");
    // Conflicto real: ambas fichas afirman algo distinto; decide la persona.
    await getPool().query("UPDATE public.persons SET biography='Biografía vieja de la ficha A' WHERE id=$1", [keep]);
    await getPool().query("UPDATE public.persons SET biography='Biografía que elige la persona' WHERE id=$1", [drop]);

    const { runId, result } = await serviceMerge(keep, drop, { fieldChoices: { biography: "drop" } });

    expect(result.fieldsCorrected).toEqual(["biography"]);
    const stored = (await getPool().query<{ biography: string }>("SELECT biography FROM public.persons WHERE id=$1", [keep])).rows[0]!;
    expect(stored.biography).toBe("Biografía que elige la persona");
    // Claim humano de la fuente del operador: la corrección no es SQL suelto.
    expect(await count(`SELECT count(*) n FROM ingest.claims
       WHERE person_id=$1 AND field='biography' AND created_by='human' AND confidence='high' AND run_id=$2`, [keep, runId])).toBe(1);
    expect(await count("SELECT count(*) n FROM ingest.merge_audit WHERE person_id=$1 AND field='biography' AND performed_by='human'", [keep])).toBe(1);
  });

  it("deja redirección, alias del nombre perdido y créditos equivalentes unificados", async () => {
    const band = await one("INSERT INTO public.artists(name) VALUES('Banda Creditos Fixture') RETURNING id");
    const album = await one("INSERT INTO public.albums(artist_id,title) VALUES($1,'Disco Creditos Fixture') RETURNING id", [band]);
    const keep = await newPerson("Credito Equivalente A");
    const drop = await newPerson("Credito Equivalente B");
    // Mismo disco y rol salvo mayúsculas: tras la fusión son un solo crédito.
    const keepCredit = await one("INSERT INTO public.album_credits(album_id,person_id,credit_type,role) VALUES($1,$2,'musician','Guitar') RETURNING id", [album, keep]);
    const dropCredit = await one("INSERT INTO public.album_credits(album_id,person_id,credit_type,role) VALUES($1,$2,'musician','guitar') RETURNING id", [album, drop]);

    const { result } = await serviceMerge(keep, drop);

    expect(result.creditsMerged).toBe(1);
    expect(await count("SELECT count(*) n FROM ingest.person_aliases WHERE person_id=$1 AND alias='Credito Equivalente B'", [keep])).toBe(1);
    expect(await count("SELECT count(*) n FROM ingest.entity_redirects WHERE entity_kind='person' AND from_id=$1 AND to_id=$2", [drop, keep])).toBe(1);
    const credits = (await getPool().query<{ id: string; person_id: string }>(
      "SELECT id::text,person_id::text FROM public.album_credits WHERE album_id=$1 ORDER BY id", [album])).rows;
    expect(credits).toEqual([{ id: String(keepCredit), person_id: String(keep) }]);
    expect(await count("SELECT count(*) n FROM public.album_credits WHERE id=$1", [dropCredit])).toBe(0);
    expect(await count("SELECT count(*) n FROM ingest.merge_audit WHERE id=$1", [result.auditId])).toBe(1);
  });

  it("si algo falla a mitad no queda run, claim ni auditoría", async () => {
    const keep = await newPerson("Falla Mitad A");
    const drop = await newPerson("Falla Mitad B");
    const preview = await previewEntityMerge(getPool(), "person", keep, drop);
    const runsBefore = await count("SELECT count(*) n FROM ingest.scrape_runs");
    const claimsBefore = await count("SELECT count(*) n FROM ingest.claims");
    const auditsBefore = await count("SELECT count(*) n FROM ingest.merge_audit");

    await expect(withOperatorRun({
      name: "test:merge:person", operator: "prueba", note: "prueba de falla a mitad",
    }, async (context) => {
      await mergeEntities(context, { kind: "person", keepId: keep, dropId: drop, previewHash: preview.previewHash, keepDropNameAsAlias: true });
      // Dentro de la transacción la fusión ya ocurrió (se mira con la conexión
      // de la transacción, no con el pool: nadie más ve lo no confirmado); el
      // fallo llega después.
      const inside = await context.client.query<{ n: string }>("SELECT count(*) n FROM public.persons WHERE id=$1", [drop]);
      expect(Number(inside.rows[0]!.n)).toBe(0);
      throw new Error("falla simulada a mitad de la fusión");
    })).rejects.toThrow("falla simulada a mitad");

    expect(await count("SELECT count(*) n FROM ingest.scrape_runs")).toBe(runsBefore);
    expect(await count("SELECT count(*) n FROM ingest.claims")).toBe(claimsBefore);
    expect(await count("SELECT count(*) n FROM ingest.merge_audit")).toBe(auditsBefore);
    expect(await count("SELECT count(*) n FROM public.persons WHERE id=$1", [drop])).toBe(1);
    expect(await count("SELECT count(*) n FROM ingest.entity_redirects WHERE entity_kind='person' AND from_id=$1", [drop])).toBe(0);
  });
});
