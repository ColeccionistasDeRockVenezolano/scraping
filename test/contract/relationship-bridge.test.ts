// El puente de relaciones es lo que convierte claims sueltos en hechos del
// catálogo: quién tocó en qué banda, quién está acreditado en qué disco y en
// qué pista. Este contrato fija las tres garantías que lo hacen confiable:
// no inventa extremos, no escribe sin decisión humana o alta confianza, y un
// crédito de disco jamás se convierte en una membresía de banda.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { migrateUp } from "../../src/db/migrate.js";
import { closeDb, getDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { normalizeRecord } from "../../src/normalization/claims.js";
import { mergeClaim, type MergeOutcome } from "../../src/merge/engine.js";
import { persistClaim, type Actor, type ClaimToPersist, type Confidence } from "../../src/claims/persistence.js";
import type { RawRecord } from "../../src/adapters/contracts.js";
import { sources } from "../../src/db/schema/ingest.js";

let counter = 0;

/**
 * Una relación es un registro completo, no un campo: se persisten todos sus
 * claims y se mergean en orden, igual que hace `review approve`.
 */
async function applyRecord(options: {
  sourceId: number;
  kind: RawRecord["entityKind"];
  identity: string;
  fields: Array<[string, unknown]>;
  confidence?: Confidence;
  createdBy?: Actor;
}): Promise<MergeOutcome[]> {
  counter += 1;
  const record: RawRecord = {
    entityKind: options.kind, identity: options.identity,
    extractor: "bridge-contract", extractorVersion: "1",
    fields: options.fields.map(([field, value]) => ({
      field, value,
      evidence: { url: `https://fixture.invalid/bridge/${counter}`, excerpt: String(value) },
    })),
  };
  const inputs: ClaimToPersist[] = normalizeRecord(record).map((claim) => ({
    ...claim, sourceId: options.sourceId, confidence: options.confidence ?? "high",
    ...(options.createdBy === undefined ? {} : { createdBy: options.createdBy }),
  }));
  // Dos fases, igual que el runner: el registro completo se persiste antes de
  // mergear nada, para que cada claim vea a sus hermanos.
  const persisted = [];
  for (const input of inputs) persisted.push(await persistClaim(input));
  const outcomes: MergeOutcome[] = [];
  for (const [index, input] of inputs.entries()) outcomes.push(await mergeClaim(input, persisted[index]!));
  return outcomes;
}

const count = async (table: string, where = "TRUE", params: unknown[] = []): Promise<number> =>
  Number((await getPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE ${where}`, params)).rows[0]!.n);

describe("puente de relaciones: membresías y créditos", () => {
  let container: PgContainer;
  let sourceId: number;

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl; resetEnvCache();
    await applyCore(container.name); await migrateUp();
    const [source] = await getDb().insert(sources).values({
      slug: "bridge-suite", name: "Bridge fixture", siteType: "website", trustLevel: "high", enabled: true,
    }).returning();
    sourceId = source!.id;

    await applyRecord({ sourceId, kind: "artist", identity: "Los Kings", fields: [["name", "Los Kings"]] });
    await applyRecord({ sourceId, kind: "person", identity: "Efraín Rodríguez", fields: [["name", "Efraín Rodríguez"]] });
    await applyRecord({ sourceId, kind: "person", identity: "Leo Blanco", fields: [["name", "Leo Blanco"]] });
  }, 180_000);

  afterAll(async () => { await closeDb(); await container.stop(); }, 60_000);

  it("crea álbum y pista resolviendo el parental por nombre desde la identidad", async () => {
    const album = await applyRecord({
      sourceId, kind: "album", identity: "Los Kings::Fusión 4",
      fields: [["title", "Fusión 4"], ["artist_name", "Los Kings"], ["release_year", "1996"]],
    });
    expect(album[0]!.action).toBe("applied");
    expect(album[0]!.albumId).toBeGreaterThan(0);

    // El número de pista viaja en un claim hermano, no en el del título:
    // sin leerlo la pista no podría crearse (el core exige track_number).
    const track = await applyRecord({
      sourceId, kind: "track", identity: "Los Kings::Fusión 4::Tarde",
      fields: [["title", "Tarde"], ["album_title", "Fusión 4"], ["artist_name", "Los Kings"], ["track_number", "3"]],
    });
    expect(track.map((item) => item.action)).toContain("applied");
    expect(await count("public.tracks", "title=$1 AND track_number=3", ["Tarde"])).toBe(1);
  }, 60_000);

  it("materializa la membresía con rol y período, y es idempotente", async () => {
    const outcomes = await applyRecord({
      sourceId, kind: "artist_membership", identity: "Los Kings::Efraín Rodríguez::Guitar",
      fields: [["artist_name", "Los Kings"], ["person_name", "Efraín Rodríguez"], ["role", "Guitar"],
        ["from_year", "1970"], ["to_year", "1976"]],
    });
    expect(outcomes[0]).toMatchObject({ action: "applied", relationKind: "artist_membership" });
    // Los claims restantes encuentran la fila ya creada: mismo hecho, una fila.
    expect(outcomes.slice(1).every((item) => item.action === "unchanged")).toBe(true);

    const { rows } = await getPool().query(`
      SELECT m.role, m.from_year, m.to_year, m.is_current, a.name AS artist, p.name AS person
        FROM public.artist_members m
        JOIN public.artists a ON a.id=m.artist_id JOIN public.persons p ON p.id=m.person_id`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: "Guitar", from_year: 1970, to_year: 1976, is_current: false,
      artist: "Los Kings", person: "Efraín Rodríguez",
    });
    expect(await count("ingest.merge_audit", "entity_kind='artist_membership' AND artist_membership_id IS NOT NULL")).toBe(1);

    const again = await applyRecord({
      sourceId, kind: "artist_membership", identity: "Los Kings::Efraín Rodríguez::Guitar",
      fields: [["artist_name", "Los Kings"], ["person_name", "Efraín Rodríguez"], ["role", "Guitar"]],
    });
    expect(again.every((item) => item.action === "unchanged")).toBe(true);
    expect(await count("public.artist_members")).toBe(1);

    // Otra función de la misma persona en la misma banda es otra membresía,
    // no un duplicado: el rol es parte de lo que la fila afirma.
    const secondRole = await applyRecord({
      sourceId, kind: "artist_membership", identity: "Los Kings::Efraín Rodríguez::Vocals",
      fields: [["artist_name", "Los Kings"], ["person_name", "Efraín Rodríguez"], ["role", "Vocals"]],
    });
    expect(secondRole[0]!.action).toBe("applied");
    expect(await count("public.artist_members")).toBe(2);

    // Un año de ingreso contradictorio no se elige ni se sobrescribe: la
    // relación entera queda en revisión con el campo en disputa nombrado.
    const contradicts = await applyRecord({
      sourceId, kind: "artist_membership", identity: "Los Kings::Efraín Rodríguez::Guitar",
      fields: [["artist_name", "Los Kings"], ["person_name", "Efraín Rodríguez"], ["role", "Guitar"],
        ["from_year", "1981"]],
    });
    expect(contradicts.every((item) => item.action === "candidate")).toBe(true);
    expect(await count("public.artist_members", "from_year=1970")).toBe(1);
    expect(await count("ingest.review_queue",
      "payload->>'reason'='claims contradictorios sobre el mismo hecho' AND payload->'fields' ? 'from_year'")).toBeGreaterThan(0);
  }, 60_000);

  it("acredita a una persona en un álbum sin tocar artist_members", async () => {
    const before = await count("public.artist_members");
    const outcomes = await applyRecord({
      sourceId, kind: "album_credit", identity: "Fusión 4::Leo Blanco::Piano",
      fields: [["album_title", "Fusión 4"], ["artist_name", "Los Kings"],
        ["credited_name", "Leo Blanco"], ["credit_role", "Piano"], ["credit_scope", "album"]],
    });
    expect(outcomes[0]!.action).toBe("applied");
    const { rows } = await getPool().query(`
      SELECT c.credit_type::text, c.role, p.name AS person, c.artist_id, c.organization_id
        FROM public.album_credits c JOIN public.persons p ON p.id=c.person_id`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ credit_type: "musician", role: "Piano", person: "Leo Blanco", artist_id: null, organization_id: null });
    // Regla dura: tocar en un disco no es pertenecer a la banda.
    expect(await count("public.artist_members")).toBe(before);
  }, 60_000);

  it("expande un crédito acotado a varias pistas en una fila por pista", async () => {
    await applyRecord({
      sourceId, kind: "track", identity: "Los Kings::Fusión 4::Amanecer",
      fields: [["title", "Amanecer"], ["album_title", "Fusión 4"], ["artist_name", "Los Kings"], ["track_number", "5"]],
    });
    const outcomes = await applyRecord({
      sourceId, kind: "track_credit", identity: "Fusión 4::Leo Blanco::Producer",
      fields: [["album_title", "Fusión 4"], ["artist_name", "Los Kings"], ["credited_name", "Leo Blanco"],
        ["credit_role", "Produced by"], ["credit_scope", "track"], ["track_numbers", "tracks 03, 05"]],
    });
    expect(outcomes[0]!.action).toBe("applied");
    expect(outcomes[0]!.relationIds).toHaveLength(2);
    const { rows } = await getPool().query<{ credit_type: string; title: string }>(`
      SELECT c.credit_type::text, t.title FROM public.track_credits c
        JOIN public.tracks t ON t.id=c.track_id ORDER BY t.track_number`);
    expect(rows.map((row) => row.title)).toEqual(["Tarde", "Amanecer"]);
    expect(rows.every((row) => row.credit_type === "producer")).toBe(true);
  }, 60_000);

  it("no escribe cuando el extremo no existe: deja el claim candidato y abre revisión", async () => {
    const outcomes = await applyRecord({
      sourceId, kind: "artist_membership", identity: "Los Kings::Nadie Conocido::Bass",
      fields: [["artist_name", "Los Kings"], ["person_name", "Nadie Conocido"], ["role", "Bass"]],
    });
    expect(outcomes.every((item) => item.action === "candidate")).toBe(true);
    expect(await count("public.artist_members")).toBe(2);
    expect(await count("ingest.review_queue", "kind='manual_review' AND payload->>'relationKind'='artist_membership'")).toBeGreaterThan(0);
  }, 60_000);

  it("una relación low automática nunca toca el core", async () => {
    const outcomes = await applyRecord({
      sourceId, kind: "album_credit", identity: "Fusión 4::Efraín Rodríguez::Guitar",
      fields: [["album_title", "Fusión 4"], ["artist_name", "Los Kings"],
        ["credited_name", "Efraín Rodríguez"], ["credit_role", "Guitar"], ["credit_scope", "album"]],
      confidence: "low",
    });
    expect(outcomes.every((item) => item.action === "candidate")).toBe(true);
    expect(await count("public.album_credits")).toBe(1);

    // La misma evidencia, aprobada por una persona, sí se materializa.
    const approved = await applyRecord({
      sourceId, kind: "album_credit", identity: "Fusión 4::Efraín Rodríguez::Guitar",
      fields: [["album_title", "Fusión 4"], ["artist_name", "Los Kings"],
        ["credited_name", "Efraín Rodríguez"], ["credit_role", "Guitar"], ["credit_scope", "album"]],
      confidence: "low", createdBy: "human",
    });
    expect(approved[0]!.action).toBe("applied");
    expect(await count("public.album_credits")).toBe(2);
    expect(await count("ingest.review_queue", "kind='low_confidence' AND status='open' AND claim_a_id IN (SELECT id FROM ingest.claims WHERE entity_kind='album_credit')")).toBe(0);
  }, 60_000);
});
