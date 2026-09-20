// CRV · Contratos de cierre E7/E8 de PLAN_CURADURIA_20_DE_20.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { buildApp } from "../../src/api/app.js";
import { runCurationScan, waitForCurationScans } from "../../src/curation/scan.js";

const TOKEN = "token-e7-e8-012345678901234567890123";
const OPERATOR = "Tester E7 E8";
const headers = { authorization: `Bearer ${TOKEN}`, "x-crv-operator": OPERATOR };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

describe("Curaduría E7/E8: decisión y operación desde la misma superficie", () => {
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
    await waitForCurationScans();
    await app?.close();
    await closeDb();
    await container?.stop();
  }, 60_000);

  async function one(sql: string, params: unknown[] = []): Promise<number> {
    return Number((await getPool().query<{ id: string }>(sql, params)).rows[0]!.id);
  }

  async function source(slug: string, trust: "high" | "medium" | "low" | "api"): Promise<number> {
    return one(
      "INSERT INTO ingest.sources(slug,name,url,site_type,trust_level,enabled) VALUES($1,$2,$3,'website',$4,true) RETURNING id",
      [slug, slug, `https://fixture.invalid/${slug}`, trust],
    );
  }

  async function conflict(input: {
    artistId: number; sourceA: number; sourceB: number; valueA: string; valueB: string;
  }): Promise<{ conflictId: number; claimA: number; claimB: number }> {
    const claim = (sourceId: number, value: string) => one(`
      INSERT INTO ingest.claims(source_id,entity_kind,artist_id,field,raw_value,raw_hash,status,confidence)
      VALUES($1,'artist',$2,'origin_city',to_jsonb($3::text),$4,'conflict','high') RETURNING id`,
    [sourceId, input.artistId, value, sha(`${sourceId}:${input.artistId}:${value}`)]);
    const claimA = await claim(input.sourceA, input.valueA);
    const claimB = await claim(input.sourceB, input.valueB);
    const conflictId = await one(`
      INSERT INTO ingest.conflicts(claim_a_id,claim_b_id,entity_kind,field,value_a,value_b)
      VALUES($1,$2,'artist','origin_city',to_jsonb($3::text),to_jsonb($4::text)) RETURNING id`,
    [claimA, claimB, input.valueA, input.valueB]);
    return { conflictId, claimA, claimB };
  }

  it("previsualiza por trust_level, excluye empates y aplica solo el lado de mayor confianza", async () => {
    const high = await source("e7-high", "high");
    const low = await source("e7-low", "low");
    const high2 = await source("e7-high-2", "high");

    const artist = await one("INSERT INTO public.artists(name,origin_city) VALUES('E7 Confianza','Valencia') RETURNING id");
    const chosen = await conflict({ artistId: artist, sourceA: high, sourceB: low, valueA: "Caracas", valueB: "Maracay" });

    const tiedArtist = await one("INSERT INTO public.artists(name,origin_city) VALUES('E7 Empate','Mérida') RETURNING id");
    const tied = await conflict({ artistId: tiedArtist, sourceA: high, sourceB: high2, valueA: "Barquisimeto", valueB: "Coro" });

    expect((await runCurationScan({ trigger: "manual" })).status).toBe("ok");

    const previewResponse = await app.inject({
      method: "POST", url: "/curation/conflicts/trust-preview", headers,
      payload: { category: "valores_en_disputa", detector: "conflictos_abiertos" },
    });
    expect(previewResponse.statusCode, previewResponse.body).toBe(200);
    const preview = previewResponse.json();
    expect(preview).toMatchObject({ eligible: 1, ties: 1, unavailable: 0 });
    expect(preview.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ conflictId: chosen.conflictId, eligible: true, chosen: "a" }),
      expect.objectContaining({ conflictId: tied.conflictId, eligible: false, chosen: null }),
    ]));
    const eligible = preview.items.find((item: { conflictId: number }) => item.conflictId === chosen.conflictId);
    expect(eligible.claimA).toMatchObject({
      sourceTrustLevel: "high", sourceName: "e7-high", sourceUrl: "https://fixture.invalid/e7-high",
      claimCreatedAt: expect.any(String),
    });
    expect(eligible.claimB).toMatchObject({ sourceTrustLevel: "low" });

    const apply = await app.inject({
      method: "POST", url: "/curation/conflicts/trust-apply", headers,
      payload: {
        filter: { category: "valores_en_disputa", detector: "conflictos_abiertos" },
        previewHash: preview.previewHash,
        note: "aceptar solo la fuente de mayor confianza",
      },
    });
    expect(apply.statusCode, apply.body).toBe(200);
    expect(apply.json()).toMatchObject({ applied: 1, skippedStale: 0, failed: 0 });
    expect((await getPool().query("SELECT origin_city FROM public.artists WHERE id=$1", [artist])).rows[0])
      .toEqual({ origin_city: "Caracas" });
    expect((await getPool().query("SELECT status::text FROM ingest.conflicts WHERE id=$1", [chosen.conflictId])).rows[0])
      .toEqual({ status: "resolved_a" });
    expect((await getPool().query("SELECT status::text FROM ingest.conflicts WHERE id=$1", [tied.conflictId])).rows[0])
      .toEqual({ status: "open" });
  }, 60_000);

  it("expone revisión con fuente/confianza/fecha y person_duplicate dentro de Curaduría", async () => {
    const high = await source("e7-review-high", "high");
    const medium = await source("e7-review-medium", "medium");
    const artist = await one("INSERT INTO public.artists(name,origin_city) VALUES('E7 Review','Valencia') RETURNING id");
    const field = await conflict({ artistId: artist, sourceA: high, sourceB: medium, valueA: "Caracas", valueB: "Maracay" });
    const reviewId = await one(`
      INSERT INTO ingest.review_queue(kind,conflict_id,claim_a_id,claim_b_id,artist_a_id,notes)
      VALUES('field_conflict',$1,$2,$3,$4,'conflicto E7') RETURNING id`,
    [field.conflictId, field.claimA, field.claimB, artist]);

    const personA = await one("INSERT INTO public.persons(name) VALUES('Persona Duplicada A') RETURNING id");
    const personB = await one("INSERT INTO public.persons(name) VALUES('Persona Duplicada B') RETURNING id");
    const duplicateReview = await one(`
      INSERT INTO ingest.review_queue(kind,person_a_id,person_b_id,priority,notes,payload)
      VALUES('person_duplicate',$1,$2,7,'comparar personas','{}'::jsonb) RETURNING id`,
    [personA, personB]);
    const acceptReviewId = await one(
      "INSERT INTO ingest.review_queue(kind,priority,notes,payload) VALUES('missing_url',8,'aceptar desde Curaduría','{}'::jsonb) RETURNING id",
    );
    const rejectReviewId = await one(
      "INSERT INTO ingest.review_queue(kind,priority,notes,payload) VALUES('new_source',8,'rechazar desde Curaduría','{}'::jsonb) RETURNING id",
    );

    expect((await runCurationScan({ trigger: "manual" })).status).toBe("ok");

    const detail = await app.inject({ method: "GET", url: `/review-queue/${reviewId}`, headers });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().claims).toEqual([
      expect.objectContaining({ id: field.claimA, sourceTrustLevel: "high", claimCreatedAt: expect.any(String), evidenceUrl: "https://fixture.invalid/e7-review-high" }),
      expect.objectContaining({ id: field.claimB, sourceTrustLevel: "medium", claimCreatedAt: expect.any(String), evidenceUrl: "https://fixture.invalid/e7-review-medium" }),
    ]);

    const findings = await app.inject({
      method: "GET", url: "/curation/findings?category=fichas_repetidas&detector=cola_de_revision&limit=100", headers,
    });
    expect(findings.statusCode, findings.body).toBe(200);
    expect(findings.json().data).toEqual(expect.arrayContaining([
      expect.objectContaining({ entity: expect.objectContaining({ kind: "review", id: duplicateReview }), signature: "review:person_duplicate" }),
    ]));

    const summary = await app.inject({ method: "GET", url: "/curation/summary", headers });
    expect(summary.statusCode, summary.body).toBe(200);
    expect(summary.json().duplicateCandidates).toBeGreaterThanOrEqual(1);

    const accepted = await app.inject({
      method: "POST", url: `/review-queue/${acceptReviewId}/accept`, headers,
      payload: { note: "aceptada desde la tarjeta E7" },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toMatchObject({ reviewId: acceptReviewId, action: "accepted", status: "approved" });

    const rejected = await app.inject({
      method: "POST", url: `/review-queue/${rejectReviewId}/reject`, headers,
      payload: { note: "rechazada desde la tarjeta E7" },
    });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json()).toMatchObject({ reviewId: rejectReviewId, action: "rejected", status: "dismissed" });
    const states = await getPool().query<{ id: string; status: string }>(
      "SELECT id::text,status::text FROM ingest.review_queue WHERE id=ANY($1::bigint[]) ORDER BY id",
      [[acceptReviewId, rejectReviewId]],
    );
    expect(states.rows).toEqual([
      { id: String(acceptReviewId), status: "approved" },
      { id: String(rejectReviewId), status: "dismissed" },
    ]);
  }, 60_000);

  it("lista lotes y permite archivar una cadena revisada sin perder su historia", async () => {
    const organization = await one(
      "INSERT INTO public.organizations(name) VALUES($1) RETURNING id",
      [`Estudio${ZERO_WIDTH_SPACE} E8`],
    );
    expect((await runCurationScan({ trigger: "manual" })).status).toBe("ok");
    const found = await getPool().query<{ id: string }>(`
      SELECT id::text FROM ingest.curation_findings
       WHERE detector='caracteres_invisibles' AND entity_kind='organization' AND entity_id=$1 AND status='open'`,
    [organization]);
    const findingId = Number(found.rows[0]!.id);

    await getPool().query(`
      UPDATE ingest.curation_findings
         SET evidence=evidence || $2::jsonb
       WHERE id=$1`,
    [findingId, JSON.stringify({ triggeredBy: [{ id: 777, title: "Corrección previa", entityKind: "organization", entityId: organization }] })]);

    const reviewed = await app.inject({
      method: "POST", url: `/curation/findings/${findingId}/review-trigger`, headers,
    });
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    expect(reviewed.json().triggeredBy).toEqual([]);
    const history = (await getPool().query<{ evidence: Record<string, unknown> }>(
      "SELECT evidence FROM ingest.curation_findings WHERE id=$1", [findingId])).rows[0]!.evidence;
    expect(history["triggeredBy"]).toBeUndefined();
    expect(history["triggeredHistory"]).toEqual([
      expect.objectContaining({ reviewedBy: OPERATOR, reviewedAt: expect.any(String), causes: expect.any(Array) }),
    ]);

    const preview = await app.inject({
      method: "POST", url: "/curation/fixes/preview?limit=20", headers,
      payload: { mode: "individual", findingIds: [findingId] },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const batch = preview.json();
    const listed = await app.inject({ method: "GET", url: "/curation/fixes?limit=20", headers });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: batch.id, mode: "individual", status: "previewed", requestedBy: OPERATOR }),
    ]));
  }, 60_000);
});
