// CRV · E7B — API de escritura y cola de revisión (docs/PHASES.md §E7B).
// Contra una PostgreSQL desechable y a través de `app.inject()`:
//   * el CRUD pasa por el merge engine (claims human/high, merge_audit, run);
//   * una corrección manual de un dato conflictivo resuelve el conflicto y
//     conserva el historial (criterio de salida);
//   * aceptar/rechazar candidatos de la cola deja su rastro;
//   * sin token no se escribe.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { buildApp } from "../../src/api/app.js";
import { normalizeRecord } from "../../src/normalization/claims.js";
import { persistClaim, type ClaimToPersist } from "../../src/claims/persistence.js";
import { mergeClaim } from "../../src/merge/engine.js";

const TOKEN = "token-de-prueba-del-operador-0123456789";
const OPERATOR = "Tester API";

describe("API de escritura (E7B)", () => {
  let container: PgContainer;
  let app: FastifyInstance;
  let sourceA: number;
  let sourceB: number;
  let evidence = 0;

  const pool = () => getPool();
  const one = async <T>(sql: string, params: unknown[] = []): Promise<T> => (await pool().query(sql, params)).rows[0] as T;

  async function write(method: "POST" | "PATCH" | "DELETE", url: string, payload?: Record<string, unknown>) {
    return app.inject({
      method, url,
      headers: { authorization: `Bearer ${TOKEN}`, "x-crv-operator": OPERATOR },
      ...(payload === undefined ? {} : { payload }),
    });
  }

  /** Claim de una fuente, como lo dejaría la ingesta, pasado por el merge. */
  async function sourceClaim(
    sourceId: number, entityKind: ClaimToPersist["entityKind"], identity: string, field: string, value: unknown,
    extra: Partial<ClaimToPersist> = {},
  ) {
    evidence += 1;
    const normalized = normalizeRecord({
      entityKind, identity, extractor: "api-write-fixture", extractorVersion: "1",
      fields: [{ field, value, evidence: { url: `https://fixture.invalid/api-write/${evidence}` } }],
    })[0]!;
    const input: ClaimToPersist = { ...normalized, sourceId, confidence: "high", ...extra };
    const persisted = await persistClaim(input);
    return { persisted, outcome: await mergeClaim(input, persisted) };
  }

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    process.env["CRV_OPERATOR_TOKEN"] = TOKEN;
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
    sourceA = Number((await one<{ id: string }>(
      "INSERT INTO ingest.sources(slug,name,site_type,trust_level,enabled) VALUES('fuente-a','Fuente A','website','high',true) RETURNING id")).id);
    sourceB = Number((await one<{ id: string }>(
      "INSERT INTO ingest.sources(slug,name,site_type,trust_level,enabled) VALUES('fuente-b','Fuente B','website','high',true) RETURNING id")).id);
    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await closeDb();
    delete process.env["CRV_OPERATOR_TOKEN"];
    resetEnvCache();
    await container.stop();
  }, 60_000);

  it("sin token válido no se escribe, y la lectura sigue abierta", async () => {
    const anonymous = await app.inject({ method: "POST", url: "/artists", payload: { name: "Nadie" } });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ error: { code: "unauthorized" } });
    const wrong = await app.inject({ method: "POST", url: "/artists", payload: { name: "Nadie" }, headers: { authorization: "Bearer otro-token-cualquiera-de-32-caracteres" } });
    expect(wrong.statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/artists" })).statusCode).toBe(200);
    expect(Number((await one<{ n: string }>("SELECT count(*) n FROM public.artists")).n)).toBe(0);
  });

  let artistId: number;
  let albumId: number;

  it("crea artista y álbum a través del merge, con claims humanos, run y auditoría", async () => {
    const created = await write("POST", "/artists", {
      name: "Caramelos De Cianuro", originCity: "Caracas", formedYear: 1989,
      biography: "Banda de Caracas.\n\nSu primer EP salió en 1992.", note: "alta de prueba",
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    artistId = body.id;
    // El nombre crea la ficha y va primero; el resto sigue el orden del esquema.
    expect(body.fields[0]).toEqual({ field: "name", action: "applied", conflictsClosed: [] });
    expect(body.fields.map((item: { field: string; action: string }) => [item.field, item.action]).sort()).toEqual([
      ["biography", "applied"], ["formed_year", "applied"], ["name", "applied"], ["origin_city", "applied"],
    ]);

    const detail = (await app.inject({ method: "GET", url: `/artists/${artistId}` })).json();
    expect(detail).toMatchObject({ name: "Caramelos De Cianuro", originCity: "Caracas", formedYear: 1989 });
    expect(detail.biography).toBe("Banda de Caracas.\n\nSu primer EP salió en 1992.");

    const claims = await pool().query<{ created_by: string; confidence: string; status: string; run_id: string }>(
      "SELECT created_by::text,confidence::text,status::text,run_id::text FROM ingest.claims WHERE artist_id=$1", [artistId]);
    expect(claims.rows).toHaveLength(4);
    expect(claims.rows.every((row) => row.created_by === "human" && row.confidence === "high" && row.status === "accepted")).toBe(true);
    expect(new Set(claims.rows.map((row) => Number(row.run_id)))).toEqual(new Set([body.runId]));

    const run = (await app.inject({ method: "GET", url: `/runs/${body.runId}` })).json();
    expect(run).toMatchObject({ kind: "manual", status: "ok", params: { action: "api:create:artist", operator: OPERATOR, note: "alta de prueba" } });
    const audit = (await app.inject({ method: "GET", url: `/audit?entity=artist&id=${artistId}` })).json();
    expect(audit.pagination.total).toBe(4);
    expect(audit.data.every((row: { performedBy: string; runId: number; claimIds: number[] }) =>
      row.performedBy === "human" && row.runId === body.runId && row.claimIds.length === 1)).toBe(true);

    const duplicate = await write("POST", "/artists", { name: "Caramelos De Cianuro" });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: { code: "already_exists", details: { existingId: artistId } } });

    const album = await write("POST", "/albums", { artistId, title: "Las Paticas De La Abuela", releaseYear: 1992, albumType: "ep" });
    expect(album.statusCode).toBe(201);
    albumId = album.json().id;
    const patched = await write("PATCH", `/albums/${albumId}`, { genre: "Rock" });
    expect(patched.json().fields).toEqual([{ field: "genre", action: "applied", conflictsClosed: [] }]);
    const albumDetail = (await app.inject({ method: "GET", url: `/albums/${albumId}` })).json();
    expect(albumDetail).toMatchObject({ title: "Las Paticas De La Abuela", releaseYear: 1992, albumType: "ep", genre: "Rock", artist: { id: artistId } });
  });

  it("corregir un valor ya afirmado lo sustituye con auditoría y deja el anterior como superseded", async () => {
    const corrected = await write("PATCH", `/artists/${artistId}`, { formedYear: 1990, note: "el primer ensayo fue en 1990" });
    expect(corrected.statusCode).toBe(200);
    expect(corrected.json().fields[0]).toMatchObject({ field: "formed_year", action: "corrected" });
    expect((await one<{ formed_year: number }>("SELECT formed_year FROM public.artists WHERE id=$1", [artistId])).formed_year).toBe(1990);

    const claims = await pool().query<{ value: unknown; status: string }>(
      "SELECT normalized_value AS value,status::text FROM ingest.claims WHERE artist_id=$1 AND field='formed_year' ORDER BY id", [artistId]);
    expect(claims.rows).toEqual([{ value: 1989, status: "superseded" }, { value: 1990, status: "accepted" }]);
    const conflict = await one<{ status: string; resolved_by: string }>(
      "SELECT status::text,resolved_by::text FROM ingest.conflicts WHERE entity_kind='artist' AND field='formed_year'");
    expect(conflict).toEqual({ status: "resolved_b", resolved_by: "human" });
    const audit = await pool().query<{ old_value: unknown; new_value: unknown; reason: string }>(
      "SELECT old_value,new_value,reason FROM ingest.merge_audit WHERE artist_id=$1 AND field='formed_year' ORDER BY id", [artistId]);
    expect(audit.rows.map((row) => [row.old_value, row.new_value])).toEqual([[null, 1989], [1989, 1990]]);
    expect(audit.rows[1]!.reason).toContain("el primer ensayo fue en 1990");

    // Renombrar: el nombre nuevo queda como alias, el anterior sigue siéndolo.
    const renamed = await write("PATCH", `/artists/${artistId}`, { name: "Caramelos de Cianuro" });
    expect(renamed.json().fields[0]).toMatchObject({ field: "name", action: "corrected" });
    const aliases = await pool().query<{ alias: string }>("SELECT alias FROM ingest.artist_aliases WHERE artist_id=$1", [artistId]);
    expect(aliases.rows.map((row) => row.alias).sort()).toEqual(["Caramelos De Cianuro", "Caramelos de Cianuro"]);
    expect((await one<{ name: string }>("SELECT name FROM public.artists WHERE id=$1", [artistId])).name).toBe("Caramelos de Cianuro");
  });

  it("registra, corrige y retira pistas, créditos, miembros, organizaciones y formatos", async () => {
    const track = await write("POST", "/tracks", { albumId, title: "La Bruja", trackNumber: 3, durationSeconds: 140 });
    expect(track.statusCode).toBe(201);
    const trackId = track.json().id;
    const taken = await write("POST", "/tracks", { albumId, title: "Otra", trackNumber: 3 });
    expect(taken.statusCode).toBe(409);

    const boris = (await write("POST", "/persons", { name: "Boris Milan", isVenezuelan: true })).json().id;
    const studio = (await write("POST", "/organizations", { name: "Mad Box's Studios", organizationType: "recording_studio" })).json().id;

    const credit = await write("POST", "/album-credits", { albumId, personId: boris, role: "Mixed by" });
    expect(credit.statusCode).toBe(201);
    const creditId = credit.json().id;
    const again = await write("POST", "/album-credits", { albumId, personId: boris, role: "Mixed by" });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ id: creditId, created: false });
    expect((await write("POST", "/album-credits", { albumId, personId: boris, organizationId: studio, role: "Recorded" })).statusCode).toBe(400);
    const studioCredit = await write("POST", "/album-credits", { albumId, organizationId: studio, role: "Recorded at" });
    expect(studioCredit.statusCode).toBe(201);
    const missing = await write("POST", "/album-credits", { albumId, personId: 999_999, role: "Guitar" });
    expect(missing.statusCode).toBe(422);

    const trackCredit = await write("POST", "/track-credits", { trackId, personId: boris, role: "Coros", creditType: "guest" });
    expect(trackCredit.statusCode).toBe(201);
    const member = await write("POST", "/artist-members", { artistId, personId: boris, role: "Bass", fromYear: 1989, isCurrent: true });
    expect(member.statusCode).toBe(201);
    const employment = await write("POST", "/person-organizations", { personId: boris, organizationId: studio, role: "Ingeniero de mezcla", fromYear: 1991 });
    expect(employment.statusCode).toBe(201);
    const format = await write("POST", "/album-formats", { albumId, format: "CD", quality: "HQ", archiveStatus: "published" });
    expect(format.statusCode).toBe(201);

    const rows = await one<{ credit: string; track_credit: string; current: boolean; org_role: string; quality: string }>(`
      SELECT (SELECT credit_type::text FROM public.album_credits WHERE id=$1) AS credit,
             (SELECT credit_type::text FROM public.track_credits WHERE id=$2) AS track_credit,
             (SELECT is_current FROM public.artist_members WHERE id=$3) AS current,
             (SELECT role FROM public.person_organizations WHERE id=$4) AS org_role,
             (SELECT quality::text FROM public.album_formats WHERE id=$5) AS quality`,
    [creditId, trackCredit.json().id, member.json().id, employment.json().id, format.json().id]);
    expect(rows).toEqual({ credit: "mixing", track_credit: "guest", current: true, org_role: "Ingeniero de mezcla", quality: "HQ" });

    const fixed = await write("PATCH", `/album-credits/${creditId}`, { role: "Mixing & Mastering", creditType: "mastering", note: "dice la contraportada" });
    expect(fixed.json().fields).toEqual([{ field: "role", action: "corrected" }, { field: "credit_type", action: "corrected" }]);
    const creditAudit = (await app.inject({ method: "GET", url: `/audit?entity=album_credit&id=${creditId}` })).json();
    expect(creditAudit.data.map((row: { field: string; oldValue: unknown; newValue: unknown }) => [row.field, row.oldValue, row.newValue])).toEqual([
      ["credit_type", "mixing", "mastering"], ["role", "Mixed by", "Mixing & Mastering"], ["album_credits", null, expect.objectContaining({ role: "Mixed by" })],
    ]);

    const albumView = (await app.inject({ method: "GET", url: `/albums/${albumId}` })).json();
    expect(albumView.creditsByType.mastering[0]).toMatchObject({ personName: "Boris Milan", role: "Mixing & Mastering" });
    expect(albumView.tracklist[0].credits[0]).toMatchObject({ creditType: "guest", role: "Coros" });

    const blocked = await write("DELETE", `/albums/${albumId}`);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe("has_dependents");

    const removed = await write("DELETE", `/album-credits/${creditId}?note=${encodeURIComponent("crédito duplicado en otra fuente")}`);
    expect(removed.statusCode).toBe(200);
    expect(removed.json().claimsRejected.length).toBeGreaterThan(0);
    const kept = await one<{ field: string; role: string; audits: number }>(`
      SELECT field, old_value->'row'->>'role' AS role, jsonb_array_length(old_value->'audits') AS audits
        FROM ingest.merge_audit WHERE id=$1`, [removed.json().parentAuditId]);
    expect(kept).toEqual({ field: "removed_album_credit", role: "Mixing & Mastering", audits: 3 });
    const rejected = await one<{ n: string }>("SELECT count(*) n FROM ingest.claims WHERE id=ANY($1::bigint[]) AND status='rejected' AND album_credit_id IS NULL",
      [removed.json().claimsRejected]);
    expect(Number(rejected.n)).toBe(removed.json().claimsRejected.length);

    expect((await write("DELETE", `/tracks/${trackId}`)).statusCode).toBe(409);
    expect((await write("DELETE", `/track-credits/${trackCredit.json().id}`)).statusCode).toBe(200);
    const trackGone = await write("DELETE", `/tracks/${trackId}`);
    expect(trackGone.statusCode).toBe(200);
    expect((await one<{ field: string }>("SELECT field FROM ingest.merge_audit WHERE id=$1", [trackGone.json().parentAuditId])).field).toBe("removed_track");
    expect((await write("DELETE", `/tracks/${trackId}`)).statusCode).toBe(404);
  });

  async function conflictOnReleaseYear(title: string, first: number, second: number): Promise<{ albumId: number; reviewId: number; claimA: number; claimB: number }> {
    const created = await write("POST", "/albums", { artistId, title });
    const id = created.json().id as number;
    const a = await sourceClaim(sourceA, "album", `Caramelos De Cianuro::${title}`, "release_year", first, { albumId: id });
    expect(a.outcome.action).toBe("applied");
    const b = await sourceClaim(sourceB, "album", `Caramelos De Cianuro::${title}`, "release_year", second, { albumId: id });
    expect(b.outcome.action).toBe("conflict");
    const review = await one<{ id: string }>(
      "SELECT q.id FROM ingest.review_queue q JOIN ingest.conflicts c ON c.id=q.conflict_id WHERE q.kind='field_conflict' AND q.status='open' AND c.claim_b_id=$1",
      [b.persisted.id]);
    return { albumId: id, reviewId: Number(review.id), claimA: a.persisted.id, claimB: b.persisted.id };
  }

  it("una corrección manual de un dato conflictivo resuelve el conflicto y conserva el historial", async () => {
    const fixture = await conflictOnReleaseYear("Frito", 1995, 1996);
    const listed = (await app.inject({ method: "GET", url: "/review-queue?kind=field_conflict&status=open" })).json();
    expect(listed.data.map((row: { id: number }) => row.id)).toContain(fixture.reviewId);

    const resolved = await write("POST", `/review-queue/${fixture.reviewId}/resolve-conflict`, {
      note: "la contraportada dice 1997", value: 1997,
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({ action: "resolved", status: "approved" });

    expect((await one<{ release_year: number }>("SELECT release_year FROM public.albums WHERE id=$1", [fixture.albumId])).release_year).toBe(1997);
    const conflict = await one<{ status: string; resolved_by: string; resolution_note: string }>(
      "SELECT status::text,resolved_by::text,resolution_note FROM ingest.conflicts WHERE claim_b_id=$1", [fixture.claimB]);
    expect(conflict).toMatchObject({ status: "dismissed", resolved_by: "human" });
    expect(conflict.resolution_note).toContain("la contraportada dice 1997");

    // Nada se perdió: los dos rivales siguen ahí como superseded, con su fuente.
    const claims = (await app.inject({ method: "GET", url: `/claims?entity=album&id=${fixture.albumId}` })).json().data
      .filter((row: { field: string }) => row.field === "release_year")
      .map((row: { sourceName: string; status: string; normalizedValue: unknown }) => [row.sourceName, row.normalizedValue, row.status]);
    expect(claims).toEqual(expect.arrayContaining([
      ["Fuente A", 1995, "superseded"], ["Fuente B", 1996, "superseded"], ["Operador del catálogo (API)", 1997, "accepted"],
    ]));
    const history = (await app.inject({ method: "GET", url: `/audit?entity=album&id=${fixture.albumId}` })).json().data
      .filter((row: { field: string }) => row.field === "release_year")
      .map((row: { oldValue: unknown; newValue: unknown; performedBy: string }) => [row.oldValue, row.newValue, row.performedBy]);
    expect(history).toEqual([[1995, 1997, "human"], [null, 1995, "system"]]);

    const reviewAfter = (await app.inject({ method: "GET", url: `/review-queue/${fixture.reviewId}` })).json();
    expect(reviewAfter).toMatchObject({ status: "approved", resolvedBy: "human" });
    expect(reviewAfter.resolutionNote).toContain("la contraportada dice 1997");

    const repeated = await write("POST", `/review-queue/${fixture.reviewId}/resolve-conflict`, { note: "otra vez", value: 1998 });
    expect(repeated.statusCode).toBe(409);
    expect(repeated.json().error.code).toBe("not_open");
  });

  it("resolver eligiendo el valor propuesto usa el lado del conflicto y audita el cambio", async () => {
    const fixture = await conflictOnReleaseYear("Miss Cristal", 2001, 2002);
    expect((await write("POST", `/review-queue/${fixture.reviewId}/accept`, { note: "no aplica" })).statusCode).toBe(422);
    const both = await write("POST", `/review-queue/${fixture.reviewId}/resolve-conflict`, { note: "x", choice: "proposed", value: 2003 });
    expect(both.statusCode).toBe(422);

    const resolved = await write("POST", `/review-queue/${fixture.reviewId}/resolve-conflict`, { note: "la reedición confirma 2002", choice: "proposed" });
    expect(resolved.statusCode).toBe(200);
    expect((await one<{ release_year: number }>("SELECT release_year FROM public.albums WHERE id=$1", [fixture.albumId])).release_year).toBe(2002);
    const state = await one<{ conflict: string; a: string; b: string }>(`
      SELECT (SELECT status::text FROM ingest.conflicts WHERE claim_b_id=$2) AS conflict,
             (SELECT status::text FROM ingest.claims WHERE id=$1) AS a,
             (SELECT status::text FROM ingest.claims WHERE id=$2) AS b`, [fixture.claimA, fixture.claimB]);
    expect(state).toEqual({ conflict: "resolved_b", a: "superseded", b: "accepted" });
    const audit = await one<{ old_value: unknown; new_value: unknown; run_id: string }>(
      "SELECT old_value,new_value,run_id::text FROM ingest.merge_audit WHERE album_id=$1 AND field='release_year' ORDER BY id DESC LIMIT 1", [fixture.albumId]);
    expect(audit).toMatchObject({ old_value: 2001, new_value: 2002, run_id: String(resolved.json().runId) });
  });

  it("acepta y rechaza candidatos de identidad y claims candidatos de la cola", async () => {
    const person = async (identity: string, confidence: "high" | "medium") => {
      evidence += 1;
      const normalized = normalizeRecord({
        entityKind: "person", identity, extractor: "api-write-fixture", extractorVersion: "1",
        fields: [{ field: "name", value: identity, evidence: { url: `https://fixture.invalid/api-write/${evidence}` } }],
      })[0]!;
      const input: ClaimToPersist = { ...normalized, sourceId: sourceA, confidence };
      const persisted = await persistClaim(input);
      return { persisted, outcome: await mergeClaim(input, persisted) };
    };
    const reviewFor = async (claimId: number, kind: string) => Number((await one<{ id: string }>(
      "SELECT id FROM ingest.review_queue WHERE claim_a_id=$1 AND kind=$2::ingest.review_kind AND status='open' ORDER BY id DESC LIMIT 1", [claimId, kind])).id);

    const canonical = await person("José Pérez", "high");
    const variant = await person("Jose Perez", "medium");
    expect(variant.outcome.action).toBe("candidate");
    const accepted = await write("POST", `/review-queue/${await reviewFor(variant.persisted.id, "person_match")}/accept`, { note: "misma persona" });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ action: "accepted", status: "approved" });
    const attached = await one<{ person_id: string; status: string }>("SELECT person_id::text,status::text FROM ingest.claims WHERE id=$1", [variant.persisted.id]);
    expect(attached).toEqual({ person_id: String(canonical.outcome.personId), status: "accepted" });
    const decision = await one<{ verdict: string; decided_by: string; applied: boolean }>(
      "SELECT verdict,decided_by,applied_at IS NOT NULL AS applied FROM ingest.review_decisions WHERE review_id=$1", [accepted.json().reviewId]);
    expect(decision).toEqual({ verdict: "same", decided_by: OPERATOR, applied: true });

    await person("María Uno", "high");
    const other = await person("Maria Uno", "medium");
    const rejected = await write("POST", `/review-queue/${await reviewFor(other.persisted.id, "person_match")}/reject`, { note: "son dos personas" });
    expect(rejected.statusCode).toBe(200);
    expect(Number((await one<{ n: string }>("SELECT count(*) n FROM public.persons WHERE name IN ('María Uno','Maria Uno')")).n)).toBe(2);

    const lowClaim = async (identity: string) => {
      evidence += 1;
      const normalized = normalizeRecord({
        entityKind: "artist", identity, extractor: "api-write-fixture", extractorVersion: "1",
        fields: [{ field: "name", value: identity, evidence: { url: `https://fixture.invalid/api-write/${evidence}` } }],
      })[0]!;
      const input: ClaimToPersist = { ...normalized, sourceId: sourceB, confidence: "low" };
      const persisted = await persistClaim(input);
      await mergeClaim(input, persisted);
      return persisted.id;
    };
    const kings = await lowClaim("Los Kings");
    const dismissed = await write("POST", `/review-queue/${await reviewFor(kings, "low_confidence")}/reject`, { note: "sin señal venezolana" });
    expect(dismissed.json()).toMatchObject({ action: "rejected", status: "dismissed" });
    expect((await one<{ status: string }>("SELECT status::text FROM ingest.claims WHERE id=$1", [kings])).status).toBe("rejected");

    const queens = await lowClaim("Los Queens");
    const promoted = await write("POST", `/review-queue/${await reviewFor(queens, "low_confidence")}/accept`, { note: "banda de Maracaibo" });
    expect(promoted.statusCode).toBe(200);
    expect(Number((await one<{ n: string }>("SELECT count(*) n FROM public.artists WHERE name='Los Queens'")).n)).toBe(1);

    const missingNote = await write("POST", `/review-queue/${accepted.json().reviewId}/accept`, {});
    expect(missingNote.statusCode).toBe(400);
  });

  it("expone la escritura en OpenAPI con el esquema de seguridad del operador", async () => {
    const spec = (await app.inject({ method: "GET", url: "/docs/json" })).json();
    expect(spec.components.securitySchemes.collaboratorSession).toMatchObject({ type: "apiKey", in: "cookie", name: "crv_session" });
    expect(spec.components.securitySchemes.operatorToken).toMatchObject({ type: "http", scheme: "bearer" });
    expect(spec.paths["/artists"].post.security).toEqual([{ collaboratorSession: [] }, { operatorToken: [] }]);
    for (const path of ["/albums/{id}", "/tracks/{id}", "/album-credits/{id}", "/track-credits/{id}", "/artist-members/{id}", "/person-organizations/{id}", "/album-formats/{id}"]) {
      expect(spec.paths[path].patch).toBeDefined();
      expect(spec.paths[path].delete).toBeDefined();
    }
    expect(spec.paths["/review-queue/{id}/resolve-conflict"].post).toBeDefined();
    expect(spec.paths["/audit"].get).toBeDefined();
  });

  it("sin cuentas ni CRV_OPERATOR_TOKEN la API queda en solo lectura", async () => {
    const configuredAccounts = process.env["CRV_COLLABORATORS_JSON"];
    // También CRV_HERRA_DB_PATH: si la máquina donde corre el test tiene esa
    // variable en su .env real (login compartido con herra), "sin cuentas"
    // dejaría de ser cierto y el caso probaría otra cosa.
    const configuredHerra = process.env["CRV_HERRA_DB_PATH"];
    delete process.env["CRV_OPERATOR_TOKEN"];
    delete process.env["CRV_COLLABORATORS_JSON"];
    delete process.env["CRV_HERRA_DB_PATH"];
    resetEnvCache();
    const readOnly = await buildApp();
    try {
      const res = await readOnly.inject({ method: "POST", url: "/artists", payload: { name: "X" }, headers: { authorization: `Bearer ${TOKEN}` } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: { code: "writes_disabled" } });
    } finally {
      await readOnly.close();
      process.env["CRV_OPERATOR_TOKEN"] = TOKEN;
      if (configuredAccounts !== undefined) process.env["CRV_COLLABORATORS_JSON"] = configuredAccounts;
      if (configuredHerra !== undefined) process.env["CRV_HERRA_DB_PATH"] = configuredHerra;
      resetEnvCache();
    }
  });
});
