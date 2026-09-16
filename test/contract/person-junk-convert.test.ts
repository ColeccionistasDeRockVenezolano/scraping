// CRV · E11.7 — Convertir personas basura en organización/artista y dividir
// fichas que son varias personas. Contra PostgreSQL desechable: la conversión
// por API (destino existente y destino nuevo) y la división por plan JSON.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { buildApp } from "../../src/api/app.js";
import { applyPersonCorrections, personCorrectionPlanSchema } from "../../src/review/person-corrections.js";

const TOKEN = "token-de-prueba-conversion-0123456789";
const OPERATOR = "Tester Conversión";

describe("personas basura: convertir y dividir (E11.7)", () => {
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

  afterAll(async () => {
    await app?.close();
    await closeDb();
    delete process.env["CRV_OPERATOR_TOKEN"];
    resetEnvCache();
    await container.stop();
  }, 60_000);

  const one = async (sql: string, params: unknown[] = []): Promise<number> =>
    Number((await getPool().query<{ id: string }>(sql, params)).rows[0]!.id);

  const count = async (sql: string, params: unknown[] = []): Promise<number> =>
    Number((await getPool().query<{ n: string }>(sql, params)).rows[0]!.n);

  const convert = (personId: number, payload: Record<string, unknown>) => app.inject({
    method: "POST", url: `/persons/${personId}/convert`,
    headers: { authorization: `Bearer ${TOKEN}`, "x-crv-operator": OPERATOR },
    payload,
  });

  it("convierte una persona en una organización existente: créditos pasan, claims se rechazan y el enlace redirige", async () => {
    const band = await one("INSERT INTO public.artists(name) VALUES('Banda Conversión QA') RETURNING id");
    const album = await one("INSERT INTO public.albums(artist_id,title) VALUES($1,'Disco Conversión QA') RETURNING id", [band]);
    const personId = await one("INSERT INTO public.persons(name) VALUES('Estudio Falso QA') RETURNING id");
    const orgId = await one("INSERT INTO public.organizations(name,organization_type) VALUES('Estudio Real QA','recording_studio') RETURNING id");
    const creditId = await one("INSERT INTO public.album_credits(album_id,person_id,credit_type,role) VALUES($1,$2,'recording','Grabado en') RETURNING id", [album, personId]);
    const sourceId = await one("INSERT INTO ingest.sources(slug,name,site_type,trust_level,enabled) VALUES('conv-fixture','Conv fixture','website','high',true) RETURNING id");
    // raw_hash debe ser sha256 en hex (claims_raw_hash_check).
    const claimId = await one("INSERT INTO ingest.claims(source_id,entity_kind,person_id,field,raw_value,raw_hash,status,identity_key) VALUES($1,'person',$2,'name',to_jsonb('Estudio Falso QA'::text),$3,'accepted','conversion:1') RETURNING id", [sourceId, personId, "1".repeat(64)]);

    const res = await convert(personId, { to: "organization", targetId: orgId, keepNameAsAlias: true, note: "no es una persona: es un estudio" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ op: "to_organization", status: "applied", targetKind: "organization", targetId: orgId, runId: expect.any(Number) });

    // El crédito pasó al destino sin perder la fila.
    const credit = (await getPool().query<{ person_id: string | null; organization_id: string | null }>(
      "SELECT person_id::text, organization_id::text FROM public.album_credits WHERE id=$1", [creditId])).rows[0]!;
    expect(credit.person_id).toBeNull();
    expect(Number(credit.organization_id)).toBe(orgId);

    // El claim no se borra: pierde destino y queda rechazado con la nota.
    const claim = (await getPool().query<{ person_id: string | null; status: string; notes: string }>(
      "SELECT person_id::text, status, notes FROM ingest.claims WHERE id=$1", [claimId])).rows[0]!;
    expect(claim.person_id).toBeNull();
    expect(claim.status).toBe("rejected");
    expect(claim.notes).toContain("no es una persona");

    expect(await count("SELECT count(*) n FROM public.persons WHERE id=$1", [personId])).toBe(0);
    expect(await count("SELECT count(*) n FROM ingest.organization_aliases WHERE organization_id=$1 AND alias='Estudio Falso QA'", [orgId])).toBe(1);
    expect(await count("SELECT count(*) n FROM ingest.merge_audit WHERE organization_id=$1 AND field='absorbed_person'", [orgId])).toBe(1);

    // La ficha convertida ya no existe, pero su enlace lleva a la organización.
    const gone = await app.inject({ method: "GET", url: `/persons/${personId}` });
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error.details.movedTo).toEqual({ kind: "organization", id: orgId });
  });

  it("convierte en un artista nuevo (create) con claims humanos y sin tocar la base de desarrollo", async () => {
    const personId = await one("INSERT INTO public.persons(name) VALUES('Banda Oculta QA') RETURNING id");

    const res = await convert(personId, {
      to: "artist", create: { name: "Banda Descubierta QA", artistType: "band" }, keepNameAsAlias: false,
      note: "la fuente lo acreditó como persona y es una banda",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.targetKind).toBe("artist");
    expect(body.targetId).toBeGreaterThan(0);

    const artist = (await app.inject({ method: "GET", url: `/artists/${body.targetId}` })).json();
    expect(artist).toMatchObject({ name: "Banda Descubierta QA", artistType: "band" });
    expect(await count(`SELECT count(*) n FROM ingest.claims
       WHERE artist_id=$1 AND created_by='human' AND confidence='high' AND run_id=$2`, [body.targetId, body.runId])).toBeGreaterThanOrEqual(1);
    expect(await count("SELECT count(*) n FROM public.persons WHERE id=$1", [personId])).toBe(0);
  });

  it("exige exactamente uno de targetId/create y una nota", async () => {
    const personId = await one("INSERT INTO public.persons(name) VALUES('Cuerpo QA') RETURNING id");
    const both = await convert(personId, { to: "organization", targetId: 1, create: { name: "X" }, keepNameAsAlias: false, note: "n" });
    expect(both.statusCode).toBe(400);
    const neither = await convert(personId, { to: "organization", keepNameAsAlias: false, note: "n" });
    expect(neither.statusCode).toBe(400);
    const misspelled = await convert(personId, { to: "organization", create: { name: "X", artistType: "band" }, keepNameAsAlias: false, note: "n" });
    expect(misspelled.statusCode).toBe(400);
    const anonymous = await app.inject({ method: "POST", url: `/persons/${personId}/convert`, payload: { to: "organization", targetId: 1, keepNameAsAlias: false, note: "n" } });
    expect(anonymous.statusCode).toBe(401);
  });

  it("divide una ficha que son varias personas: copia la trayectoria, reutiliza la existente y retira la combinada", async () => {
    const band = await one("INSERT INTO public.artists(name) VALUES('Banda División QA') RETURNING id");
    const album = await one("INSERT INTO public.albums(artist_id,title) VALUES($1,'Disco División QA') RETURNING id", [band]);
    const combined = await one("INSERT INTO public.persons(name) VALUES('Ana Valencia Pimpi QA Carlos Moreán QA') RETURNING id");
    const existing = await one("INSERT INTO public.persons(name) VALUES('Carlos Moreán QA') RETURNING id");
    const creditA = await one("INSERT INTO public.album_credits(album_id,person_id,credit_type,role) VALUES($1,$2,'musician','Guitarra') RETURNING id", [album, combined]);
    const creditB = await one("INSERT INTO public.album_credits(album_id,person_id,credit_type,role) VALUES($1,$2,'producer','Producción') RETURNING id", [album, combined]);
    await one("INSERT INTO public.artist_members(artist_id,person_id,role,from_year) VALUES($1,$2,'Batería',1999) RETURNING id", [band, combined]);
    const sourceId = await one("INSERT INTO ingest.sources(slug,name,site_type,trust_level,enabled) VALUES('split-fixture','Split fixture','website','high',true) RETURNING id");
    const nameClaim = await one("INSERT INTO ingest.claims(source_id,entity_kind,person_id,field,raw_value,raw_hash,status,identity_key) VALUES($1,'person',$2,'name',to_jsonb('Ana Valencia Pimpi QA Carlos Moreán QA'::text),$3,'accepted','split:1') RETURNING id", [sourceId, combined, "2".repeat(64)]);
    const creditClaim = await one("INSERT INTO ingest.claims(source_id,entity_kind,album_credit_id,field,raw_value,raw_hash,status,identity_key) VALUES($1,'album_credit',$2,'credit_role',to_jsonb('Guitarra'::text),$3,'accepted','split:2') RETURNING id", [sourceId, creditA, "3".repeat(64)]);

    const plan = personCorrectionPlanSchema.parse({
      decidedAt: "2026-09-16",
      evidence: "dos personas en una sola fila",
      corrections: [{
        op: "split",
        person: { id: combined, name: "Ana Valencia Pimpi QA Carlos Moreán QA" },
        into: ["Ana Valencia QA", "Carlos Moreán QA"],
        why: "la ficha combina dos personas",
      }],
    });
    const result = await applyPersonCorrections(plan, "prueba de división");
    expect(result.outcomes).toEqual([expect.objectContaining({ op: "split", status: "applied" })]);

    const ana = await one("SELECT id FROM public.persons WHERE name='Ana Valencia QA'");
    // La ficha combinada ya no existe; los destinos sí (uno reutilizado).
    expect(await count("SELECT count(*) n FROM public.persons WHERE id=$1", [combined])).toBe(0);
    expect(await count("SELECT count(*) n FROM public.persons WHERE name='Carlos Moreán QA'")).toBe(1);

    // Cada destino tiene copia de los dos créditos y de la membresía.
    for (const target of [ana, existing]) {
      expect(await count("SELECT count(*) n FROM public.album_credits WHERE person_id=$1 AND album_id=$2", [target, album])).toBe(2);
      expect(await count("SELECT count(*) n FROM public.artist_members WHERE person_id=$1 AND artist_id=$2", [target, band])).toBe(1);
    }
    // Las filas originales se retiraron (la de la guitarra se fue con sus copias).
    expect(await count("SELECT count(*) n FROM public.album_credits WHERE id=ANY($1::int[])", [[creditA, creditB]])).toBe(0);

    // Auditoría `split_from`: una fila por relación copiada y una por destino
    // con la historia de la ficha combinada.
    expect(await count("SELECT count(*) n FROM ingest.merge_audit WHERE field='split_from'")).toBeGreaterThanOrEqual(6);
    expect(await count("SELECT count(*) n FROM ingest.merge_audit WHERE field='split_from' AND person_id=$1", [ana])).toBe(1);
    expect(await count(`SELECT count(*) n FROM ingest.merge_audit_claims mac
       JOIN ingest.merge_audit ma ON ma.id=mac.merge_audit_id
      WHERE ma.field='split_from' AND mac.claim_id=$1`, [nameClaim])).toBe(2);

    // Los claims no se borran: el del nombre queda rechazado (retiro normal) y
    // el del crédito, superseded sin destino.
    const claims = (await getPool().query<{ id: number; person_id: string | null; album_credit_id: string | null; status: string }>(
      "SELECT id::int, person_id::text, album_credit_id::text, status FROM ingest.claims WHERE id=ANY($1::int[]) ORDER BY id",
      [[nameClaim, creditClaim]])).rows;
    expect(claims).toEqual([
      { id: nameClaim, person_id: null, album_credit_id: null, status: "rejected" },
      { id: creditClaim, person_id: null, album_credit_id: null, status: "superseded" },
    ]);
  });

  it("divide: consolida los créditos equivalentes de CADA destino, no solo del primero", async () => {
    const band = await one("INSERT INTO public.artists(name) VALUES('Banda Equiv QA') RETURNING id");
    const album = await one("INSERT INTO public.albums(artist_id,title) VALUES($1,'Disco Equiv QA') RETURNING id", [band]);
    const combined = await one("INSERT INTO public.persons(name) VALUES('Equiv Uno QA Equiv Dos QA') RETURNING id");
    const second = await one("INSERT INTO public.persons(name) VALUES('Equiv Dos QA') RETURNING id");
    // El SEGUNDO destino ya traía dos créditos equivalentes (de fusiones anteriores).
    await getPool().query("INSERT INTO public.album_credits(album_id,person_id,credit_type,role) VALUES($1,$2,'musician','Guitarra'),($1,$2,'musician','Guitarra')", [album, second]);
    await getPool().query("INSERT INTO public.album_credits(album_id,person_id,credit_type,role) VALUES($1,$2,'musician','Guitarra')", [album, combined]);

    const plan = personCorrectionPlanSchema.parse({
      decidedAt: "2026-09-16", evidence: "dos personas en una fila (equivalencias)",
      corrections: [{
        op: "split",
        person: { id: combined, name: "Equiv Uno QA Equiv Dos QA" },
        into: ["Equiv Uno QA", "Equiv Dos QA"],
        why: "la ficha combina dos personas",
      }],
    });
    await applyPersonCorrections(plan, "prueba de equivalencias por destino");

    const first = await one("SELECT id FROM public.persons WHERE name='Equiv Uno QA'");
    // Al primero llegó la copia; al segundo no se le sumó otra. Tras consolidar,
    // los dos destinos (no solo el primero) quedan con UNA fila equivalente.
    for (const target of [first, second]) {
      expect(await count(
        "SELECT count(*) n FROM public.album_credits WHERE person_id=$1 AND album_id=$2 AND credit_type='musician' AND role='Guitarra'",
        [target, album])).toBe(1);
    }
  });

  it("aborta el plan si un destino nombra a la propia ficha o es ambiguo", async () => {
    const combined = await one("INSERT INTO public.persons(name) VALUES('Conflicto División QA') RETURNING id");
    const selfTarget = personCorrectionPlanSchema.parse({
      decidedAt: "2026-09-16", evidence: "x",
      corrections: [{ op: "split", person: { id: combined, name: "Conflicto División QA" }, into: ["Conflicto División QA", "Otro Nombre QA"], why: "mal plan" }],
    });
    await expect(applyPersonCorrections(selfTarget, "prueba de aborto")).rejects.toThrow("no se apunta a sí misma");
    expect(await count("SELECT count(*) n FROM public.persons WHERE id=$1", [combined])).toBe(1);
  });
});
