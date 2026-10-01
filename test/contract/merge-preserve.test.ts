// CRV · Fusionar sin perder datos (Brian, 2026-10-01): la biografía del
// duplicado se une y queda marcada para la IA, el dato corto que pierde va a
// las notas, «combinar» guarda el texto editado y deshacer lo devuelve todo.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { buildApp } from "../../src/api/app.js";
import { DeepSeekGateway, MemoryDeepSeekRunStore, MockDeepSeekTransport } from "../../src/ai/gateway.js";
import { rewritePending } from "../../src/merge/text-rewrite.js";

const TOKEN = "token-de-prueba-merge-preserve-0123456789";
const headers = { authorization: `Bearer ${TOKEN}`, "x-crv-operator": "Tester Preserve" };

describe("fusionar sin perder datos", () => {
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

  afterAll(async () => { await app?.close(); await closeDb(); await container?.stop(); }, 60_000);

  const one = async (sql: string, params: unknown[] = []): Promise<number> =>
    Number((await getPool().query<{ id: string }>(sql, params)).rows[0]!.id);
  const artist = async (id: number) =>
    (await getPool().query<{ biography: string | null; notes: string | null; origin_city: string | null; formed_year: number | null }>(
      "SELECT biography, notes, origin_city, formed_year FROM public.artists WHERE id=$1", [id])).rows[0]!;
  const pending = async (id: number) =>
    (await getPool().query<{ id: string; sources: Array<{ label: string; text: string }> }>(
      "SELECT id::text, sources FROM ingest.text_rewrites WHERE entity_kind='artist' AND entity_id=$1 AND status='pending'", [id])).rows;
  const merge = async (keep: number, drop: number, extra: Record<string, unknown> = {}) => {
    const preview = await app.inject({ method: "GET", url: `/artists/${keep}/merge-preview?with=${drop}`, headers });
    expect(preview.statusCode).toBe(200);
    const response = await app.inject({
      method: "POST", url: `/artists/${keep}/merge`, headers,
      payload: { dropId: drop, previewHash: preview.json().previewHash, keepDropNameAsAlias: true, note: "prueba preserve", ...extra },
    });
    expect(response.statusCode, response.body).toBe(200);
    return { preview: preview.json(), result: response.json() };
  };

  it("sin elegir: une las biografías, las marca para la IA y anota en notas el dato corto", async () => {
    const keep = await one(`INSERT INTO public.artists(name,biography,origin_city,formed_year)
      VALUES('Los Impala QA','Banda de Maracaibo formada en 1958.','Maracaibo',1958) RETURNING id`);
    const drop = await one(`INSERT INTO public.artists(name,biography,origin_city,formed_year,notes)
      VALUES('Los Impalas QA','Giró por Europa con The Hollies.','Caracas',1959,'nota del duplicado') RETURNING id`);

    const { preview, result } = await merge(keep, drop);
    expect(preview.combinableFields).toEqual(["biography"]);
    expect(result.rewritePending).toBe(true);
    expect(result.preserved).toEqual(expect.arrayContaining(["biography", "notes"]));

    const after = await artist(keep);
    expect(after.biography).toBe("Banda de Maracaibo formada en 1958.\n\nGiró por Europa con The Hollies.");
    expect(after.origin_city).toBe("Maracaibo");
    expect(after.notes).toContain("nota del duplicado");
    expect(after.notes).toMatch(/Al fusionar «Los Impalas QA» \(#\d+, [\d-]+\) quedó fuera — Ciudad: «Caracas»; Desde: 1959\./u);
    const marks = await pending(keep);
    expect(marks).toHaveLength(1);
    expect(marks[0]!.sources.map((source) => source.label)).toEqual(["Los Impala QA", "Los Impalas QA"]);

    const mark = await app.inject({ method: "GET", url: `/artists/${keep}/text-rewrites`, headers });
    expect(mark.json().pending).toEqual([expect.objectContaining({ field: "biography", sources: 2 })]);

    // Deshacer la fusión devuelve la ficha como estaba y retira la marca.
    const undo = await app.inject({ method: "POST", url: `/merge-runs/${result.runId}/undo`, headers, payload: { note: "deshacer prueba" } });
    expect(undo.statusCode, undo.body).toBe(200);
    expect(await artist(keep)).toMatchObject({ biography: "Banda de Maracaibo formada en 1958.", notes: null, origin_city: "Maracaibo" });
    expect(await pending(keep)).toHaveLength(0);
    expect(await artist(drop)).toMatchObject({ biography: "Giró por Europa con The Hollies.", origin_city: "Caracas" });
  });

  it("elegir el dato del duplicado manda a notas el de la que queda; combinar guarda el texto editado", async () => {
    const keep = await one(`INSERT INTO public.artists(name,biography,origin_city)
      VALUES('Ficha Combinar QA','Texto A.','the 1958 in Maracaibo') RETURNING id`);
    const drop = await one(`INSERT INTO public.artists(name,biography,origin_city)
      VALUES('Ficha Combinar QA (dup)','Texto B.','Maracaibo') RETURNING id`);
    const { result } = await merge(keep, drop, {
      fieldChoices: { biography: "combine", originCity: "drop" },
      combinedTexts: { biography: "Texto A y B, editado a mano." },
      rewriteLater: false,
    });
    expect(result.rewritePending).toBe(false);
    const after = await artist(keep);
    expect(after.biography).toBe("Texto A y B, editado a mano.");
    expect(after.origin_city).toBe("Maracaibo");
    expect(after.notes).toContain("Ciudad: «the 1958 in Maracaibo»");
    expect(await pending(keep)).toHaveLength(0);
  });

  it("combinar y marcar para después guarda los textos originales como fuentes", async () => {
    const keep = await one("INSERT INTO public.artists(name,biography) VALUES('Ficha Marca QA','Original A.') RETURNING id");
    const drop = await one("INSERT INTO public.artists(name,biography) VALUES('Ficha Marca QA (dup)','Original B.') RETURNING id");
    await merge(keep, drop, { fieldChoices: { biography: "combine" }, combinedTexts: { biography: "A + B a mano." }, rewriteLater: true });
    expect((await artist(keep)).biography).toBe("A + B a mano.");
    const marks = await pending(keep);
    expect(marks[0]!.sources.map((source) => source.text)).toEqual(["Original A.", "Original B."]);
  });

  it("elegir un lado de la biografía la descarta a propósito: ni unión ni marca", async () => {
    const keep = await one("INSERT INTO public.artists(name,biography) VALUES('Ficha Lado QA','Queda.') RETURNING id");
    const drop = await one("INSERT INTO public.artists(name,biography) VALUES('Ficha Lado QA (dup)','Se va.') RETURNING id");
    await merge(keep, drop, { fieldChoices: { biography: "keep" } });
    expect((await artist(keep)).biography).toBe("Queda.");
    expect(await pending(keep)).toHaveLength(0);
  });

  it("la cola: una segunda fusión amplía las fuentes y la IA escribe el texto en un run", async () => {
    const keep = await one("INSERT INTO public.artists(name,biography) VALUES('Ficha Cola QA','Formada en 1990 en Valencia.') RETURNING id");
    const dropOne = await one("INSERT INTO public.artists(name,biography) VALUES('Ficha Cola QA 2','Grabó su primer disco en 1992.') RETURNING id");
    const dropTwo = await one("INSERT INTO public.artists(name,biography) VALUES('Ficha Cola QA 3','Tocó en el Festival Nuevas Bandas.') RETURNING id");
    await merge(keep, dropOne);
    await merge(keep, dropTwo);
    const marks = await pending(keep);
    expect(marks).toHaveLength(1);
    expect(marks[0]!.sources).toHaveLength(3);

    const unified = "Ficha Cola QA se formó en 1990 en Valencia. Grabó su primer disco en 1992 y tocó en el Festival Nuevas Bandas.";
    const gateway = new DeepSeekGateway(
      { baseUrl: "http://mock", models: { fast: "deepseek-flash", reasoning: "r", vision: "v" }, maxTokens: 1000, timeoutMs: 1000 },
      new MockDeepSeekTransport({ text: unified }), new MemoryDeepSeekRunStore());
    const dry = await rewritePending({ gateway, confirm: false, ids: [Number(marks[0]!.id)], note: "prueba" });
    expect(dry.samples[0]!.text).toBe(unified);
    expect((await artist(keep)).biography).not.toBe(unified);

    const gatewayConfirm = new DeepSeekGateway(
      { baseUrl: "http://mock", models: { fast: "deepseek-flash", reasoning: "r", vision: "v" }, maxTokens: 1000, timeoutMs: 1000 },
      new MockDeepSeekTransport({ text: unified }), new MemoryDeepSeekRunStore());
    const report = await rewritePending({ gateway: gatewayConfirm, confirm: true, ids: [Number(marks[0]!.id)], note: "prueba" });
    expect(report.written).toBe(1);
    expect((await artist(keep)).biography).toBe(unified);
    expect(await pending(keep)).toHaveLength(0);
    const claim = (await getPool().query<{ created_by: string; run_id: string }>(
      "SELECT created_by, run_id::text FROM ingest.claims WHERE artist_id=$1 AND field='biography' AND status='accepted'", [keep])).rows;
    expect(claim).toEqual([{ created_by: "ai", run_id: String(report.runId) }]);
  });
});
