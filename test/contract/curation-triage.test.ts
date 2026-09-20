// CRV · Triaje de Curaduría contra PostgreSQL real (PLAN_CURADURIA E8.5/E8.7).
//
// Dos piezas que la web necesita y la API no tenía:
//   * «Marcar como revisado» (M2): «surgidos tras corregir» solo crecía, porque
//     la marca `evidence.triggeredBy` era permanente y la única forma de
//     quitarla era cerrar el hallazgo, que es otra cosa. Darlo por revisado
//     mueve la marca a `triggeredHistory` —con quién y cuándo— y lo saca del
//     filtro `chained` sin cerrar nada.
//   * Historial de lotes (A8): `GET /curation/fixes`. Una vista previa que
//     nadie aplicó no escribió nada, así que no aparece salvo que se pida.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { buildApp } from "../../src/api/app.js";
import { runCurationScan, waitForCurationScans } from "../../src/curation/scan.js";

const TOKEN = "token-de-prueba-triaje-0123456789ab";
const OPERATOR = "Tester Triaje";
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

interface FindingRow { id: string; detector: string; status: string; evidence: Record<string, unknown> }

describe("triaje de Curaduría: revisado y historial de lotes (E8)", () => {
  let container: PgContainer;
  let app: FastifyInstance;
  let chainedArtist: number;
  let dirtyArtist: number;

  const headers = { authorization: `Bearer ${TOKEN}`, "x-crv-operator": OPERATOR };
  const one = async (sql: string, params: unknown[] = []): Promise<number> =>
    Number((await getPool().query<{ id: string }>(sql, params)).rows[0]!.id);
  const findingsOf = async (detector: string): Promise<FindingRow[]> =>
    (await getPool().query<FindingRow>(
      "SELECT id::text, detector, status, evidence FROM ingest.curation_findings WHERE detector = $1 ORDER BY id", [detector])).rows;

  /** Espera el análisis de verificación que dispara una escritura de la API. */
  async function waitForScan(trigger: string, afterId: number): Promise<number> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const { rows } = await getPool().query<{ id: string }>(
        "SELECT id::text FROM ingest.curation_scans WHERE trigger = $1 AND status = 'ok' AND id > $2 ORDER BY id DESC LIMIT 1", [trigger, afterId]);
      if (rows[0]) { await waitForCurationScans(); return Number(rows[0].id); }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`no llegó un análisis «${trigger}»`);
  }

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    process.env["CRV_OPERATOR_TOKEN"] = TOKEN;
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
    app = await buildApp();

    // Una ficha que al corregirse deja otro problema (el nombre gana la ciudad)
    // y otra con un defecto de texto que el marco de acciones sabe limpiar.
    chainedArtist = await one("INSERT INTO public.artists(name, origin_city) VALUES($1, 'Caracas') RETURNING id", [`Trueno${ZERO_WIDTH_SPACE} Negro`]);
    dirtyArtist = await one("INSERT INTO public.artists(name, origin_city) VALUES($1, 'Maracay') RETURNING id", [`Relámpago${ZERO_WIDTH_SPACE} Gris`]);
    const first = await runCurationScan({ trigger: "manual" });
    expect(first.status).toBe("ok");
  }, 120_000);

  afterAll(async () => { await app?.close(); await closeDb(); await container?.stop(); }, 60_000);

  it("un hallazgo surgido tras corregir se puede dar por revisado sin cerrarlo", async () => {
    const before = await one("SELECT coalesce(max(id), 0) AS id FROM ingest.curation_scans");
    const patched = await app.inject({ method: "PATCH", url: `/artists/${chainedArtist}`, headers, payload: { name: "Trueno Negro (Caracas)" } });
    expect(patched.statusCode).toBe(200);
    await waitForScan("correccion", before);

    const [region] = await findingsOf("aclaracion_en_nombre_de_artista");
    expect(region).toMatchObject({ status: "open" });
    expect(Array.isArray(region!.evidence["triggeredBy"])).toBe(true);

    const listed = await app.inject({ method: "GET", url: "/curation/findings?chained=true", headers });
    expect(listed.json().data.map((item: { id: number }) => item.id)).toContain(Number(region!.id));

    const acknowledged = await app.inject({ method: "POST", url: `/curation/findings/${region!.id}/acknowledge-chain`, headers });
    expect(acknowledged.statusCode).toBe(200);
    // Sigue abierto: revisarlo no es resolverlo.
    expect(acknowledged.json()).toMatchObject({ status: "open", triggeredBy: [] });

    const [after] = await findingsOf("aclaracion_en_nombre_de_artista");
    expect(after!.evidence["triggeredBy"]).toBeUndefined();
    expect(after!.evidence["triggeredInScan"]).toBeUndefined();
    const history = after!.evidence["triggeredHistory"] as Array<{ by: string; at: string; causes: unknown[] }>;
    expect(history).toHaveLength(1);
    expect(history[0]!.by).toBe(OPERATOR);
    expect(history[0]!.causes.length).toBeGreaterThanOrEqual(1);
    expect(new Date(history[0]!.at).toString()).not.toBe("Invalid Date");

    const again = await app.inject({ method: "GET", url: "/curation/findings?chained=true", headers });
    expect(again.json().data.map((item: { id: number }) => item.id)).not.toContain(Number(region!.id));

    // Repetirlo no tiene sentido: ya no hay marca que mover.
    const repeated = await app.inject({ method: "POST", url: `/curation/findings/${region!.id}/acknowledge-chain`, headers });
    expect(repeated.statusCode).toBe(400);
    expect(repeated.json().error.code).toBe("invalid");

    const missing = await app.inject({ method: "POST", url: "/curation/findings/999999999/acknowledge-chain", headers });
    expect(missing.statusCode).toBe(404);
  }, 60_000);

  it("«marcar todos como revisados» alcanza exactamente lo que cumple el filtro", async () => {
    // Otra ficha que vuelve a encadenar: se corrige por la API y aparece algo nuevo en ella.
    const artist = await one("INSERT INTO public.artists(name, origin_city) VALUES($1, 'Valencia') RETURNING id", [`Cardenal${ZERO_WIDTH_SPACE} Rojo`]);
    await runCurationScan({ trigger: "manual" });
    const before = await one("SELECT coalesce(max(id), 0) AS id FROM ingest.curation_scans");
    const patched = await app.inject({ method: "PATCH", url: `/artists/${artist}`, headers, payload: { name: "Cardenal Rojo (Valencia)" } });
    expect(patched.statusCode).toBe(200);
    await waitForScan("correccion", before);

    const chained = await app.inject({ method: "GET", url: "/curation/findings?chained=true", headers });
    expect(chained.json().pagination.total).toBeGreaterThanOrEqual(1);

    // Un filtro que no alcanza a nadie no toca nada.
    const other = await app.inject({
      method: "POST", url: "/curation/findings/acknowledge-chain-group", headers,
      payload: { detector: "caracteres_invisibles" },
    });
    expect(other.statusCode).toBe(200);
    expect(other.json().acknowledged).toBe(0);

    const all = await app.inject({ method: "POST", url: "/curation/findings/acknowledge-chain-group", headers, payload: {} });
    expect(all.statusCode).toBe(200);
    expect(all.json().acknowledged).toBeGreaterThanOrEqual(1);

    const empty = await app.inject({ method: "GET", url: "/curation/findings?chained=true", headers });
    expect(empty.json().pagination.total).toBe(0);
  }, 60_000);

  it("el historial lista los lotes aplicados y deja fuera las vistas previas que nadie aplicó", async () => {
    const dirty = (await findingsOf("caracteres_invisibles")).find((row) => row.status === "open");
    expect(dirty).toBeDefined();

    // Una vista previa abandonada: no escribió nada, así que no es historia.
    const abandoned = await app.inject({
      method: "POST", url: "/curation/fixes/preview", headers,
      payload: { mode: "individual", findingIds: [Number(dirty!.id)], actionKey: "limpiar_texto" },
    });
    expect(abandoned.statusCode).toBe(200);
    const abandonedId = abandoned.json().id as number;

    const preview = await app.inject({
      method: "POST", url: "/curation/fixes/preview", headers,
      payload: { mode: "individual", findingIds: [Number(dirty!.id)], actionKey: "limpiar_texto" },
    });
    expect(preview.statusCode).toBe(200);
    const batch = preview.json();
    const applied = await app.inject({
      method: "POST", url: `/curation/fixes/${batch.id}/apply`, headers,
      payload: { previewHash: batch.previewHash, note: "quitar el espacio de ancho cero" },
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().counts.applied).toBe(1);
    await waitForCurationScans();

    const history = await app.inject({ method: "GET", url: "/curation/fixes", headers });
    expect(history.statusCode).toBe(200);
    const ids = history.json().data.map((row: { id: number }) => row.id);
    expect(ids).toContain(batch.id);
    expect(ids).not.toContain(abandonedId);
    const row = history.json().data.find((item: { id: number }) => item.id === batch.id);
    expect(row).toMatchObject({ mode: "individual", requestedBy: OPERATOR, appliedBy: OPERATOR, itemCount: 1 });
    expect(row.counts.applied).toBe(1);
    expect(row.note).toBe("quitar el espacio de ancho cero");

    // Pedir el estado `previewed` sí las muestra.
    const previewed = await app.inject({ method: "GET", url: "/curation/fixes?status=previewed", headers });
    expect(previewed.json().data.map((item: { id: number }) => item.id)).toContain(abandonedId);

    // Deshacer es otro lote, y el historial enlaza los dos lados.
    const undone = await app.inject({ method: "POST", url: `/curation/fixes/${batch.id}/undo`, headers, payload: { note: "revertir la prueba" } });
    expect(undone.statusCode).toBe(200);
    const undoId = undone.json().id as number;
    await waitForCurationScans();

    const detail = await app.inject({ method: "GET", url: `/curation/fixes/${batch.id}`, headers });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().undoneByBatchId).toBe(undoId);

    const undoOnly = await app.inject({ method: "GET", url: "/curation/fixes?mode=undo", headers });
    const undoRows = undoOnly.json().data as Array<{ id: number; mode: string; undoOfBatchId: number }>;
    expect(undoRows.every((item) => item.mode === "undo")).toBe(true);
    expect(undoRows.find((item) => item.id === undoId)?.undoOfBatchId).toBe(batch.id);

    // La ficha volvió a su nombre sucio: deshacer restauró de verdad.
    const name = (await getPool().query<{ name: string }>("SELECT name FROM public.artists WHERE id = $1", [dirtyArtist])).rows[0]!.name;
    expect(name).toContain(ZERO_WIDTH_SPACE);
  }, 90_000);
});
