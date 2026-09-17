// CRV · Detector de conflictos de Curaduría contra PostgreSQL real: ciclo de
// vida de los hallazgos (abierto → resuelto → reabierto), decisiones que
// persisten entre análisis, y la verificación automática tras cada corrección
// hecha por la API, con la marca de lo que la corrección desencadenó.
// Robustez del motor (PLAN_CURADURIA E1): un detector roto no resuelve lo que
// no miró (C1, C2), una base caída no tumba el proceso (C5) y dos procesos no
// guardan a la vez (A4).
// Decisiones duraderas (E2): ignorar exige motivo, un par ignorado sobrevive a
// un tercer miembro (A5), un ignorado caduca cuando el problema desaparece,
// «son distintas» no vuelve (M3) y los cambios de título quedan en la historia.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { buildApp } from "../../src/api/app.js";
import { runCurationScan, waitForCurationScans } from "../../src/curation/scan.js";
import { notifyCatalogWrite } from "../../src/curation/watcher.js";
import { htmlEntities } from "../../src/curation/detectors/text-hygiene.js";
import { pruneCuration } from "../../src/curation/retention.js";

const TOKEN = "token-de-prueba-curaduria-0123456789";
const OPERATOR = "Tester Curaduria";
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

interface FindingRow { id: string; detector: string; status: string; evidence: Record<string, unknown>; first_seen_scan_id: string }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("detector de conflictos de Curaduría (persistencia y verificación de correcciones)", () => {
  let container: PgContainer;
  let app: FastifyInstance;
  let artistId: number;

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    process.env["CRV_OPERATOR_TOKEN"] = TOKEN;
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
    app = await buildApp();
  }, 120_000);

  afterAll(async () => { await app?.close(); await closeDb(); await container.stop(); }, 60_000);

  const headers = { authorization: `Bearer ${TOKEN}`, "x-crv-operator": OPERATOR };
  const one = async (sql: string, params: unknown[] = []): Promise<number> =>
    Number((await getPool().query<{ id: string }>(sql, params)).rows[0]!.id);
  const resolutionOf = async (id: string) => (await getPool().query<{ status: string; resolution: string | null; run_id: string | null; action: string | null; operator: string | null }>(`
    SELECT f.status, f.resolution, f.resolved_by_run_id::text AS run_id, r.params->>'action' AS action, r.params->>'operator' AS operator
      FROM ingest.curation_findings f LEFT JOIN ingest.scrape_runs r ON r.id = f.resolved_by_run_id
     WHERE f.id = $1`, [id])).rows[0];
  const findingsOf = async (detector: string): Promise<FindingRow[]> =>
    (await getPool().query<FindingRow>(
      "SELECT id::text, detector, status, evidence, first_seen_scan_id::text FROM ingest.curation_findings WHERE detector = $1 ORDER BY id", [detector])).rows;

  async function waitForScan(trigger: string, afterId: number): Promise<{ id: string; counters: Record<string, number> }> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const { rows } = await getPool().query<{ id: string; counters: Record<string, number> }>(
        "SELECT id::text, counters FROM ingest.curation_scans WHERE trigger = $1 AND status = 'ok' AND id > $2 ORDER BY id DESC LIMIT 1", [trigger, afterId]);
      if (rows[0]) { await waitForCurationScans(); return rows[0]; }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`no llegó un análisis «${trigger}»`);
  }

  it("guarda los hallazgos y respeta lo ignorado entre análisis", async () => {
    artistId = await one("INSERT INTO public.artists(name, origin_city) VALUES($1, 'Caracas') RETURNING id", [`Trueno${ZERO_WIDTH_SPACE} Negro`]);
    const album = await one("INSERT INTO public.albums(artist_id, title) VALUES($1, 'Ruido Blanco') RETURNING id", [artistId]);
    await getPool().query("INSERT INTO public.tracks(album_id, track_number, title) VALUES($1, 1, 'Calle Sola')", [album]);
    await one("INSERT INTO public.organizations(name) VALUES('Estudios Sonoros QA') RETURNING id");
    const person = await one("INSERT INTO public.persons(name) VALUES('Estudios Sonoros QA') RETURNING id");
    await getPool().query("INSERT INTO public.album_credits(album_id, person_id, credit_type, role) VALUES($1, $2, 'recording', 'Grabación')", [album, person]);

    const first = await runCurationScan({ trigger: "manual" });
    expect(first.status).toBe("ok");
    expect(first.inserted).toBeGreaterThan(0);
    const [invisible] = await findingsOf("caracteres_invisibles");
    expect(invisible).toMatchObject({ status: "open" });
    const [mistyped] = await findingsOf("persona_es_organizacion");
    expect(mistyped).toMatchObject({ status: "open" });

    const ignored = await app.inject({ method: "POST", url: `/curation/findings/${mistyped!.id}/ignore`, headers, payload: { reason: "correcto_a_proposito", note: "es un estudio y una persona a la vez" } });
    expect(ignored.statusCode).toBe(200);
    expect(ignored.json()).toMatchObject({ status: "ignored", ignoredBy: OPERATOR, ignoreReason: "correcto_a_proposito" });

    const second = await runCurationScan({ trigger: "manual" });
    expect(second).toMatchObject({ status: "ok", inserted: 0, resolved: 0 });
    expect((await findingsOf("persona_es_organizacion"))[0]).toMatchObject({ id: mistyped!.id, status: "ignored" });
  }, 60_000);

  it("tras una corrección por la API vuelve a analizar y marca lo que la corrección desencadenó", async () => {
    const [invisible] = await findingsOf("caracteres_invisibles");
    const before = await one("SELECT coalesce(max(id), 0) AS id FROM ingest.curation_scans");

    // Quita el carácter invisible, pero mete la ciudad en el nombre.
    const patched = await app.inject({ method: "PATCH", url: `/artists/${artistId}`, headers, payload: { name: "Trueno Negro (Caracas)" } });
    expect(patched.statusCode).toBe(200);

    const scan = await waitForScan("correccion", before);
    expect(scan.counters["resolved"]).toBeGreaterThanOrEqual(1);
    expect(scan.counters["chained"]).toBeGreaterThanOrEqual(1);
    expect((await findingsOf("caracteres_invisibles"))[0]).toMatchObject({ id: invisible!.id, status: "resolved" });
    // M1: la edición por la API queda como «cambiado en otra parte», con el run que cambió el nombre.
    expect(await resolutionOf(invisible!.id)).toMatchObject({
      status: "resolved", resolution: "changed_elsewhere", run_id: String(patched.json().runId), action: "api:update:artist", operator: OPERATOR,
    });

    const [region] = await findingsOf("aclaracion_en_nombre_de_artista");
    expect(region).toMatchObject({ status: "open", first_seen_scan_id: scan.id });
    expect(region!.evidence["triggeredBy"]).toEqual([expect.objectContaining({ id: Number(invisible!.id), entityKind: "artist", entityId: artistId })]);

    const summary = await app.inject({ method: "GET", url: "/curation/summary", headers });
    expect(summary.statusCode).toBe(200);
    const body = summary.json();
    expect(body.lastCorrection).toMatchObject({ id: Number(scan.id), trigger: "correccion", requestedBy: OPERATOR });
    expect(body.totals.chainedOpen).toBeGreaterThanOrEqual(1);
    expect(body.categories.map((category: { key: string }) => category.key)).toContain("otros");

    const chained = await app.inject({ method: "GET", url: `/curation/findings?chained=true&scanId=${scan.id}`, headers });
    expect(chained.statusCode).toBe(200);
    expect(chained.json().data.map((item: { id: number }) => item.id)).toContain(Number(region!.id));
  }, 60_000);

  it("un problema que vuelve se reabre con su historia y cuenta como aparición nueva", async () => {
    const [invisible] = await findingsOf("caracteres_invisibles");
    const [region] = await findingsOf("aclaracion_en_nombre_de_artista");
    await getPool().query("UPDATE public.artists SET name = $2 WHERE id = $1", [artistId, `Trueno${ZERO_WIDTH_SPACE} Negro`]);
    const scan = await runCurationScan({ trigger: "manual" });
    expect(scan.reopened).toBe(1);
    const [again] = await findingsOf("caracteres_invisibles");
    expect(again).toMatchObject({ id: invisible!.id, status: "open", first_seen_scan_id: String(scan.scanId) });
    // Reabierto: el motivo de la resolución anterior ya no aplica.
    expect(await resolutionOf(invisible!.id)).toMatchObject({ status: "open", resolution: null, run_id: null });
    // Un cambio hecho por SQL no deja rastro en merge_audit: otra parte, sin run.
    expect(await resolutionOf(region!.id)).toMatchObject({ status: "resolved", resolution: "changed_elsewhere", run_id: null });
    // Al volver al nombre original se resolvió la ciudad del nombre: la vuelta queda enlazada a ella.
    expect(again!.evidence["triggeredBy"]).toEqual([expect.objectContaining({ entityKind: "artist", entityId: artistId })]);
  }, 60_000);

  it("una corrección desde Curaduría queda resuelta como tal, con su run y quién la firmó (M1)", async () => {
    const [invisible] = await findingsOf("caracteres_invisibles");
    expect(invisible).toMatchObject({ status: "open" });
    const before = await one("SELECT coalesce(max(id), 0) AS id FROM ingest.curation_scans");
    const fixed = await app.inject({ method: "POST", url: `/curation/findings/${invisible!.id}/fix`, headers, payload: { note: "quitar el espacio de ancho cero" } });
    expect(fixed.statusCode).toBe(200);
    const scan = await waitForScan("correccion", before);
    expect(scan.counters["resolutions"]).toMatchObject({ fixed_by_curation: 1 });

    const resolution = await resolutionOf(invisible!.id);
    expect(resolution).toMatchObject({ status: "resolved", resolution: "fixed_by_curation", action: "api:curation:fix", operator: OPERATOR });
    const read = await app.inject({ method: "GET", url: `/curation/findings/${invisible!.id}`, headers });
    expect(read.json()).toMatchObject({ status: "resolved", resolution: "fixed_by_curation", resolvedByRunId: Number(resolution!.run_id), resolvedBy: OPERATOR });
  }, 60_000);

  it("una ficha retirada por la API resuelve sus hallazgos como «ficha retirada» (M1)", async () => {
    const orphan = await one("INSERT INTO public.organizations(name) VALUES('Sello Huerfano QA') RETURNING id");
    await runCurationScan({ trigger: "manual" });
    const [found] = (await getPool().query<{ id: string }>(`
      SELECT id::text FROM ingest.curation_findings
       WHERE detector = 'fichas_sin_vinculos' AND entity_kind = 'organization' AND entity_id = $1 AND status = 'open'`, [orphan])).rows;
    expect(found).toBeDefined();
    const before = await one("SELECT coalesce(max(id), 0) AS id FROM ingest.curation_scans");
    const removed = await app.inject({ method: "DELETE", url: `/organizations/${orphan}?note=${encodeURIComponent("sello de prueba sin vínculos")}`, headers });
    expect(removed.statusCode).toBe(200);
    await waitForScan("correccion", before);
    expect(await resolutionOf(found!.id)).toMatchObject({ status: "resolved", resolution: "entity_removed", run_id: null });
  }, 60_000);

  it("las lecturas del detector son solo para administradores", async () => {
    const response = await app.inject({ method: "GET", url: "/curation/summary" });
    expect(response.statusCode).toBe(401);
  });

  it("una referencia HTML fuera de rango no resuelve de golpe los hallazgos de su detector (C2 → C1)", async () => {
    await one("INSERT INTO public.organizations(name) VALUES('Green &amp; Blue QA') RETURNING id");
    expect((await runCurationScan({ trigger: "manual" })).status).toBe("ok");
    const [amp] = await findingsOf("entidades_html");
    expect(amp).toMatchObject({ status: "open" });

    await one("INSERT INTO public.artists(name) VALUES('Ruido &#xFFFFFF; QA') RETURNING id");
    const scan = await runCurationScan({ trigger: "manual" });
    expect(scan.failures).toEqual([]);
    expect(scan.status).toBe("ok");
    const html = await findingsOf("entidades_html");
    expect(html).toHaveLength(2);
    expect(html.find((row) => row.id === amp!.id)).toMatchObject({ status: "open", first_seen_scan_id: amp!.first_seen_scan_id });
  }, 60_000);

  it("un detector que falla deja intactos sus hallazgos y los de «Otros», y el análisis queda parcial (C1)", async () => {
    const snapshotOf = async (detector: string) => (await findingsOf(detector)).map((row) => [row.id, row.status, row.first_seen_scan_id]);
    const html = await snapshotOf("entidades_html");
    const others = await snapshotOf("anomalia_del_catalogo");
    expect(html.filter(([, status]) => status === "open").length).toBeGreaterThan(0);

    const spy = vi.spyOn(htmlEntities, "run").mockImplementation(() => { throw new Error("detector roto a propósito"); });
    try {
      const scan = await runCurationScan({ trigger: "manual" });
      expect(scan).toMatchObject({ status: "partial", failures: expect.arrayContaining([{ detector: "entidades_html", error: "detector roto a propósito" }]) });
      const saved = await getPool().query<{ status: string }>("SELECT status FROM ingest.curation_scans WHERE id = $1", [scan.scanId]);
      expect(saved.rows[0]).toEqual({ status: "partial" });
      expect(await snapshotOf("entidades_html")).toEqual(html);
      expect(await snapshotOf("anomalia_del_catalogo")).toEqual(others);
    } finally {
      spy.mockRestore();
    }

    // El análisis sano siguiente los encuentra abiertos: nada que reabrir ni que contar como nuevo.
    const healthy = await runCurationScan({ trigger: "manual" });
    expect(healthy).toMatchObject({ status: "ok", inserted: 0, reopened: 0 });
    expect(await snapshotOf("entidades_html")).toEqual(html);
  }, 60_000);

  it("una base caída durante la verificación de una escritura no tumba el proceso (C5)", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => { unhandled.push(reason); };
    const databaseUrl = process.env["DATABASE_URL"]!;
    process.on("unhandledRejection", listener);
    try {
      await closeDb();
      process.env["DATABASE_URL"] = "postgresql://postgres:postgres@127.0.0.1:1/base_caida";
      resetEnvCache();
      notifyCatalogWrite(OPERATOR, "PATCH /artists/:id");
      await sleep(2_500);
      await waitForCurationScans();
      await sleep(100);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
      await closeDb();
      process.env["DATABASE_URL"] = databaseUrl;
      resetEnvCache();
    }
    expect((await runCurationScan({ trigger: "manual" })).status).toBe("ok");
  }, 60_000);

  it("dos procesos que analizan a la vez: uno guarda y el otro se omite (A4)", async () => {
    // Otro proceso (la CLI mientras corre la API): módulos y pool propios.
    vi.resetModules();
    const otherScan = await import("../../src/curation/scan.js");
    const otherDb = await import("../../src/db/client.js");
    const lastScanId = await one("SELECT coalesce(max(id), 0) AS id FROM ingest.curation_scans");
    const blocker = await getPool().connect();
    let first: Promise<Awaited<ReturnType<typeof runCurationScan>>> | null = null;
    let second: Promise<Awaited<ReturnType<typeof runCurationScan>>> | null = null;
    try {
      // Detiene al primer análisis justo cuando va a guardar sus hallazgos.
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE ingest.curation_findings IN EXCLUSIVE MODE");
      first = runCurationScan({ trigger: "manual" });
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const waiting = await getPool().query(
          "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND position('INSERT INTO ingest.curation_findings' IN query) > 0");
        if (waiting.rowCount) break;
        await sleep(50);
      }
      second = otherScan.runCurationScan({ trigger: "cli" });
      const early = await Promise.race([second, sleep(5_000).then(() => "sigue esperando" as const)]);
      expect(early).toMatchObject({ status: "skipped" });
    } finally {
      await blocker.query("COMMIT");
      blocker.release();
      await Promise.allSettled([first, second]);
      await otherDb.closeDb();
    }
    expect(await first).toMatchObject({ status: "ok" });
    const scans = await getPool().query<{ trigger: string; status: string }>(
      "SELECT trigger, status FROM ingest.curation_scans WHERE id > $1 ORDER BY id", [lastScanId]);
    expect(scans.rows).toEqual([{ trigger: "manual", status: "ok" }, { trigger: "cli", status: "skipped" }]);
  }, 60_000);

  it("la poda conserva los últimos análisis y los resueltos recientes; nunca toca abiertos ni ignorados (A9)", async () => {
    const count = async (sql: string) => Number((await getPool().query<{ n: string }>(sql)).rows[0]!.n);
    const [resolved] = (await getPool().query<{ id: string }>("SELECT id::text FROM ingest.curation_findings WHERE status = 'resolved' ORDER BY id LIMIT 1")).rows;
    await getPool().query("UPDATE ingest.curation_findings SET resolved_at = now() - interval '200 days' WHERE id = $1", [resolved!.id]);
    const scans = await count("SELECT count(*)::text AS n FROM ingest.curation_scans");
    const live = await count("SELECT count(*)::text AS n FROM ingest.curation_findings WHERE status IN ('open', 'ignored')");
    const resolvedTotal = await count("SELECT count(*)::text AS n FROM ingest.curation_findings WHERE status = 'resolved'");
    expect(scans).toBeGreaterThan(3);

    const preview = await pruneCuration({ dryRun: true, keepScans: 3 });
    expect(preview).toMatchObject({ status: "ok", dryRun: true, scans: scans - 3, resolvedFindings: 1, resolvedDays: 180 });
    expect(await count("SELECT count(*)::text AS n FROM ingest.curation_scans")).toBe(scans);

    // Con un análisis en curso en otro proceso, la poda no borra nada.
    const holder = await getPool().connect();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtext('crv:curation:scan'))");
      expect(await pruneCuration({ dryRun: false, keepScans: 3 })).toMatchObject({ status: "skipped", scans: 0, resolvedFindings: 0 });
    } finally {
      await holder.query("SELECT pg_advisory_unlock(hashtext('crv:curation:scan'))");
      holder.release();
    }

    expect(await pruneCuration({ dryRun: false, keepScans: 3 })).toMatchObject({ status: "ok", scans: scans - 3, resolvedFindings: 1 });
    expect(await count("SELECT count(*)::text AS n FROM ingest.curation_scans")).toBe(3);
    expect(await count("SELECT count(*)::text AS n FROM ingest.curation_findings WHERE status IN ('open', 'ignored')")).toBe(live);
    expect(await count("SELECT count(*)::text AS n FROM ingest.curation_findings WHERE status = 'resolved'")).toBe(resolvedTotal - 1);
    // Lo que queda sigue funcionando: un análisis nuevo sobre la base podada.
    expect((await runCurationScan({ trigger: "manual" })).status).toBe("ok");
  }, 60_000);

  // ---------------------------------------------------------------------------
  // E2: decisiones duraderas
  // ---------------------------------------------------------------------------

  const findingOfPair = async (detector: string, a: number, b: number) => (await getPool().query<FindingRow & { title: string; ignore_reason: string | null }>(`
    SELECT id::text, detector, status, evidence, first_seen_scan_id::text, title, ignore_reason FROM ingest.curation_findings
     WHERE detector = $1 AND evidence->'pair' = $2::jsonb`, [detector, JSON.stringify([Math.min(a, b), Math.max(a, b)])])).rows[0];

  it("ignorar exige un motivo válido (E2.5)", async () => {
    const [finding] = (await getPool().query<{ id: string }>("SELECT id::text FROM ingest.curation_findings WHERE status = 'open' ORDER BY id LIMIT 1")).rows;
    for (const payload of [{ note: "sin motivo" }, { reason: "me_da_igual", note: "motivo inventado" }]) {
      const response = await app.inject({ method: "POST", url: `/curation/findings/${finding!.id}/ignore`, headers, payload });
      expect(response.statusCode).toBe(400);
    }
    const group = await app.inject({ method: "POST", url: "/curation/findings/ignore-group", headers,
      payload: { category: "fichas_repetidas", detector: "artistas_equivalentes", reason: "falso_positivo" } });
    expect(group.statusCode).toBe(400);
    expect((await resolutionOf(finding!.id))!.status).toBe("open");
  }, 60_000);

  it("un par ignorado en grupo sobrevive a la aparición de un tercer miembro (A5)", async () => {
    const los = await one("INSERT INTO public.artists(name) VALUES('Los Flanders QA') RETURNING id");
    const bare = await one("INSERT INTO public.artists(name) VALUES('Flanders QA') RETURNING id");
    expect((await runCurationScan({ trigger: "manual" })).status).toBe("ok");
    const pair = await findingOfPair("artistas_equivalentes", los, bare);
    expect(pair).toMatchObject({ status: "open" });

    const ignored = await app.inject({ method: "POST", url: "/curation/findings/ignore-group", headers, payload: {
      category: "fichas_repetidas", detector: "artistas_equivalentes", signature: "sin_articulo_o_espacios",
      reason: "falso_positivo", note: "dos bandas distintas con nombre parecido",
    } });
    expect(ignored.statusCode).toBe(200);
    expect(ignored.json().ignored).toBeGreaterThanOrEqual(1);

    const third = await one("INSERT INTO public.artists(name) VALUES('The Flanders QA') RETURNING id");
    const scan = await runCurationScan({ trigger: "manual" });
    expect(scan.status).toBe("ok");
    // La decisión sigue en la misma fila: la huella del par no depende del grupo.
    const after = await findingOfPair("artistas_equivalentes", los, bare);
    expect(after).toMatchObject({ id: pair!.id, status: "ignored", ignore_reason: "falso_positivo" });
    // El título cambió («3 con la misma forma») y queda en la historia.
    expect(after!.title).toContain("3 con la misma forma");
    expect((after!.evidence["history"] as Array<{ scanId: number; from: { title: string }; to: { title: string } }>)[0]).toMatchObject({
      scanId: scan.scanId, from: { title: pair!.title }, to: { title: after!.title },
    });
    // Los pares nuevos con el tercero piden su propia decisión.
    expect(await findingOfPair("artistas_equivalentes", los, third)).toMatchObject({ status: "open" });
    expect(await findingOfPair("artistas_equivalentes", bare, third)).toMatchObject({ status: "open" });
  }, 60_000);

  it("un ignorado caduca cuando el problema desaparece y, si vuelve, vuelve abierto (E2.5)", async () => {
    const [mistyped] = (await getPool().query<{ id: string; entity_id: string }>(`
      SELECT id::text, entity_id::text FROM ingest.curation_findings WHERE detector = 'persona_es_organizacion' AND status = 'ignored' ORDER BY id LIMIT 1`)).rows;
    expect(mistyped).toBeDefined();
    await getPool().query("UPDATE public.persons SET name = 'Rosa Pérez QA' WHERE id = $1", [mistyped!.entity_id]);
    expect((await runCurationScan({ trigger: "manual" })).status).toBe("ok");
    const expired = await getPool().query<{ status: string; resolution: string; ignore_reason: string | null; ignored_by: string | null }>(
      "SELECT status, resolution, ignore_reason, ignored_by FROM ingest.curation_findings WHERE id = $1", [mistyped!.id]);
    // Cambio por SQL, sin rastro en merge_audit: «cambiado en otra parte». La decisión vieja queda a la vista.
    expect(expired.rows[0]).toEqual({ status: "resolved", resolution: "changed_elsewhere", ignore_reason: "correcto_a_proposito", ignored_by: OPERATOR });

    await getPool().query("UPDATE public.persons SET name = 'Estudios Sonoros QA' WHERE id = $1", [mistyped!.entity_id]);
    expect((await runCurationScan({ trigger: "manual" })).reopened).toBeGreaterThanOrEqual(1);
    const back = await getPool().query("SELECT status, resolution, ignore_reason, ignored_by, ignore_note FROM ingest.curation_findings WHERE id = $1", [mistyped!.id]);
    expect(back.rows[0]).toEqual({ status: "open", resolution: null, ignore_reason: null, ignored_by: null, ignore_note: null });
  }, 60_000);

  it("un par declarado distinto se resuelve como tal y no vuelve; al retirarlo, se reabre (M3)", async () => {
    const zeta = await one("INSERT INTO public.artists(name) VALUES('Zeta QA') RETURNING id");
    const theZeta = await one("INSERT INTO public.artists(name) VALUES('The Zeta QA') RETURNING id");
    expect((await runCurationScan({ trigger: "manual" })).status).toBe("ok");
    const pair = await findingOfPair("artistas_equivalentes", zeta, theZeta);
    expect(pair).toMatchObject({ status: "open" });

    const invalid = await app.inject({ method: "POST", url: "/curation/distinct-pairs", headers, payload: { kind: "artist", aId: zeta, bId: zeta, note: "la misma ficha" } });
    expect(invalid.statusCode).toBe(400);

    const before = await one("SELECT coalesce(max(id), 0) AS id FROM ingest.curation_scans");
    const declared = await app.inject({ method: "POST", url: "/curation/distinct-pairs", headers, payload: { kind: "artist", aId: theZeta, bId: zeta, note: "bandas distintas de ciudades distintas" } });
    expect(declared.statusCode).toBe(200);
    expect(declared.json()).toMatchObject({ created: true, pair: { kind: "artist", aId: Math.min(zeta, theZeta), bId: Math.max(zeta, theZeta), decidedBy: OPERATOR } });
    const again = await app.inject({ method: "POST", url: "/curation/distinct-pairs", headers, payload: { kind: "artist", aId: zeta, bId: theZeta, note: "otra vez" } });
    expect(again.json()).toMatchObject({ created: false, pair: { id: declared.json().pair.id } });

    await waitForScan("correccion", before);
    expect(await resolutionOf(pair!.id)).toMatchObject({ status: "resolved", resolution: "declared_distinct", run_id: null });
    const quiet = await runCurationScan({ trigger: "manual" });
    expect(quiet).toMatchObject({ status: "ok", reopened: 0 });
    expect((await findingOfPair("artistas_equivalentes", zeta, theZeta))!.status).toBe("resolved");

    const listed = await app.inject({ method: "GET", url: "/curation/distinct-pairs?kind=artist", headers });
    expect(listed.json().data.map((row: { id: number }) => row.id)).toContain(declared.json().pair.id);

    const afterDeclare = await one("SELECT coalesce(max(id), 0) AS id FROM ingest.curation_scans");
    const removed = await app.inject({ method: "DELETE", url: `/curation/distinct-pairs/${declared.json().pair.id}`, headers });
    expect(removed.statusCode).toBe(200);
    await waitForScan("correccion", afterDeclare);
    expect((await findingOfPair("artistas_equivalentes", zeta, theZeta))!).toMatchObject({ id: pair!.id, status: "open" });
  }, 60_000);
});
