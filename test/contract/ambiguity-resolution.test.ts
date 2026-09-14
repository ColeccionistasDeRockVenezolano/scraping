import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { reconcileYouTubeChannel } from "../../src/youtube/reconcile.js";
import { scanAmbiguities } from "../../src/ambiguity/scan.js";
import { resolveAmbiguities } from "../../src/ambiguity/resolve.js";
import { applyAmbiguityResolutions } from "../../src/ambiguity/apply.js";
import { FileArbiter } from "../../src/ambiguity/arbiter.js";

// Etapa 10 sobre una base desechable, con casos reducidos de la base de
// desarrollo: Cinema 0 / Cinema Cero (el mismo disco), Decade of Perversion
// (el mismo disco con dos años), Acústico En Bits Session / Bitsessions
// (ambigüedad semántica), la grafía de «Chema» Arria, un par de nombres
// parecidos sin banda común y el videoclip de Miel que dejó yt:reconcile.
describe("E10 · resolución de ambigüedades contra PostgreSQL", () => {
  let container: PgContainer;
  let reportDir: string;
  const ids: Record<string, number> = {};
  const core = async () => (await getPool().query<Record<string, number>>(`
    SELECT (SELECT count(*)::int FROM public.albums) AS albums, (SELECT count(*)::int FROM public.tracks) AS tracks,
           (SELECT count(*)::int FROM public.persons) AS persons, (SELECT count(*)::int FROM public.album_credits) AS album_credits,
           (SELECT count(*)::int FROM media.video_tracks) AS video_tracks, (SELECT count(*)::int FROM media.video_albums) AS video_albums,
           (SELECT count(*)::int FROM ingest.merge_audit) AS audits`)).rows[0]!;
  const reviewFor = async (pairKey: string) => Number((await getPool().query<{ id: string }>("SELECT id::text FROM ingest.review_queue WHERE payload->>'pairKey'=$1", [pairKey])).rows[0]!.id);

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
    reportDir = await mkdtemp(path.join(os.tmpdir(), "crv-ambiguity-"));
    const pool = getPool();
    const insert = async (sql: string, params: unknown[] = []): Promise<number> => Number((await pool.query<{ id: string }>(`${sql} RETURNING id::text`, params)).rows[0]!.id);
    const tracks = (album: number, titles: string[]) => pool.query(
      "INSERT INTO public.tracks(album_id, track_number, title) SELECT $1, n, t FROM unnest($2::text[]) WITH ORDINALITY AS x(t, n)", [album, titles]);
    await pool.query(`
      INSERT INTO ingest.sources(slug, name, site_type, trust_level)
      VALUES ('yt-master-seed','YT Master Spreadsheet','spreadsheet','high'), ('youtube-data-api','YouTube Data API v3','youtube_api','api')
      ON CONFLICT (slug) DO NOTHING`);

    const luz = await insert("INSERT INTO public.artists(name) VALUES ('Luz Verde')");
    ids["cinema0"] = await insert("INSERT INTO public.albums(artist_id,title,release_year,album_type) VALUES ($1,'Cinema 0',2000,'studio_album')", [luz]);
    ids["cinemaCero"] = await insert("INSERT INTO public.albums(artist_id,title,release_year,album_type) VALUES ($1,'Cinema Cero',2000,'other')", [luz]);
    await tracks(ids["cinema0"], ["Mal De Amores", "Cinema", "Todo Está Bien (Radio Cut)"]);
    await tracks(ids["cinemaCero"], ["Mal De Amores", "Cinema", "Todo Está Bien (Radio version)"]);

    const krueger = await insert("INSERT INTO public.artists(name) VALUES ('Krueger')");
    ids["decade2003"] = await insert("INSERT INTO public.albums(artist_id,title,release_year,album_type) VALUES ($1,'Decade of Perversion',2003,'other')", [krueger]);
    ids["decade2002"] = await insert("INSERT INTO public.albums(artist_id,title,release_year,album_type) VALUES ($1,'A Decade of Perversion',2002,'other')", [krueger]);
    await tracks(ids["decade2003"], ["Perversion", "Decade", "Nightmare"]);
    await tracks(ids["decade2002"], ["Perversion", "Decade", "Nightmare"]);

    const candy = await insert("INSERT INTO public.artists(name) VALUES ('Candy66')");
    ids["bits"] = await insert("INSERT INTO public.albums(artist_id,title,release_year,album_type) VALUES ($1,'Acústico En Bits Session',2010,'other')", [candy]);
    ids["bitsessions"] = await insert("INSERT INTO public.albums(artist_id,title,release_year,album_type) VALUES ($1,'Bitsessions',2010,'other')", [candy]);
    await tracks(ids["bits"], ["Bifásico", "Yankee", "Somos Otros"]);
    await tracks(ids["bitsessions"], ["Bifásico", "Yankee", "Somos Otros"]);

    const claroscuro = await insert("INSERT INTO public.artists(name) VALUES ('Claroscuro')");
    ids["supereterodino"] = await insert("INSERT INTO public.albums(artist_id,title,release_year,album_type) VALUES ($1,'Supereterodino',2001,'studio_album')", [claroscuro]);
    ids["corpbanca"] = await insert("INSERT INTO public.albums(artist_id,title,release_year,album_type) VALUES ($1,'En Vivo CorpBanca',2001,'live_album')", [claroscuro]);
    await tracks(ids["supereterodino"], ["Intro Eterodino", "Miel"]);
    await tracks(ids["corpbanca"], ["Miel"]);

    ids["chema1"] = await insert(`INSERT INTO public.persons(name) VALUES ('José Manuel "Chema" Arria')`);
    ids["chema2"] = await insert(`INSERT INTO public.persons(name) VALUES ('José Manuel Arria "Chema"')`);
    const silvio = await insert("INSERT INTO public.persons(name) VALUES ('Silvio Rodríguez')");
    const sRodriguez = await insert("INSERT INTO public.persons(name) VALUES ('S. Rodríguez')");
    const estacio = await insert("INSERT INTO public.persons(name) VALUES ('Pablo Estacio')");
    const cayayo = await insert("INSERT INTO public.persons(name) VALUES ('Cayayo Troconis')");
    await pool.query(`
      INSERT INTO public.album_credits(album_id, person_id, credit_type, role)
      VALUES ($1,$2,'musician','Drums'), ($1,$3,'musician','Drums'), ($4,$5,'composer','Composer'), ($6,$7,'writer','Lyrics'),
             ($8,$9,'mixing','Mixed by'), ($8,$10,'producer','Produced by')`,
    [ids["cinema0"], ids["chema1"], ids["chema2"], ids["decade2003"], silvio, ids["bits"], sRodriguez, ids["supereterodino"], estacio, cayayo]);

    const cinemaVideo = await insert(`INSERT INTO media.youtube_videos(video_id, title, duration_seconds) VALUES ('aaaaaaaaaaa','Luz Verde - Cinema 0 (2000) || Full Album ||',900)`);
    await insert(`INSERT INTO media.youtube_videos(video_id, title, description, duration_seconds)
      VALUES ('1N6cHd9CvEA','Claroscuro - Miel (Official 4K Video)','Audio produced by Cayayo Troconis & Pablo Estacio. Mixed by Pablo Estacio at Pulpo',201)`);
    await pool.query(`
      INSERT INTO media.video_albums(video_id, album_id, album_kind, is_primary_link, confidence, source_id)
      VALUES ($1,$2,'full_album',true,'high',(SELECT id FROM ingest.sources WHERE slug='yt-master-seed'))`, [cinemaVideo, ids["cinema0"]]);
    const reconciled = await reconcileYouTubeChannel({ reportDir });
    expect(reconciled.summary.reviewsCreated).toBe(1);
  }, 180_000);
  afterAll(async () => { await closeDb(); await container.stop(); }, 60_000);

  it("scan encola los pares con evidencia y deja fuera el parecido de nombre sin banda común; repetirlo no duplica", async () => {
    const dry = await scanAmbiguities({ dryRun: true, reportDir });
    expect(dry.albums.candidates).toBe(3);
    expect(dry.persons).toMatchObject({ candidates: 1, withoutContext: 1 });
    expect((await getPool().query("SELECT 1 FROM ingest.review_queue WHERE kind='possible_duplicate'")).rowCount).toBe(0);

    const first = await scanAmbiguities({ reportDir });
    expect(first.albums).toMatchObject({ enqueued: 3, alreadyQueued: 0 });
    expect(first.persons).toMatchObject({ enqueued: 1, alreadyQueued: 0, withoutContext: 1 });
    const second = await scanAmbiguities({ reportDir });
    expect(second.albums).toMatchObject({ enqueued: 0, alreadyQueued: 3 });
    expect(second.persons).toMatchObject({ enqueued: 0, alreadyQueued: 1 });
    const report = JSON.parse(await readFile(path.join(reportDir, "ambiguity-scan.json"), "utf8"));
    expect(report.notQueued.personPairs.map((pair: { names: string[] }) => pair.names)).toEqual([["Silvio Rodríguez", "S. Rodríguez"]]);
  });

  it("resolve decide con evidencia sin tocar el core, y la segunda corrida no crea filas", async () => {
    const before = await core();
    const first = await resolveAmbiguities({ reportDir });
    expect(first.summary.rows).toMatchObject({ created: 5, reused: 0 });
    const decisions = (await getPool().query<{ key: string; question_key: string; decision: string; rule: string }>(`
      SELECT coalesce(q.payload->>'pairKey', q.payload->>'videoId') AS key, r.question_key, r.decision, r.rule
        FROM ingest.ambiguity_resolutions r JOIN ingest.review_queue q ON q.id=r.review_id WHERE r.status='proposed' ORDER BY r.review_id`)).rows;
    expect(decisions).toEqual([
      { key: "1N6cHd9CvEA", question_key: "video_track", decision: "MATCH_HIGH_CONFIDENCE", rule: "music_video.session_credits" },
      { key: `album:${ids["cinema0"]}-${ids["cinemaCero"]}`, question_key: "pair", decision: "MATCH_HIGH_CONFIDENCE", rule: "album.same_release" },
      { key: `album:${ids["decade2003"]}-${ids["decade2002"]}`, question_key: "pair", decision: "CONFLICT", rule: "album.year_conflict" },
      { key: `album:${ids["bits"]}-${ids["bitsessions"]}`, question_key: "pair", decision: "NEEDS_HUMAN", rule: "album.no_same_release_evidence" },
      { key: `person:${ids["chema1"]}-${ids["chema2"]}`, question_key: "pair", decision: "MATCH_HIGH_CONFIDENCE", rule: "person.name_variant_with_context" },
    ]);
    const ungrounded = await getPool().query("SELECT id FROM ingest.ambiguity_resolutions WHERE decision <> 'NEEDS_HUMAN' AND jsonb_array_length(evidence) = 0");
    expect(ungrounded.rowCount).toBe(0);

    const second = await resolveAmbiguities({ reportDir });
    expect(second.summary.rows).toMatchObject({ created: 0, reused: 5, superseded: 0 });
    expect(await core()).toEqual(before);

    const markdown = await readFile(path.join(reportDir, "ambiguity-resolution.md"), "utf8");
    expect(markdown).toContain("| MATCH_HIGH_CONFIDENCE | 3");
    expect(markdown).toContain("album.year_conflict");
    expect(markdown).toContain("| Resoluciones automáticas sin evidencia | 0 |");
  });

  it("el DDL rechaza una resolución sin evidencia o un destino fuera de un MATCH", async () => {
    const review = await reviewFor(`album:${ids["decade2003"]}-${ids["decade2002"]}`);
    const insert = (decision: string, evidence: string, target: string | null) => getPool().query(`
      INSERT INTO ingest.ambiguity_resolutions(review_id, question_key, question, dossier_hash, decision, deterministic_decision, decided_by, rule, reasoning, facts, evidence, target, status)
      VALUES ($1, 'manual', '¿?', $2, $3, $3, 'deterministic', 'test', 'test', '[]', $4::jsonb, $5::jsonb, 'superseded')`, [review, "d".repeat(64), decision, evidence, target]);
    await expect(insert("KEEP_SEPARATE", "[]", null)).rejects.toThrow(/ambiguity_resolutions_evidence_chk/u);
    await expect(insert("CONFLICT", '[{"factId":"F1","supports":"conflict"}]', '{"action":"merge_albums"}')).rejects.toThrow(/ambiguity_resolutions_target_chk/u);
  });

  it("un árbitro externo pasa por la política, y su decisión no se aplica en lote", async () => {
    const exportPath = path.join(reportDir, "arbiter-input.json");
    const exported = await resolveAmbiguities({ reportDir, exportPath });
    expect(exported.summary.aiEligiblePending).toBe(1);
    const dossier = JSON.parse(await readFile(exportPath, "utf8"));
    const [item] = dossier.items as Array<{ reviewId: number; questionKey: string; dossierHash: string; input: { facts: Array<{ id: string; text: string }> } }>;
    const coverage = item!.input.facts.find((fact) => fact.text.includes("posiciones comunes"))!.id;
    const years = item!.input.facts.find((fact) => fact.text.startsWith("años:"))!.id;
    const arbiterPath = path.join(reportDir, "arbiter.json");
    await writeFile(arbiterPath, JSON.stringify({
      arbiter: "claude-opus-5", decidedAt: "2026-09-14",
      decisions: [{ reviewId: item!.reviewId, questionKey: item!.questionKey, dossierHash: item!.dossierHash, proposal: {
        decision: "MATCH_HIGH_CONFIDENCE", option: "same", uncertainties: [],
        evidence: [{ fact_id: coverage, supports: "match", note: "las tres pistas coinciden" }, { fact_id: years, supports: "match", note: "mismo año" }],
        reasoning_summary: "«Bitsessions» es la contracción de «Bits Session»; mismas pistas y año",
      } }],
    }));
    const arbitrated = await resolveAmbiguities({ reportDir, arbiter: await FileArbiter.load(arbiterPath) });
    expect(arbitrated.summary.arbiter).toMatchObject({ consulted: 1, accepted: 1, rejected: 0 });
    expect(arbitrated.summary.rows).toMatchObject({ created: 1, superseded: 1 });
    const row = (await getPool().query("SELECT decision, deterministic_decision, decided_by, arbiter FROM ingest.ambiguity_resolutions WHERE review_id=$1 AND status='proposed'", [item!.reviewId])).rows[0];
    expect(row).toEqual({ decision: "MATCH_HIGH_CONFIDENCE", deterministic_decision: "NEEDS_HUMAN", decided_by: "ai", arbiter: "claude-opus-5" });

    const preview = await applyAmbiguityResolutions({});
    expect(preview.confirmed).toBe(false);
    expect(preview.planned).toHaveLength(3);
    expect(preview.heldForExplicitReview.map((held) => held.reviewId)).toEqual([item!.reviewId]);
  });

  it("apply solo con --confirm: fusiona, enlaza, audita y cierra; lo del árbitro solo nombrando su revisión", async () => {
    // Como en producción, cada fila del core tiene su claim: la auditoría del
    // apply debe enlazarlo. Se siembra tras resolver, y no en los discos del
    // CONFLICT que sigue abierto: las fuentes de un disco entran en su dossier.
    const openConflict = [ids["decade2003"], ids["decade2002"]];
    for (const [kind, table, field, value] of [["album", "albums", "title", "title"], ["track", "tracks", "title", "title"], ["person", "persons", "name", "name"], ["album_credit", "album_credits", "credit_role", "role"]] as const) {
      await getPool().query(`
        INSERT INTO ingest.claims(source_id, entity_kind, ${kind}_id, field, raw_value, raw_hash, status)
        SELECT s.id, '${kind}', x.id, '${field}', to_jsonb(x.${value}), encode(sha256(convert_to('${kind}:' || x.id, 'UTF8')), 'hex'), 'accepted'
          FROM public.${table} x CROSS JOIN ingest.sources s WHERE s.slug='yt-master-seed' AND ('${kind}' <> 'album' OR x.id <> ALL($1::bigint[]))`, [openConflict]);
    }
    const before = await core();
    const nothing = await applyAmbiguityResolutions({ confirm: true });
    expect(nothing.confirmed).toBe(false);
    expect(await core()).toEqual(before);

    const applied = await applyAmbiguityResolutions({ note: "Brian: prueba de E10", confirm: true });
    expect(applied.failed).toEqual([]);
    expect(applied.applied).toHaveLength(3);
    expect(applied.reviewsClosed.map((review) => review.status)).toEqual(["approved", "approved", "approved"]);
    const after = await core();
    expect(after).toMatchObject({ albums: before["albums"]! - 1, persons: before["persons"]! - 1, video_tracks: before["video_tracks"]! + 1, album_credits: before["album_credits"]! - 1 });

    const pool = getPool();
    expect((await pool.query("SELECT 1 FROM public.albums WHERE id=$1", [ids["cinemaCero"]])).rowCount).toBe(0);
    expect((await pool.query("SELECT alias FROM ingest.album_aliases WHERE album_id=$1", [ids["cinema0"]])).rows).toEqual([{ alias: "Cinema Cero" }]);
    expect((await pool.query("SELECT alias FROM ingest.track_aliases ta JOIN public.tracks t ON t.id=ta.track_id WHERE t.album_id=$1", [ids["cinema0"]])).rows).toEqual([{ alias: "Todo Está Bien (Radio version)" }]);
    expect((await pool.query("SELECT alias FROM ingest.person_aliases WHERE person_id=$1", [ids["chema1"]])).rows).toEqual([{ alias: 'José Manuel Arria "Chema"' }]);
    const occurrence = (await pool.query(`
      SELECT t.album_id::int AS album, vt.start_seconds, vt.end_seconds, vt.notes FROM media.video_tracks vt JOIN public.tracks t ON t.id=vt.track_id
        JOIN media.youtube_videos v ON v.id=vt.video_id WHERE v.video_id='1N6cHd9CvEA'`)).rows;
    expect(occurrence).toEqual([expect.objectContaining({ album: ids["supereterodino"], start_seconds: 0, end_seconds: 201, notes: expect.stringMatching(/^ambiguity:/u) })]);
    const audited = (await pool.query("SELECT field FROM ingest.merge_audit WHERE reason LIKE 'Brian: prueba de E10%' ORDER BY field")).rows.map((row) => row.field);
    expect(audited).toEqual(expect.arrayContaining(["merged_duplicate", "title", "youtube_video_occurrence"]));
    // Toda auditoría del apply enlaza evidencia (doctor: merge_audit.coverage).
    const unlinked = (await pool.query(`
      SELECT ma.field FROM ingest.merge_audit ma
       WHERE ma.reason LIKE 'Brian: prueba de E10%'
         AND NOT EXISTS (SELECT 1 FROM ingest.merge_audit_claims mac WHERE mac.merge_audit_id=ma.id)`)).rows;
    expect(unlinked).toEqual([]);
    // El CONFLICT y la decisión del árbitro siguen intactos.
    expect((await pool.query("SELECT 1 FROM public.albums WHERE id = ANY($1::bigint[])", [[ids["decade2003"], ids["decade2002"], ids["bits"], ids["bitsessions"]]])).rowCount).toBe(4);

    const bitsReview = await reviewFor(`album:${ids["bits"]}-${ids["bitsessions"]}`);
    const explicit = await applyAmbiguityResolutions({ reviewIds: [bitsReview], note: "Brian confirma la propuesta del árbitro", confirm: true });
    expect(explicit.applied.map((item) => [item.reviewId, item.decidedBy])).toEqual([[bitsReview, "ai"]]);
    expect((await pool.query("SELECT 1 FROM public.albums WHERE id = ANY($1::bigint[])", [[ids["bits"], ids["bitsessions"]]])).rowCount).toBe(1);
  });

  it("yt:reconcile no reabre el videoclip decidido y resolve solo ve lo que sigue abierto", async () => {
    const reconciled = await reconcileYouTubeChannel({ reportDir });
    expect(reconciled.summary.reviewsCreated).toBe(0);
    const miel = reconciled.plan.verdicts.find((verdict) => verdict.videoId === "1N6cHd9CvEA")!;
    expect(miel.category).toBe("MATCHED_HIGH");
    expect(miel.reasons.join(" ")).toMatch(/revisión #\d+ \(approved\)/u);

    const again = await resolveAmbiguities({ reportDir });
    expect(again.summary).toMatchObject({ cases: 1, rows: { created: 0, reused: 1 } });
    const markdown = await readFile(path.join(reportDir, "ambiguity-resolution.md"), "utf8");
    expect(markdown).toContain("**aplicada**");
    expect(markdown).toContain("## CONFLICT (1)");
  });
});
