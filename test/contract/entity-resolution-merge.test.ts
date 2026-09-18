import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { migrateUp } from "../../src/db/migrate.js";
import { closeDb, getDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { normalizeRecord } from "../../src/normalization/claims.js";
import { keepRepeatedTrackOccurrences, mergeClaim, resolveFieldConflict } from "../../src/merge/engine.js";
import { persistClaim, type ClaimToPersist, type Confidence } from "../../src/claims/persistence.js";
import type { ResolutionInput } from "../../src/er/types.js";
import { DeepSeekGateway, MockDeepSeekTransport, PostgresDeepSeekRunStore, type DeepSeekGatewayConfig } from "../../src/ai/gateway.js";
import { approveBiographyDraft, generateBiographyDraft } from "../../src/ai/biographies.js";
import { aiBiographies, aiBiographyClaims, claims, conflicts, entityResolutionDecisions, mergeAudit, reviewQueue, sources } from "../../src/db/schema/ingest.js";
import { albums, artists, organizations, persons, tracks } from "../../src/db/schema/core.js";

let evidenceCounter = 0;

async function applyClaim(options: {
  sourceId: number;
  kind: ClaimToPersist["entityKind"];
  identity: string;
  field: string;
  value: unknown;
  confidence?: Confidence;
  targets?: Partial<ClaimToPersist>;
  resolutionInput?: ResolutionInput;
  evidenceUrl?: string;
  evidencePosition?: number;
  gateway?: DeepSeekGateway;
}) {
  evidenceCounter += 1;
  const normalized = normalizeRecord({
    entityKind: options.kind, identity: options.identity, extractor: "er-contract", extractorVersion: "1",
    fields: [{ field: options.field, value: options.value, evidence: {
      url: options.evidenceUrl ?? `https://fixture.invalid/er/${evidenceCounter}`,
      excerpt: String(options.value),
      ...(options.evidencePosition === undefined ? {} : { position: options.evidencePosition }),
    } }],
  })[0]!;
  const input: ClaimToPersist = {
    ...normalized, sourceId: options.sourceId, confidence: options.confidence ?? "high",
    ...(options.targets ?? {}),
    ...(options.resolutionInput === undefined ? {} : { resolutionInput: options.resolutionInput }),
  };
  const persisted = await persistClaim(input);
  return { persisted, outcome: await mergeClaim(input, persisted, options.gateway === undefined ? {} : { gateway: options.gateway }) };
}

const mockGatewayConfig: DeepSeekGatewayConfig = {
  baseUrl: "https://mock.invalid",
  models: { fast: "flash-configurable", reasoning: "pro-configurable", vision: "vision-configurable" },
  maxTokens: 1_000,
  timeoutMs: 5_000,
};

describe("ER + claims + conflictos + merge auditado", () => {
  let container: PgContainer;
  let sourceId: number;
  let artistId: number;
  let personId: number;
  let albumId: number;

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl; resetEnvCache();
    await applyCore(container.name); await migrateUp();
    const [source] = await getDb().insert(sources).values({ slug: "er-suite", name: "ER fixture", siteType: "website", trustLevel: "high", enabled: true }).returning();
    sourceId = source!.id;
  }, 120_000);

  afterAll(async () => { await closeDb(); await container?.stop(); }, 60_000);

  it("crea canonical+alias, reconoce variantes previsibles y no fusiona Pacifica/Pacífica", async () => {
    const created = await applyClaim({ sourceId, kind: "artist", identity: "  Caramelos de Cianuro  ", field: "name", value: "Caramelos de Cianuro" });
    expect(created.outcome.action).toBe("applied"); artistId = created.outcome.artistId!;
    const variant = await applyClaim({ sourceId, kind: "artist", identity: "CARAMelos-de-Cianuro", field: "name", value: "CARAMelos-de-Cianuro" });
    expect(variant.outcome.action).toBe("unchanged");
    expect(variant.outcome.artistId).toBe(artistId);
    expect(await getPool().query("SELECT 1 FROM ingest.artist_aliases WHERE artist_id=$1 AND alias=$2", [artistId, "CARAMelos-de-Cianuro"]).then((result) => result.rowCount)).toBe(1);

    const accented = await applyClaim({ sourceId, kind: "artist", identity: "Pacífica", field: "name", value: "Pacífica" });
    expect(accented.outcome.action).toBe("applied");
    const arbiterTransport = new MockDeepSeekTransport({
      same_entity_probability: 0.51,
      recommended_action: "REVIEW",
      evidence_for: ["solo coincide la forma sin tilde"],
      evidence_against: ["no hay contexto historico compartido"],
      uncertainties: ["pueden ser artistas distintos"],
    });
    const arbiter = new DeepSeekGateway(mockGatewayConfig, arbiterTransport, new PostgresDeepSeekRunStore());
    const tildeOnly = await applyClaim({ sourceId, kind: "artist", identity: "Pacifica", field: "name", value: "Pacifica", gateway: arbiter });
    expect(tildeOnly.outcome.action).toBe("candidate");
    expect(arbiterTransport.requests).toHaveLength(1);
    expect(arbiterTransport.requests[0]).toMatchObject({ model: "pro-configurable", modelClass: "reasoning" });
    expect(await getDb().select().from(artists).where(eq(artists.name, "Pacifica"))).toHaveLength(0);
    expect((await getDb().select().from(entityResolutionDecisions).where(eq(entityResolutionDecisions.claimId, tildeOnly.persisted.id)))[0]).toMatchObject({ action: "REVIEW", decidedBy: "deepseek" });
    expect((await getDb().select().from(reviewQueue).where(eq(reviewQueue.claimAId, tildeOnly.persisted.id)))[0]).toMatchObject({ kind: "ai_entity_resolution", status: "open" });
  });

  it("resuelve y crea PERSON, ALBUM, TRACK y ORGANIZATION con sus claves propias", async () => {
    const retryUrl = "https://fixture.invalid/er/person-asier";
    const person = await applyClaim({ sourceId, kind: "person", identity: "Asier Cazalis", field: "name", value: "Asier Cazalis", evidenceUrl: retryUrl });
    personId = person.outcome.personId!; expect(person.outcome.action).toBe("applied");
    const personAgain = await applyClaim({ sourceId, kind: "person", identity: "Asier Cazalis", field: "name", value: "Asier Cazalis", evidenceUrl: retryUrl });
    expect(personAgain.persisted.inserted).toBe(false);
    expect(await getDb().select().from(persons).where(eq(persons.name, "Asier Cazalis"))).toHaveLength(1);

    const albumInput: ResolutionInput = { kind: "ALBUM", name: "Las Paticas De La Abuela", artist: { id: artistId, name: "Caramelos de Cianuro" }, year: 1992, releaseType: "ep" };
    const album = await applyClaim({ sourceId, kind: "album", identity: "Caramelos de Cianuro::Las Paticas De La Abuela", field: "title", value: "Las Paticas De La Abuela", resolutionInput: albumInput, targets: { parentArtistId: artistId } });
    albumId = album.outcome.albumId!; expect(album.outcome.action).toBe("applied");

    const trackInput: ResolutionInput = { kind: "TRACK", name: "El Martillo", album: { id: albumId, name: "Las Paticas De La Abuela" }, disc: 1, trackNumber: 1 };
    const track = await applyClaim({ sourceId, kind: "track", identity: "Caramelos de Cianuro::Las Paticas De La Abuela::1", field: "title", value: "El Martillo", resolutionInput: trackInput, targets: { parentAlbumId: albumId, discNumber: 1, trackNumber: 1 } });
    expect(track.outcome.action).toBe("applied");
    expect((await getDb().select().from(tracks).where(eq(tracks.albumId, albumId)))[0]).toMatchObject({ title: "El Martillo", discNumber: 1, trackNumber: 1 });

    const organization = await applyClaim({ sourceId, kind: "organization", identity: "Sonográfica", field: "name", value: "Sonográfica" });
    expect(organization.outcome.action).toBe("applied");
    expect(await getDb().select().from(organizations).where(eq(organizations.name, "Sonográfica"))).toHaveLength(1);
    expect((await getDb().select().from(albums).where(eq(albums.id, albumId)))[0]?.title).toBe("Las Paticas De La Abuela");
  });

  it("conserva dos ocurrencias reales con el mismo título y retira el unsure sustituido", async () => {
    const existing = await getPool().query<{ id: string }>(
      "SELECT id::text FROM tracks WHERE album_id=$1 AND disc_number=1 AND track_number=1",
      [albumId],
    );
    const trackId = Number(existing.rows[0]!.id);
    const repeatedUrl = "https://fixture.invalid/er/repeated-track";
    const identity = "Caramelos de Cianuro::Las Paticas De La Abuela::El Martillo";
    const originalNumber = await applyClaim({
      sourceId, kind: "track", identity, field: "track_number", value: 1,
      targets: { trackId }, evidenceUrl: "https://fixture.invalid/er/original-track", evidencePosition: 1,
    });
    await getPool().query(`
      WITH inserted AS (
        INSERT INTO ingest.merge_audit(entity_kind,track_id,field,old_value,new_value,reason,confidence,performed_by)
        VALUES('track',$1,'track_number',NULL,'1'::jsonb,'afirmación inicial de la fuente','high','system')
        RETURNING id
      ) INSERT INTO ingest.merge_audit_claims(merge_audit_id,claim_id)
        SELECT id,$2 FROM inserted`, [trackId, originalNumber.persisted.id]);
    const title = await applyClaim({
      sourceId, kind: "track", identity, field: "title", value: "El Martillo",
      targets: { trackId }, evidenceUrl: repeatedUrl, evidencePosition: 6,
    });
    const number = await applyClaim({
      sourceId, kind: "track", identity, field: "track_number", value: 6,
      targets: { trackId }, evidenceUrl: repeatedUrl, evidencePosition: 6,
    });
    expect(number.outcome.action).toBe("conflict");
    const conflict = await getPool().query<{ id: string }>(
      "SELECT id::text FROM ingest.conflicts WHERE claim_b_id=$1 AND field='track_number'",
      [number.persisted.id],
    );
    const conflictId = Number(conflict.rows[0]!.id);
    const review = await getPool().query<{ id: string }>(
      "SELECT id::text FROM ingest.review_queue WHERE conflict_id=$1",
      [conflictId],
    );
    await getPool().query(
      "INSERT INTO ingest.review_decisions(review_id,verdict,decided_by,context) VALUES($1,'unsure','Tester','{}')",
      [Number(review.rows[0]!.id)],
    );

    const [resolved] = await keepRepeatedTrackOccurrences([conflictId], {
      actor: "human", note: "el tracklist enumera el título también en la posición 6",
    });
    expect(resolved).toMatchObject({ conflictId, originalTrackId: trackId, repeatedPosition: 6, claimsMoved: 2 });
    expect(await getPool().query(
      "SELECT track_number,title FROM tracks WHERE album_id=$1 AND title='El Martillo' ORDER BY track_number",
      [albumId],
    ).then((result) => result.rows)).toEqual([
      { track_number: 1, title: "El Martillo" },
      { track_number: 6, title: "El Martillo" },
    ]);
    expect(await getPool().query(
      "SELECT DISTINCT track_id::text FROM ingest.claims WHERE id=ANY($1::bigint[])",
      [[title.persisted.id, number.persisted.id]],
    ).then((result) => result.rows)).toEqual([{ track_id: String(resolved!.repeatedTrackId) }]);
    expect(await getPool().query(
      "SELECT c.status::text conflict_status,d.status::text decision_status FROM ingest.conflicts c JOIN ingest.review_queue q ON q.conflict_id=c.id JOIN ingest.review_decisions d ON d.review_id=q.id WHERE c.id=$1",
      [conflictId],
    ).then((result) => result.rows[0])).toMatchObject({ conflict_status: "both_kept", decision_status: "withdrawn" });
  });

  it("medium completa null, pero cualquier contradiccion conserva claims rivales y abre review", async () => {
    const caracas = await applyClaim({ sourceId, kind: "artist", identity: "Caramelos de Cianuro", field: "origin_city", value: "Caracas", targets: { artistId } });
    expect(caracas.outcome.action).toBe("applied");
    const valencia = await applyClaim({ sourceId, kind: "artist", identity: "Caramelos de Cianuro", field: "origin_city", value: "Valencia", confidence: "medium", targets: { artistId } });
    expect(valencia.outcome.action).toBe("conflict");
    expect((await getDb().select().from(artists).where(eq(artists.id, artistId)))[0]?.originCity).toBe("Caracas");
    const open = await getDb().select().from(conflicts).where(eq(conflicts.field, "origin_city"));
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ valueA: "Caracas", valueB: "Valencia", status: "open" });
    expect(await getDb().select().from(reviewQueue).where(eq(reviewQueue.conflictId, open[0]!.id))).toHaveLength(1);
    const rivalStatuses = await getPool().query("SELECT status FROM ingest.claims WHERE id=ANY($1::bigint[]) ORDER BY id", [[caracas.persisted.id, valencia.persisted.id]]);
    expect(rivalStatuses.rows.map((row) => row.status)).toEqual(["conflict", "conflict"]);
  });

  it("ni high sobrescribe silenciosamente y la resolucion humana elegida queda auditada", async () => {
    const first = await applyClaim({ sourceId, kind: "person", identity: "Asier Cazalis", field: "nationality", value: "Venezuela", targets: { personId } });
    expect(first.outcome.action).toBe("applied");
    const contradiction = await applyClaim({ sourceId, kind: "person", identity: "Asier Cazalis", field: "nationality", value: "España", confidence: "high", targets: { personId } });
    expect(contradiction.outcome.action).toBe("conflict");
    expect((await getDb().select().from(persons).where(eq(persons.id, personId)))[0]?.nationality).toBe("Venezuela");
    const [conflict] = await getDb().select().from(conflicts).where(eq(conflicts.field, "nationality"));
    const auditsBefore = (await getDb().select().from(mergeAudit)).length;
    await resolveFieldConflict(conflict!.id, "resolved_b", { actor: "human", note: "Documento primario revisado" });
    expect((await getDb().select().from(persons).where(eq(persons.id, personId)))[0]?.nationality).toBe("España");
    expect((await getDb().select().from(conflicts).where(eq(conflicts.id, conflict!.id)))[0]?.status).toBe("resolved_b");
    expect((await getDb().select().from(mergeAudit)).length).toBe(auditsBefore + 1);
  });

  it("low nunca toca canonical y un album_credit nunca crea membership", async () => {
    const low = await applyClaim({ sourceId, kind: "artist", identity: "Artista dudoso", field: "name", value: "Artista dudoso", confidence: "low" });
    expect(low.outcome.action).toBe("candidate");
    expect(await getDb().select().from(artists).where(eq(artists.name, "Artista dudoso"))).toHaveLength(0);
    // Un crédito incompleto y sin extremos en el core no escribe nada: el
    // puente lo deja candidato. Lo que nunca ocurre, con o sin puente, es que
    // un crédito de disco se convierta en una membresía de banda.
    const credit = await applyClaim({ sourceId, kind: "album_credit", identity: "x::credit", field: "credited_name", value: "Invitado" });
    expect(credit.outcome.action).toBe("candidate");
    expect(credit.outcome.relationKind).toBe("album_credit");
    expect(Number((await getPool().query("SELECT count(*) AS n FROM public.artist_members")).rows[0].n)).toBe(0);
    expect(Number((await getPool().query("SELECT count(*) AS n FROM public.album_credits")).rows[0].n)).toBe(0);
  });

  it("genera biografia separada solo con claims aceptados y trazabilidad; nunca cambia el hecho core", async () => {
    const accepted = await getDb().select({ id: claims.id }).from(claims).where(eq(claims.artistId, artistId));
    const acceptedRows = await getPool().query<{ id: string }>("SELECT id FROM ingest.claims WHERE artist_id=$1 AND status='accepted' ORDER BY id", [artistId]);
    const claimIds = acceptedRows.rows.map((row) => Number(row.id));
    expect(accepted.length).toBeGreaterThanOrEqual(claimIds.length);
    expect(claimIds.length).toBeGreaterThan(0);
    const transport = new MockDeepSeekTransport({ paragraphs: [{ text: "Caramelos de Cianuro forma parte del archivo del rock venezolano.", claim_ids: [claimIds[0]!] }], uncertainties: [] });
    const gateway = new DeepSeekGateway(mockGatewayConfig, transport, new PostgresDeepSeekRunStore());
    const beforeBiography = (await getDb().select().from(artists).where(eq(artists.id, artistId)))[0]?.biography;
    const draft = await generateBiographyDraft({ kind: "ARTIST", id: artistId }, gateway);
    expect(draft.claimIds).toEqual([claimIds[0]]);
    expect(await getDb().select().from(aiBiographies).where(eq(aiBiographies.id, draft.id))).toHaveLength(1);
    expect(await getDb().select().from(aiBiographyClaims).where(eq(aiBiographyClaims.biographyId, draft.id))).toHaveLength(1);
    expect((await getDb().select().from(reviewQueue).where(eq(reviewQueue.id, draft.reviewId)))[0]?.kind).toBe("ai_biography");
    await approveBiographyDraft(draft.id, "Texto editorial aprobado");
    expect((await getDb().select().from(artists).where(eq(artists.id, artistId)))[0]?.biography).toBe(beforeBiography);
  });

  it("el DEFAULT del DDL no es una afirmacion, asi que la primera fuente lo completa", async () => {
    // `artists.artist_type` es NOT NULL DEFAULT 'band'. Ese valor no lo dijo
    // ninguna fuente: lo puso el DDL, y `createEntity` solo escribe la
    // columna de identidad. Tratarlo como contradiccion archivaba en
    // conflicto TODO claim de tipo, de todas las fuentes.
    const before = (await getDb().select().from(artists).where(eq(artists.id, artistId)))[0];
    expect(before?.artistType).toBe("band");
    const first = await applyClaim({ sourceId, kind: "artist", identity: "Caramelos de Cianuro", field: "artist_type", value: "solo_artist", targets: { artistId } });
    expect(first.outcome.action).toBe("applied");
    expect((await getDb().select().from(artists).where(eq(artists.id, artistId)))[0]?.artistType).toBe("solo_artist");
    // El rastro dice lo que HABIA, no lo que se supone que habia.
    const trail = await getPool().query<{ old_value: unknown; new_value: unknown }>(
      "SELECT old_value, new_value FROM ingest.merge_audit WHERE artist_id=$1 AND field='artist_type' ORDER BY id DESC LIMIT 1", [artistId]);
    expect(trail.rows[0]).toMatchObject({ old_value: "band", new_value: "solo_artist" });

    // Y una vez afirmado, la siguiente discrepancia SI es contradiccion.
    const second = await applyClaim({ sourceId, kind: "artist", identity: "Caramelos de Cianuro", field: "artist_type", value: "duo", targets: { artistId } });
    expect(second.outcome.action).toBe("conflict");
    expect((await getDb().select().from(artists).where(eq(artists.id, artistId)))[0]?.artistType).toBe("solo_artist");
    expect(await getDb().select().from(conflicts).where(eq(conflicts.field, "artist_type"))).toHaveLength(1);
  });

  it("todo write automatico al core tiene merge_audit y toda resolucion tiene features", async () => {
    const writes = await getDb().select().from(mergeAudit);
    expect(writes.length).toBeGreaterThan(0);
    const missingClaims = await getPool().query("SELECT ma.id FROM ingest.merge_audit ma LEFT JOIN ingest.merge_audit_claims mac ON mac.merge_audit_id=ma.id WHERE mac.claim_id IS NULL");
    expect(missingClaims.rowCount).toBe(0);
    const decisions = await getDb().select().from(entityResolutionDecisions);
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.every((decision) => Array.isArray(decision.features) && decision.features.length > 0)).toBe(true);
  });
});
