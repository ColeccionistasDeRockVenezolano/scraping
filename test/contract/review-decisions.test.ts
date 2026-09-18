import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { migrateUp } from "../../src/db/migrate.js";
import { closeDb, getDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { sources } from "../../src/db/schema/ingest.js";
import { normalizeRecord } from "../../src/normalization/claims.js";
import { persistClaim, type ClaimToPersist } from "../../src/claims/persistence.js";
import { mergeClaim } from "../../src/merge/engine.js";
import { applyReviewDecisions, planReviewDecisions } from "../../src/review/decisions.js";
import { buildServer } from "../../src/cotejo/server.js";

let evidence = 0;

async function claim(sourceId: number, identity: string, confidence: "high" | "medium") {
  evidence += 1;
  const normalized = normalizeRecord({
    entityKind: "person", identity, extractor: "mesa-fixture", extractorVersion: "1",
    fields: [{ field: "name", value: identity, evidence: { url: `https://fixture.invalid/mesa/${evidence}`, excerpt: identity } }],
  })[0]!;
  const input: ClaimToPersist = { ...normalized, sourceId, confidence };
  const persisted = await persistClaim(input);
  return { input, persisted, outcome: await mergeClaim(input, persisted) };
}

async function decide(reviewId: number, verdict: string, context: Record<string, unknown> = {}) {
  await getPool().query(
    "INSERT INTO ingest.review_decisions(review_id,verdict,decided_by,context) VALUES($1,$2,'Tester',$3::jsonb)",
    [reviewId, verdict, JSON.stringify(context)],
  );
}

describe("aplicación de decisiones de la Mesa de Cotejo", () => {
  let container: PgContainer;
  let sourceId: number;

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
    const [source] = await getDb().insert(sources).values({
      slug: "mesa-fixture", name: "Mesa fixture", siteType: "website", trustLevel: "high", enabled: true,
    }).returning();
    sourceId = source!.id;
  }, 120_000);

  afterAll(async () => { await closeDb(); await container?.stop(); }, 60_000);

  it("aplica same y different, pero deja unsure abierto y sin applied_at", async () => {
    const canonicalSame = await claim(sourceId, "José Pérez", "high");
    const sameCandidate = await claim(sourceId, "Jose Perez", "medium");
    expect(sameCandidate.outcome.action).toBe("candidate");
    const sameReview = await getPool().query<{ id: string }>(
      "SELECT id::text FROM ingest.review_queue WHERE claim_a_id=$1 AND kind='person_match' ORDER BY id DESC LIMIT 1",
      [sameCandidate.persisted.id],
    );
    await decide(Number(sameReview.rows[0]!.id), "same");

    await claim(sourceId, "María Uno", "high");
    const differentCandidate = await claim(sourceId, "Maria Uno", "medium");
    const differentReview = await getPool().query<{ id: string }>(
      "SELECT id::text FROM ingest.review_queue WHERE claim_a_id=$1 AND kind='person_match' ORDER BY id DESC LIMIT 1",
      [differentCandidate.persisted.id],
    );
    await decide(Number(differentReview.rows[0]!.id), "different");

    await claim(sourceId, "Ángel Dos", "high");
    const unsureCandidate = await claim(sourceId, "Angel Dos", "medium");
    const unsureReview = await getPool().query<{ id: string }>(
      "SELECT id::text FROM ingest.review_queue WHERE claim_a_id=$1 AND kind='person_match' ORDER BY id DESC LIMIT 1",
      [unsureCandidate.persisted.id],
    );
    await decide(Number(unsureReview.rows[0]!.id), "unsure");

    expect(await planReviewDecisions()).toMatchObject({ actionable: 2, unsure: 1, invalid: 0 });
    const result = await applyReviewDecisions("cotejo humano terminado");
    expect(result).toMatchObject({ appliedReviews: 2, failed: 0, unsure: 1 });

    const sameState = await getPool().query<{ status: string; person_id: string }>(
      "SELECT status::text,person_id::text FROM ingest.claims WHERE id=$1", [sameCandidate.persisted.id]);
    expect(sameState.rows[0]).toMatchObject({ status: "accepted", person_id: String(canonicalSame.outcome.personId) });
    expect(Number((await getPool().query("SELECT count(*) n FROM persons WHERE name IN ('María Uno','Maria Uno')")).rows[0].n)).toBe(2);

    const unsureState = await getPool().query<{ queue_status: string; applied_at: Date | null }>(`
      SELECT q.status::text AS queue_status,d.applied_at
        FROM ingest.review_queue q JOIN ingest.review_decisions d ON d.review_id=q.id
       WHERE q.id=$1`, [Number(unsureReview.rows[0]!.id)]);
    expect(unsureState.rows[0]).toMatchObject({ queue_status: "open", applied_at: null });

    // Un segundo participante puede adherirse después al mismo veredicto.
    // Su fila también debe quedar aplicada, sin repetir el efecto canónico.
    await getPool().query(
      "INSERT INTO ingest.review_decisions(review_id,verdict,decided_by,context) VALUES($1,'same','Auditora','{}')",
      [Number(sameReview.rows[0]!.id)],
    );
    expect(await planReviewDecisions()).toMatchObject({ actionable: 1, unsure: 1 });
    const consensus = await applyReviewDecisions("registrar adhesión posterior");
    expect(consensus).toMatchObject({ appliedReviews: 1, appliedDecisionRows: 1, failed: 0 });

    // Repetir no vuelve a aplicar nada ni duplica personas.
    const again = await applyReviewDecisions("reintento idempotente");
    expect(again.appliedReviews).toBe(0);
    expect(Number((await getPool().query("SELECT count(*) n FROM persons WHERE name IN ('María Uno','Maria Uno')")).rows[0].n)).toBe(2);
  });

  it("normaliza label a record_label y audita la elección proposed", async () => {
    const organization = await getPool().query<{ id: string }>("INSERT INTO organizations(name) VALUES('Sello Mesa') RETURNING id::text");
    const organizationId = Number(organization.rows[0]!.id);
    evidence += 1;
    const normalized = normalizeRecord({
      entityKind: "organization", identity: "Sello Mesa", extractor: "mesa-fixture", extractorVersion: "1",
      fields: [{ field: "organization_type", value: "label", evidence: { url: `https://fixture.invalid/mesa/${evidence}` } }],
    })[0]!;
    const persisted = await persistClaim({ ...normalized, sourceId, confidence: "medium", organizationId });
    const review = await getPool().query<{ id: string }>(`
      INSERT INTO ingest.review_queue(kind,claim_a_id,organization_a_id,payload)
      VALUES('field_conflict',$1,$2,$3::jsonb) RETURNING id::text`, [
      persisted.id, organizationId,
      JSON.stringify({ entityKind: "organization", targetId: organizationId, field: "organization_type", canonicalValue: "other", proposedValue: "label", reason: "canonical_value_has_no_rival_claim" }),
    ]);
    await decide(Number(review.rows[0]!.id), "proposed");

    const result = await applyReviewDecisions("elegir valor propuesto");
    expect(result.failed).toBe(0);
    expect((await getPool().query("SELECT organization_type::text value FROM organizations WHERE id=$1", [organizationId])).rows[0]?.value).toBe("record_label");
    expect(Number((await getPool().query("SELECT count(*) n FROM ingest.merge_audit WHERE organization_id=$1 AND field='organization_type'", [organizationId])).rows[0].n)).toBe(1);
  });

  it("aplica actual/propuesto por valor aunque claim A y B estén invertidos", async () => {
    const artist = await getPool().query<{ id: string }>("INSERT INTO artists(name) VALUES('Banda lados') RETURNING id::text");
    const artistId = Number(artist.rows[0]!.id);
    const currentUrl = "https://www.youtube.com/watch?v=gIDPqajS7J8";
    const proposedUrl = "https://www.youtube.com/watch?v=PK-3siFK53w";

    async function invertedConflict(title: string, verdict: "canonical" | "proposed") {
      const album = await getPool().query<{ id: string }>(
        "INSERT INTO albums(artist_id,title,youtube_url) VALUES($1,$2,$3) RETURNING id::text",
        [artistId, title, currentUrl],
      );
      const albumId = Number(album.rows[0]!.id);
      const normalized = normalizeRecord({
        entityKind: "album", identity: `Banda lados::${title}`, extractor: "mesa-fixture", extractorVersion: "lados",
        fields: [
          { field: "youtube_url", value: proposedUrl, evidence: { url: proposedUrl, excerpt: "video propuesto" } },
          { field: "youtube_url", value: currentUrl, evidence: { url: currentUrl, excerpt: "video actual" } },
        ],
      });
      // La propuesta se inserta primero: queda en A aunque semánticamente no
      // sea el valor actual. Este era el orden que invertía la Mesa.
      const proposed = await persistClaim({ ...normalized[0]!, sourceId, confidence: "medium", albumId });
      const canonical = await persistClaim({ ...normalized[1]!, sourceId, confidence: "high", albumId });
      await getPool().query("UPDATE ingest.claims SET status='conflict' WHERE id=ANY($1::bigint[])", [[proposed.id, canonical.id]]);
      const conflict = await getPool().query<{ id: string }>(`
        INSERT INTO ingest.conflicts(claim_a_id,claim_b_id,entity_kind,field,value_a,value_b)
        VALUES($1,$2,'album','youtube_url',$3::jsonb,$4::jsonb) RETURNING id::text`,
      [proposed.id, canonical.id, JSON.stringify(proposedUrl), JSON.stringify(currentUrl)]);
      const conflictId = Number(conflict.rows[0]!.id);
      const review = await getPool().query<{ id: string }>(`
        INSERT INTO ingest.review_queue(kind,claim_a_id,claim_b_id,conflict_id,payload)
        VALUES('field_conflict',$1,$2,$3,$4::jsonb) RETURNING id::text`, [
        proposed.id, canonical.id, conflictId,
        JSON.stringify({ entityKind: "album", targetId: albumId, field: "youtube_url", valueA: proposedUrl, valueB: currentUrl }),
      ]);
      const reviewId = Number(review.rows[0]!.id);
      await decide(reviewId, verdict, {
        selectedValue: verdict === "canonical" ? currentUrl : proposedUrl,
        canonicalValue: currentUrl, proposedValue: proposedUrl,
      });
      return { albumId, conflictId };
    }

    const keep = await invertedConflict("Conservar lado", "canonical");
    const change = await invertedConflict("Adoptar lado", "proposed");
    const result = await applyReviewDecisions("respetar los roles visibles de la Mesa");
    expect(result.failed).toBe(0);
    const albums = await getPool().query<{ id: string; youtube_url: string }>(
      "SELECT id::text,youtube_url FROM albums WHERE id=ANY($1::bigint[]) ORDER BY id", [[keep.albumId, change.albumId]],
    );
    expect(albums.rows).toEqual([
      { id: String(keep.albumId), youtube_url: currentUrl },
      { id: String(change.albumId), youtube_url: proposedUrl },
    ]);
    const conflicts = await getPool().query<{ id: string; status: string }>(
      "SELECT id::text,status::text FROM ingest.conflicts WHERE id=ANY($1::bigint[]) ORDER BY id", [[keep.conflictId, change.conflictId]],
    );
    expect(conflicts.rows.map((row) => row.status)).toEqual(["resolved_b", "resolved_a"]);
  });

  it("recupera artist_name hermano al aplicar different sobre un album historico", async () => {
    await getPool().query("INSERT INTO artists(name) VALUES('Los Kings')");
    const normalized = normalizeRecord({
      entityKind: "album", identity: "El Super Grupo", extractor: "mesa-fixture", extractorVersion: "historico",
      fields: [
        { field: "title", value: "El Super Grupo", evidence: { url: "https://fixture.invalid/el-super-grupo" } },
        { field: "artist_name", value: "Los Kings", evidence: { url: "https://fixture.invalid/el-super-grupo" } },
        { field: "release_year", value: 1975, evidence: { url: "https://fixture.invalid/el-super-grupo" } },
      ],
    });
    const reviewIds: number[] = [];
    for (const input of normalized) {
      const persisted = await persistClaim({ ...input, sourceId, confidence: "medium" });
      expect((await mergeClaim({ ...input, sourceId, confidence: "medium" }, persisted)).action).toBe("candidate");
      const review = await getPool().query<{ id: string }>(
        "SELECT id::text FROM ingest.review_queue WHERE claim_a_id=$1 AND kind='album_match' ORDER BY id DESC LIMIT 1",
        [persisted.id],
      );
      reviewIds.push(Number(review.rows[0]!.id));
    }
    await decide(reviewIds[0]!, "different");
    await decide(reviewIds[1]!, "different");
    await decide(reviewIds[2]!, "unsure");

    const exclusionPass = await applyReviewDecisions("exclusiones mientras queda una duda");
    expect(exclusionPass).toMatchObject({ appliedReviews: 2, unsure: 2 });
    expect(Number((await getPool().query("SELECT count(*) n FROM albums WHERE title='El Super Grupo'")).rows[0].n)).toBe(0);
    await getPool().query(
      "UPDATE ingest.review_decisions SET status='withdrawn',withdrawn_at=now() WHERE review_id=$1 AND status='active'",
      [reviewIds[2]],
    );
    await decide(reviewIds[2]!, "different");

    const result = await applyReviewDecisions("album historico distinto");
    expect(result.failed).toBe(0);
    expect(result.appliedReviews).toBe(3);
    const album = await getPool().query<{ title: string; release_year: number; artist: string }>(`
      SELECT a.title,a.release_year,ar.name AS artist
        FROM albums a JOIN artists ar ON ar.id=a.artist_id
       WHERE a.title='El Super Grupo'`);
    expect(album.rows).toEqual([{ title: "El Super Grupo", release_year: 1975, artist: "Los Kings" }]);
  });

  it("dos fuentes con la misma identidad y different crean un solo álbum", async () => {
    await getPool().query("INSERT INTO artists(name) VALUES('Jacktürbo Fixture')");
    const [second] = await getDb().insert(sources).values({
      slug: "mesa-fixture-api", name: "Mesa fixture API", siteType: "website", trustLevel: "high", enabled: true,
    }).returning();
    const reviewIds: number[] = [];
    for (const [index, source] of [sourceId, second!.id].entries()) {
      const url = `https://fixture.invalid/jackturbo-ii/${index}`;
      const normalized = normalizeRecord({
        entityKind: "album", identity: "Jacktürbo Fixture::Jackturbo II", extractor: "mesa-fixture", extractorVersion: `fuente-${index}`,
        fields: [
          { field: "title", value: "Jackturbo II", evidence: { url } },
          { field: "artist_name", value: "Jacktürbo Fixture", evidence: { url } },
        ],
      });
      for (const input of normalized) {
        const persisted = await persistClaim({ ...input, sourceId: source, confidence: "medium" });
        await mergeClaim({ ...input, sourceId: source, confidence: "medium" }, persisted);
        const review = await getPool().query<{ id: string }>(
          "SELECT id::text FROM ingest.review_queue WHERE claim_a_id=$1 AND kind='album_match' ORDER BY id DESC LIMIT 1",
          [persisted.id],
        );
        reviewIds.push(Number(review.rows[0]!.id));
      }
    }
    for (const reviewId of reviewIds) await decide(reviewId, "different");

    const result = await applyReviewDecisions("la hoja y la API describen el mismo disco");
    expect(result.failed).toBe(0);
    const albums = await getPool().query<{ id: string }>("SELECT id::text FROM albums WHERE title='Jackturbo II'");
    expect(albums.rows).toHaveLength(1);
    const attached = await getPool().query<{ album_id: string }>(
      "SELECT DISTINCT album_id::text FROM ingest.claims WHERE identity_key=(SELECT identity_key FROM ingest.claims WHERE id=(SELECT claim_a_id FROM ingest.review_queue WHERE id=$1))",
      [reviewIds[0]],
    );
    expect(attached.rows).toEqual([{ album_id: albums.rows[0]!.id }]);
  });

  it("bloquea same y different contra el mismo candidato para una identidad", async () => {
    await claim(sourceId, "Víctor Tres", "high");
    const candidate = await claim(sourceId, "Victor Tres", "medium");
    const original = await getPool().query<{ id: string; payload: unknown }>(
      "SELECT id::text,payload FROM ingest.review_queue WHERE claim_a_id=$1 AND kind='person_match' ORDER BY id DESC LIMIT 1",
      [candidate.persisted.id],
    );
    const duplicate = await getPool().query<{ id: string }>(`
      INSERT INTO ingest.review_queue(kind,claim_a_id,priority,payload,notes)
      VALUES('person_match',$1,7,$2::jsonb,'careo duplicado') RETURNING id::text`,
    [candidate.persisted.id, JSON.stringify(original.rows[0]!.payload)]);
    await decide(Number(original.rows[0]!.id), "same");
    await decide(Number(duplicate.rows[0]!.id), "different");

    expect(await planReviewDecisions()).toMatchObject({ actionable: 0, invalid: 2 });
    const result = await applyReviewDecisions("no adivinar contradicciones humanas");
    expect(result).toMatchObject({ appliedReviews: 0, failed: 2, invalid: 2 });
    const states = await getPool().query("SELECT status::text FROM ingest.review_queue WHERE id=ANY($1::bigint[]) ORDER BY id", [[Number(original.rows[0]!.id), Number(duplicate.rows[0]!.id)]]);
    expect(states.rows.map((row) => row.status)).toEqual(["open", "open"]);
  });

  it("guarda veredictos mixtos de una elección agrupada en una sola petición", async () => {
    await claim(sourceId, "Tomás Cuatro", "high");
    const sameCandidate = await claim(sourceId, "Tomas Cuatro", "medium");
    await claim(sourceId, "Luisa Cinco", "high");
    const differentCandidate = await claim(sourceId, "Luísa Cinco", "medium");
    const reviews = await getPool().query<{ id: string; claim_a_id: string }>(`
      SELECT id::text,claim_a_id::text FROM ingest.review_queue
       WHERE claim_a_id=ANY($1::bigint[]) AND kind='person_match' AND status='open'
       ORDER BY id`, [[sameCandidate.persisted.id, differentCandidate.persisted.id]]);
    const sameReview = reviews.rows.find((row) => Number(row.claim_a_id) === sameCandidate.persisted.id);
    const differentReview = reviews.rows.find((row) => Number(row.claim_a_id) === differentCandidate.persisted.id);
    expect(sameReview).toBeDefined();
    expect(differentReview).toBeDefined();

    const app = buildServer();
    try {
      const response = await app.inject({
        method: "POST", url: "/api/decisions",
        payload: {
          decidedBy: "Cotejadora",
          choices: [
            { reviewIds: [sameReview!.id], verdict: "same" },
            { reviewIds: [differentReview!.id], verdict: "different" },
          ],
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ saved: 2, decidedBy: "Cotejadora" });
      const stored = await getPool().query<{ review_id: string; verdict: string }>(`
        SELECT review_id::text,verdict FROM ingest.review_decisions
         WHERE review_id=ANY($1::bigint[]) AND decided_by='Cotejadora' AND status='active'
         ORDER BY review_id`, [[sameReview!.id, differentReview!.id]]);
      expect(stored.rows.map((row) => row.verdict).sort()).toEqual(["different", "same"]);
    } finally {
      await app.close();
    }
  });
});
