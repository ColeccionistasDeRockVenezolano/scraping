// CRV · Detector de conflictos de Curaduría contra PostgreSQL real: ciclo de
// vida de los hallazgos (abierto → resuelto → reabierto), decisiones que
// persisten entre análisis, y la verificación automática tras cada corrección
// hecha por la API, con la marca de lo que la corrección desencadenó.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { buildApp } from "../../src/api/app.js";
import { runCurationScan, waitForCurationScans } from "../../src/curation/scan.js";

const TOKEN = "token-de-prueba-curaduria-0123456789";
const OPERATOR = "Tester Curaduria";
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

interface FindingRow { id: string; detector: string; status: string; evidence: Record<string, unknown>; first_seen_scan_id: string }

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

    const ignored = await app.inject({ method: "POST", url: `/curation/findings/${mistyped!.id}/ignore`, headers, payload: { note: "es un estudio y una persona a la vez" } });
    expect(ignored.statusCode).toBe(200);
    expect(ignored.json()).toMatchObject({ status: "ignored", ignoredBy: OPERATOR });

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
    await getPool().query("UPDATE public.artists SET name = $2 WHERE id = $1", [artistId, `Trueno${ZERO_WIDTH_SPACE} Negro`]);
    const scan = await runCurationScan({ trigger: "manual" });
    expect(scan.reopened).toBe(1);
    const [again] = await findingsOf("caracteres_invisibles");
    expect(again).toMatchObject({ id: invisible!.id, status: "open", first_seen_scan_id: String(scan.scanId) });
    // Al volver al nombre original se resolvió la ciudad del nombre: la vuelta queda enlazada a ella.
    expect(again!.evidence["triggeredBy"]).toEqual([expect.objectContaining({ entityKind: "artist", entityId: artistId })]);
  }, 60_000);

  it("las lecturas del detector son solo para administradores", async () => {
    const response = await app.inject({ method: "GET", url: "/curation/summary" });
    expect(response.statusCode).toBe(401);
  });
});
