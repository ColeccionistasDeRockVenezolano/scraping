// CRV · Autocorrección segura de Curaduría contra PostgreSQL real
// (PLAN_CURADURIA E10). Es la única parte del sistema que escribe en el core
// sin que nadie pulse nada, así que lo que se prueba aquí es que NO PUEDE
// hacer daño:
//
//  - apagada por defecto: con reglas encendidas y hallazgos delante, sin
//    `CRV_CURATION_AUTOFIX` no toca nada (E10.1);
//  - la lista blanca solo admite acciones de nivel 0 que el detector proponga,
//    y cada cambio queda auditado con quién y cuándo (E10.1);
//  - una regla activa corrige invisibles sola, respeta su tope por análisis, y
//    deja un lote normal firmado `crv-curaduria-auto` que se puede deshacer
//    (E10.2, E10.4);
//  - INTERRUPTOR DE EMERGENCIA: un lote cuya verificación dirigida encuentra
//    hallazgos desencadenados se deshace entero y apaga la regla, con el aviso
//    a la vista en el panorama (E10.3, E10.5).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { buildApp } from "../../src/api/app.js";
import { runCurationScan, setAfterFullScan, waitForCurationScans } from "../../src/curation/scan.js";
import { AUTOFIX_OPERATOR } from "../../src/curation/autofix.js";

const TOKEN = "token-de-prueba-autocorreccion-0123456789";
const OPERATOR = "Tester Autocorreccion";
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

interface RuleView { id: number; detector: string; actionKey: string; enabled: boolean; maxPerScan: number | null; disabledReason: string | null; disabledByBatchId: number | null }
interface ReportView {
  report: {
    enabled: boolean; rules: { total: number; active: number }; today: { batches: number; applied: number; undone: number };
    batches: Array<{ batchId: number; detector: string; actionKey: string; status: string; applied: number; triggered: number; undoneByBatchId: number | null }>;
    alerts: Array<{ ruleId: number | null; detector: string; actionKey: string; reason: string; batchId: number | null }>;
  };
  rules: RuleView[];
  events: Array<{ event: string; operator: string; batchId: number | null; detail: Record<string, unknown> }>;
}
interface RunView {
  status: string; applied: number;
  rules: Array<{ ruleId: number; batchId: number | null; applied: number; failed: number; triggered: number; reverted: boolean }>;
}

describe("autocorrección segura de Curaduría (E10)", () => {
  let container: PgContainer;
  let app: FastifyInstance;
  let ruleId: number;
  let artistA: number;
  let artistB: number;
  let personId: number;

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    process.env["CRV_OPERATOR_TOKEN"] = TOKEN;
    // Explícito: el valor por defecto es este, y la primera prueba lo comprueba.
    process.env["CRV_CURATION_AUTOFIX"] = "false";
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
    // `buildApp` engancha la autocorrección al final de cada análisis completo.
    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await waitForCurationScans();
    setAfterFullScan(null);
    delete process.env["CRV_CURATION_AUTOFIX"];
    resetEnvCache();
    await app?.close(); await closeDb(); await container?.stop();
  }, 60_000);

  const headers = { authorization: `Bearer ${TOKEN}`, "x-crv-operator": OPERATOR };
  const one = async (sql: string, params: unknown[] = []): Promise<number> =>
    Number((await getPool().query<{ id: string }>(sql, params)).rows[0]!.id);
  const rows = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    (await getPool().query<T>(sql, params)).rows;
  const state = async (): Promise<ReportView> => {
    const response = await app.inject({ method: "GET", url: "/curation/autofix", headers });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  };
  const runNow = async (): Promise<RunView> => {
    const response = await app.inject({ method: "POST", url: "/curation/autofix/run", headers });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  };
  const nameOf = async (table: "artists" | "persons", id: number): Promise<string> =>
    (await rows<{ name: string }>(`SELECT name FROM public.${table} WHERE id = $1`, [id]))[0]!.name;
  const dirtyArtists = async (): Promise<number[]> =>
    (await rows<{ id: string }>("SELECT id::text FROM public.artists WHERE name LIKE $1 ORDER BY id", [`%${ZERO_WIDTH_SPACE}%`])).map((row) => Number(row.id));
  const openFindings = async (detector: string): Promise<Array<{ id: number; entity_id: number; status: string; resolution: string | null }>> =>
    (await rows<{ id: string; entity_id: string; status: string; resolution: string | null }>(
      "SELECT id::text, entity_id::text, status, resolution FROM ingest.curation_findings WHERE detector = $1 ORDER BY id", [detector]))
      .map((row) => ({ id: Number(row.id), entity_id: Number(row.entity_id), status: row.status, resolution: row.resolution }));

  it("apagada por defecto: con la regla encendida y los hallazgos delante, no toca nada (E10.1)", async () => {
    artistA = await one("INSERT INTO public.artists(name, origin_city) VALUES($1, 'Caracas') RETURNING id", [`Trueno${ZERO_WIDTH_SPACE} Negro`]);
    artistB = await one("INSERT INTO public.artists(name, origin_city) VALUES($1, 'Maracaibo') RETURNING id", [`Cardenales${ZERO_WIDTH_SPACE} del Sur`]);
    for (const artist of [artistA, artistB]) {
      const album = await one("INSERT INTO public.albums(artist_id, title) VALUES($1, $2) RETURNING id", [artist, `Disco ${artist}`]);
      await getPool().query("INSERT INTO public.tracks(album_id, track_number, title) VALUES($1, 1, 'Calle Sola')", [album]);
    }
    const scan = await runCurationScan({ trigger: "manual" });
    expect(scan.status).toBe("ok");
    expect((await openFindings("caracteres_invisibles")).filter((finding) => finding.status === "open")).toHaveLength(2);

    const created = await app.inject({
      method: "POST", url: "/curation/autofix/rules", headers,
      payload: { detector: "caracteres_invisibles", actionKey: "limpiar_texto", enabled: true, maxPerScan: 1, note: "invisibles: determinista y reversible" },
    });
    expect(created.statusCode, created.body).toBe(200);
    ruleId = (created.json() as RuleView).id;

    // El interruptor del entorno manda sobre la lista blanca.
    expect(await runNow()).toMatchObject({ status: "apagada", applied: 0, rules: [] });
    // Y tampoco corre sola al terminar un análisis completo.
    await runCurationScan({ trigger: "manual" });
    await waitForCurationScans();
    expect(await dirtyArtists()).toEqual([artistA, artistB]);

    const { report, events } = await state();
    expect(report).toMatchObject({ enabled: false, rules: { total: 1, active: 1 }, today: { batches: 0, applied: 0, undone: 0 } });
    expect(events.map((event) => event.event)).toEqual(["enabled", "created"]);
    expect(events[0]).toMatchObject({ operator: OPERATOR });
  }, 90_000);

  it("la lista blanca solo admite acciones de nivel 0 que el detector proponga (E10.1)", async () => {
    const reject = async (payload: Record<string, unknown>, expected: RegExp): Promise<void> => {
      const response = await app.inject({ method: "POST", url: "/curation/autofix/rules", headers, payload });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error.message).toMatch(expected);
    };
    await reject({ detector: "detector_inventado", actionKey: "limpiar_texto" }, /detector desconocido/u);
    await reject({ detector: "caracteres_invisibles", actionKey: "accion_inventada" }, /acción desconocida/u);
    // Nivel 1: exige criterio humano, no se automatiza aunque se pida.
    await reject({ detector: "artistas_equivalentes", actionKey: "fusionar" }, /nivel 1.*solo aplica acciones de nivel 0/u);
    // Nivel 0, pero ese detector no la propone: la regla nunca haría nada.
    await reject({ detector: "caracteres_invisibles", actionKey: "decodificar_html" }, /no propone/u);

    const repeated = await app.inject({
      method: "POST", url: "/curation/autofix/rules", headers,
      payload: { detector: "caracteres_invisibles", actionKey: "limpiar_texto" },
    });
    expect(repeated.statusCode).toBe(409);
    expect((await state()).rules).toHaveLength(1);
  }, 60_000);

  it("con el interruptor puesto, una regla activa corrige sola, respeta su tope y deja un lote reversible (E10.2, E10.4)", async () => {
    process.env["CRV_CURATION_AUTOFIX"] = "true";
    resetEnvCache();

    // Corre sola al terminar el análisis completo, no hace falta pedirlo.
    await runCurationScan({ trigger: "manual" });
    await waitForCurationScans();

    // El tope de la regla (1 por análisis) se respeta: queda uno sucio.
    const pending = await dirtyArtists();
    expect(pending).toHaveLength(1);
    const fixed = pending[0] === artistA ? artistB : artistA;
    expect(await nameOf("artists", fixed)).not.toContain(ZERO_WIDTH_SPACE);

    // El hallazgo se cierra como corregido por curaduría, no como «cambiado en otra parte».
    const invisible = await openFindings("caracteres_invisibles");
    expect(invisible.find((finding) => finding.entity_id === fixed)).toMatchObject({ status: "resolved", resolution: "fixed_by_curation" });
    expect(invisible.find((finding) => finding.entity_id === pending[0])).toMatchObject({ status: "open" });

    // Es un lote normal: modo auto, firmado por la autocorrección y con su deshacer.
    const [batch] = await rows<{ id: string; mode: string; status: string; requested_by: string; applied_by: string; counts: Record<string, number>; filter: Record<string, unknown> }>(
      "SELECT id::text, mode, status, requested_by, applied_by, counts, filter FROM ingest.curation_fix_batches WHERE mode = 'auto' ORDER BY id");
    expect(batch).toMatchObject({ mode: "auto", status: "done", requested_by: AUTOFIX_OPERATOR, applied_by: AUTOFIX_OPERATOR });
    expect(batch!.counts["applied"]).toBe(1);
    expect(batch!.filter).toMatchObject({ autofixRuleId: ruleId, detector: "caracteres_invisibles" });
    const [item] = await rows<{ run_id: string | null; status: string }>(
      "SELECT run_id::text, status FROM ingest.curation_fix_items WHERE batch_id = $1", [batch!.id]);
    expect(item).toMatchObject({ status: "applied" });
    expect(item!.run_id).not.toBeNull();

    const { report, events } = await state();
    expect(report).toMatchObject({ enabled: true, today: { batches: 1, applied: 1, undone: 0 }, alerts: [] });
    expect(report.batches[0]).toMatchObject({ batchId: Number(batch!.id), detector: "caracteres_invisibles", actionKey: "limpiar_texto", applied: 1, triggered: 0, undoneByBatchId: null });
    expect(events[0]).toMatchObject({ event: "applied", operator: AUTOFIX_OPERATOR, batchId: Number(batch!.id) });

    // Sin tope, la siguiente pasada termina el trabajo; la pasada manual aplica lo mismo.
    const patched = await app.inject({ method: "PATCH", url: `/curation/autofix/rules/${ruleId}`, headers, payload: { maxPerScan: null } });
    expect(patched.statusCode, patched.body).toBe(200);
    const run = await runNow();
    expect(run).toMatchObject({ status: "hecha", applied: 1 });
    expect(run.rules[0]).toMatchObject({ ruleId, applied: 1, failed: 0, triggered: 0, reverted: false });
    expect(await dirtyArtists()).toEqual([]);
    expect((await runNow()).status).toBe("sin_candidatos");
  }, 120_000);

  it("interruptor de emergencia: un lote que desencadena algo se deshace entero y apaga la regla (E10.3, E10.5)", async () => {
    // Una persona que en realidad es un estudio, con un invisible que hoy la
    // disfraza: al limpiarlo coincide exactamente con la organización y aparece
    // un hallazgo nuevo donde acabábamos de cerrar otro.
    await one("INSERT INTO public.organizations(name) VALUES('Estudios Sonoros QA') RETURNING id");
    personId = await one("INSERT INTO public.persons(name) VALUES($1) RETURNING id", [`Estudios Sonoros${ZERO_WIDTH_SPACE} QA`]);
    const album = await one("INSERT INTO public.albums(artist_id, title) VALUES($1, 'Sesiones QA') RETURNING id", [artistA]);
    await getPool().query("INSERT INTO public.album_credits(album_id, person_id, credit_type, role) VALUES($1, $2, 'recording', 'Grabación')", [album, personId]);

    const dirty = await nameOf("persons", personId);
    await runCurationScan({ trigger: "manual" });
    await waitForCurationScans();

    // El nombre volvió a como estaba: el lote entero se deshizo.
    expect(await nameOf("persons", personId)).toBe(dirty);

    const rule = (await state()).rules.find((item) => item.id === ruleId)!;
    expect(rule.enabled).toBe(false);
    expect(rule.disabledReason).toMatch(/se deshizo y la regla quedó apagada/u);
    expect(rule.disabledByBatchId).not.toBeNull();

    const { report, events } = await state();
    const culprit = report.batches.find((item) => item.batchId === rule.disabledByBatchId)!;
    expect(culprit).toMatchObject({ status: "undone", triggered: 1 });
    expect(culprit.undoneByBatchId).not.toBeNull();
    expect(report.alerts[0]).toMatchObject({ ruleId, detector: "caracteres_invisibles", actionKey: "limpiar_texto", batchId: rule.disabledByBatchId });
    expect(events.slice(0, 2).map((event) => event.event)).toEqual(["undone", "auto_disabled"]);
    expect(events[1]!.detail).toMatchObject({ triggered: 1, applied: 1, undone: true });

    // El hallazgo desencadenado quedó anotado con lo que lo hizo aparecer.
    const [triggered] = await rows<{ evidence: Record<string, unknown> }>(
      "SELECT evidence FROM ingest.curation_findings WHERE detector = 'persona_es_organizacion' AND entity_id = $1 AND signature = 'coincide_con_organizacion'", [personId]);
    expect(triggered?.evidence["triggeredBy"]).toBeDefined();

    // Y con la regla apagada, la autocorrección ya no vuelve a intentarlo.
    expect(await runNow()).toMatchObject({ status: "sin_reglas", applied: 0 });
  }, 120_000);
});
