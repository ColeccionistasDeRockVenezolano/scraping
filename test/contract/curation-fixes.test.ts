// CRV · Marco de acciones de corrección de Curaduría contra PostgreSQL real
// (PLAN_CURADURIA E4): toda corrección es un lote con vista previa → aplicar →
// verificar → deshacer.
//
// Contratos de la etapa:
//  - vista previa → aplicar → deshacer deja la instantánea idéntica (A8), también
//    cuando la corrección es una fusión;
//  - hash cambiado → 409 y nada escrito;
//  - un ítem que queda obsoleto en medio del lote → `skipped_stale` y el resto aplicado;
//  - renombrar un artista al nombre exacto de otro → bloqueo y propuesta de fusión (M6).
// Además: el enlace con los runs (M1), el tope por llamada con continuación
// explícita, el nivel que admite cada modo y un deshacer que no pisa cambios posteriores.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { buildApp } from "../../src/api/app.js";
import { runCurationScan, waitForCurationScans } from "../../src/curation/scan.js";
import { cleanTextAction } from "../../src/curation/actions/text.js";

const TOKEN = "token-de-prueba-correcciones-0123456789";
const OPERATOR = "Tester Correcciones";
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

interface ItemView {
  id: number; position: number; findingId: number | null; actionKey: string | null; level: number | null; params: Record<string, unknown>;
  status: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; touched: Array<{ kind: string; id: number }>;
  blocked: { code: string; message: string } | null; collisions: Array<{ kind: string; id: number; label: string; exact: boolean }>;
  proposal: { actionKey: string; params: Record<string, unknown>; reason: string } | null; runId: number | null;
  undoOfItemId: number | null; errorCode: string | null; error: string | null;
}

interface BatchView {
  id: number; mode: string; status: string; previewHash: string; counts: Record<string, unknown>; verification: Record<string, unknown> | null;
  appliedBy: string | null; note: string | null; undoOfBatchId: number | null; undoneByBatchId: number | null; items: ItemView[];
  pagination: { total: number };
}

describe("marco de acciones de corrección de Curaduría (E4)", () => {
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

  afterAll(async () => { await waitForCurationScans(); await app?.close(); await closeDb(); await container.stop(); }, 60_000);

  const headers = { authorization: `Bearer ${TOKEN}`, "x-crv-operator": OPERATOR };
  const one = async (sql: string, params: unknown[] = []): Promise<number> =>
    Number((await getPool().query<{ id: string }>(sql, params)).rows[0]!.id);
  const rows = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    (await getPool().query<T>(sql, params)).rows;
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");

  async function openFinding(detector: string, kind: string, entityId: number): Promise<number> {
    const found = await rows<{ id: string }>(
      "SELECT id::text FROM ingest.curation_findings WHERE detector = $1 AND entity_kind = $2 AND entity_id = $3 AND status = 'open'",
      [detector, kind, entityId]);
    expect(found).toHaveLength(1);
    return Number(found[0]!.id);
  }

  const nameOf = async (table: "artists" | "organizations", id: number): Promise<string | undefined> =>
    (await rows<{ name: string }>(`SELECT name FROM public.${table} WHERE id = $1`, [id]))[0]?.name;

  async function preview(payload: Record<string, unknown>): Promise<BatchView> {
    const response = await app.inject({ method: "POST", url: "/curation/fixes/preview?limit=200", headers, payload });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }

  const apply = (batchId: number, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/curation/fixes/${batchId}/apply?limit=200`, headers, payload });
  const undo = (batchId: number, note: string) =>
    app.inject({ method: "POST", url: `/curation/fixes/${batchId}/undo?limit=200`, headers, payload: { note } });

  async function batch(batchId: number, query = ""): Promise<BatchView> {
    const response = await app.inject({ method: "GET", url: `/curation/fixes/${batchId}?limit=200${query}`, headers });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }

  it("las acciones de un hallazgo traen parámetros por defecto, nivel, deshacer y precondiciones", async () => {
    const org = await one("INSERT INTO public.organizations(name) VALUES($1) RETURNING id", [`Disquera${ZERO_WIDTH_SPACE} Alba QA`]);
    expect((await runCurationScan({ trigger: "manual" })).status).toBe("ok");
    const findingId = await openFinding("caracteres_invisibles", "organization", org);

    const response = await app.inject({ method: "GET", url: `/curation/findings/${findingId}/actions`, headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      findingId, status: "open",
      actions: [{
        key: "limpiar_texto", label: expect.any(String), description: expect.any(String), level: 0, inverse: "field_restore",
        recommended: true, params: { field: "name", cleanup: "invisibles" }, available: true,
        preconditions: expect.arrayContaining([{ key: "valor_detectado", ok: true }]),
      }],
    });
    // El listado también dice qué acciones tiene cada hallazgo.
    const read = await app.inject({ method: "GET", url: `/curation/findings/${findingId}`, headers });
    expect(read.json().actions).toEqual([{ key: "limpiar_texto", label: expect.any(String), level: 0 }]);

    expect((await app.inject({ method: "GET", url: "/curation/findings/999999999/actions", headers })).statusCode).toBe(404);
  }, 60_000);

  it("vista previa → aplicar → deshacer deja la instantánea idéntica, con claims, conflicto, revisión y alias (A8)", async () => {
    const sourceId = await one("INSERT INTO ingest.sources(slug,name,site_type,trust_level,enabled) VALUES('fixes-fixture','Fixes fixture','website','high',true) RETURNING id");
    const dirty = `Niebla${ZERO_WIDTH_SPACE} Roja QA`;
    const rivalName = "Niebla Roja (Maracay) QA";
    const artist = await one("INSERT INTO public.artists(name, origin_city) VALUES($1, 'Maracay') RETURNING id", [dirty]);
    const album = await one("INSERT INTO public.albums(artist_id, title) VALUES($1, 'Bruma Baja QA') RETURNING id", [artist]);
    await one("INSERT INTO public.tracks(album_id, track_number, title) VALUES($1, 1, 'Calle Mojada QA') RETURNING id", [album]);
    await one("INSERT INTO ingest.artist_aliases(artist_id, alias, normalized_alias, is_primary) VALUES($1, $2, 'niebla roja qa', true) RETURNING id", [artist, dirty]);
    const claim = (value: string) => one(`
      INSERT INTO ingest.claims(source_id, entity_kind, artist_id, field, raw_value, raw_hash, status, confidence)
      VALUES($1, 'artist', $2, 'name', to_jsonb($3::text), $4, 'conflict', 'medium') RETURNING id`, [sourceId, artist, value, sha(`${artist}:${value}`)]);
    const current = await claim(dirty);
    const rival = await claim(rivalName);
    const conflict = await one(`
      INSERT INTO ingest.conflicts(claim_a_id, claim_b_id, entity_kind, field, value_a, value_b)
      VALUES($1, $2, 'artist', 'name', to_jsonb($3::text), to_jsonb($4::text)) RETURNING id`, [current, rival, dirty, rivalName]);
    const review = await one(`
      INSERT INTO ingest.review_queue(kind, conflict_id, claim_a_id, claim_b_id, notes)
      VALUES('field_conflict', $1, $2, $3, 'nombre en disputa') RETURNING id`, [conflict, current, rival]);

    expect((await runCurationScan({ trigger: "manual" })).status).toBe("ok");
    const findingId = await openFinding("caracteres_invisibles", "artist", artist);
    const lastClaim = await one("SELECT max(id) AS id FROM ingest.claims");

    /** Lo que una corrección de nombre toca; la auditoría y los runs no entran (solo crecen, a propósito). */
    async function snapshot() {
      return {
        artists: await rows("SELECT to_jsonb(a) - 'updated_at' - 'created_at' AS row FROM public.artists a ORDER BY a.id"),
        albums: await rows("SELECT to_jsonb(a) - 'updated_at' - 'created_at' AS row FROM public.albums a ORDER BY a.id"),
        tracks: await rows("SELECT to_jsonb(t) - 'updated_at' - 'created_at' AS row FROM public.tracks t ORDER BY t.id"),
        aliases: await rows("SELECT to_jsonb(a) - 'created_at' AS row FROM ingest.artist_aliases a ORDER BY a.id"),
        // Los claims que ya existían (los de la corrección quedan como historia: los claims no se borran).
        claims: await rows("SELECT to_jsonb(c) - 'updated_at' AS row FROM ingest.claims c WHERE c.id <= $1 ORDER BY c.id", [lastClaim]),
        conflicts: await rows("SELECT to_jsonb(c) AS row FROM ingest.conflicts c ORDER BY c.id"),
        // `updated_at` es el sello de quien toca la revisión (también al restaurarla).
        reviews: await rows("SELECT to_jsonb(r) - 'updated_at' AS row FROM ingest.review_queue r ORDER BY r.id"),
        redirects: await rows("SELECT entity_kind, from_id, to_id FROM ingest.entity_redirects ORDER BY entity_kind, from_id"),
      };
    }
    const before = await snapshot();

    const plan = await preview({ mode: "individual", findingIds: [findingId] });
    expect(plan).toMatchObject({ mode: "individual", status: "previewed", counts: { items: 1, pending: 1, blocked: 0 } });
    expect(plan.previewHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(plan.items[0]).toMatchObject({
      findingId, status: "pending", actionKey: "limpiar_texto", level: 0,
      before: { field: "name", value: dirty }, after: { field: "name", value: "Niebla Roja QA" }, touched: [{ kind: "artist", id: artist }],
    });
    // La vista previa no escribe nada.
    expect(await snapshot()).toEqual(before);

    // Sin nota no se aplica.
    expect((await apply(plan.id, { previewHash: plan.previewHash })).statusCode).toBe(400);
    const applied = await apply(plan.id, { previewHash: plan.previewHash, note: "quitar el espacio de ancho cero" });
    expect(applied.statusCode, applied.body).toBe(200);
    const done: BatchView = applied.json();
    expect(done).toMatchObject({ status: "done", appliedBy: OPERATOR, note: "quitar el espacio de ancho cero", counts: { applied: 1, pending: 0 } });
    const item = done.items[0]!;
    expect(item).toMatchObject({ status: "applied", runId: expect.any(Number) });
    expect(await nameOf("artists", artist)).toBe("Niebla Roja QA");
    // Un run por ítem, con la acción en el nombre y la nota de quien aplicó.
    expect((await rows("SELECT params->>'action' AS action, params->>'operator' AS operator, params->>'note' AS note FROM ingest.scrape_runs WHERE id = $1", [item.runId]))[0])
      .toEqual({ action: "api:curation:fix:limpiar_texto", operator: OPERATOR, note: "quitar el espacio de ancho cero" });
    // Lo que el motor hizo alrededor del nombre: claims sustituidos, conflicto y revisión cerrados, alias nuevo.
    expect(await rows("SELECT status::text FROM ingest.claims WHERE id = ANY($1::bigint[]) ORDER BY id", [[current, rival]]))
      .toEqual([{ status: "superseded" }, { status: "superseded" }]);
    expect((await rows<{ status: string }>("SELECT status::text FROM ingest.conflicts WHERE id = $1", [conflict]))[0]!.status).not.toBe("open");
    expect((await rows("SELECT status::text FROM ingest.review_queue WHERE id = $1", [review]))[0]).toEqual({ status: "approved" });
    expect(await rows("SELECT alias FROM ingest.artist_aliases WHERE artist_id = $1 ORDER BY id", [artist])).toEqual([{ alias: dirty }, { alias: "Niebla Roja QA" }]);

    // Verificación dirigida: el hallazgo queda corregido desde Curaduría con el run de su ítem (M1), y el lote lo cuenta.
    await waitForCurationScans();
    expect((await rows("SELECT status, resolution, resolved_by_run_id::text AS run FROM ingest.curation_findings WHERE id = $1", [findingId]))[0])
      .toEqual({ status: "resolved", resolution: "fixed_by_curation", run: String(item.runId) });
    const verified = await batch(plan.id);
    expect(verified.verification).toMatchObject({
      status: "done", fixedByCuration: 1, resolved: [expect.objectContaining({ id: findingId, resolution: "fixed_by_curation" })],
    });
    const scans = await rows<{ scope: string; trigger: string }>(
      "SELECT scope, trigger FROM ingest.curation_scans WHERE id = $1", [(verified.verification!["scans"] as Array<{ scanId: number }>)[0]!.scanId]);
    expect(scans).toEqual([{ scope: "dirigido", trigger: "correccion" }]);

    // Un lote aplicado no se vuelve a aplicar.
    const again = await apply(plan.id, { previewHash: plan.previewHash, note: "otra vez" });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: "not_open" } });

    expect((await undo(plan.id, "")).statusCode).toBe(400);
    const undone = await undo(plan.id, "deshacer la limpieza de prueba");
    expect(undone.statusCode, undone.body).toBe(200);
    const reverse: BatchView = undone.json();
    expect(reverse).toMatchObject({ mode: "undo", status: "done", undoOfBatchId: plan.id, counts: { applied: 1 } });
    expect(reverse.items[0]).toMatchObject({
      status: "applied", undoOfItemId: item.id, before: { value: "Niebla Roja QA" }, after: { value: dirty }, runId: expect.any(Number),
    });
    expect(reverse.items[0]!.runId).not.toBe(item.runId);

    // A8: la misma instantánea, byte a byte (el nombre vuelve con su invisible: deshacer no normaliza).
    expect(await snapshot()).toEqual(before);
    expect(await nameOf("artists", artist)).toBe(dirty);
    // Los claims de la corrección no se borran: quedan sustituidos con la nota del deshacer.
    const created = await rows<{ status: string; notes: string | null }>("SELECT status::text, notes FROM ingest.claims WHERE id > $1", [lastClaim]);
    expect(created.length).toBeGreaterThan(0);
    for (const row of created) expect(row).toEqual({ status: "superseded", notes: expect.stringContaining("deshecho por el run") });
    expect(await batch(plan.id)).toMatchObject({ status: "undone", undoneByBatchId: reverse.id, items: [expect.objectContaining({ id: item.id, status: "undone" })] });

    // La verificación del deshacer reabre el hallazgo; un deshacer no cuenta como corrección.
    await waitForCurationScans();
    expect((await rows("SELECT status, resolution FROM ingest.curation_findings WHERE id = $1", [findingId]))[0]).toEqual({ status: "open", resolution: null });
    expect((await batch(reverse.id)).verification).toMatchObject({ status: "done", appearedCount: 1, fixedByCuration: 0 });

    // Ni se deshace dos veces, ni se deshace un deshacer.
    expect((await undo(plan.id, "otra vez")).json()).toMatchObject({ error: { code: "not_open" } });
    expect((await undo(reverse.id, "deshacer el deshacer")).json()).toMatchObject({ error: { code: "not_open" } });
  }, 90_000);

  it("hash cambiado → 409 sin escribir nada; excluyendo lo que cambió se aplica el resto", async () => {
    const south = await one("INSERT INTO public.organizations(name) VALUES($1) RETURNING id", [`Viento${ZERO_WIDTH_SPACE} Sur QA`]);
    const north = await one("INSERT INTO public.organizations(name) VALUES($1) RETURNING id", [`Viento${ZERO_WIDTH_SPACE} Norte QA`]);
    expect((await runCurationScan({ trigger: "manual" })).status).toBe("ok");
    const findings = [await openFinding("caracteres_invisibles", "organization", south), await openFinding("caracteres_invisibles", "organization", north)];
    const plan = await preview({ mode: "selected", findingIds: findings });
    expect(plan.counts).toMatchObject({ items: 2, pending: 2 });
    const [southItem, northItem] = plan.items;

    // Un hash que no es el de esta vista previa.
    const forged = await apply(plan.id, { previewHash: "0".repeat(64), note: "hash de otra vista previa" });
    expect(forged.statusCode).toBe(409);
    expect(forged.json()).toMatchObject({ error: { code: "stale_preview" } });

    // La ficha cambia entre la vista previa y aplicar: el hash de la vista previa ya no es el que da el catálogo.
    await getPool().query("UPDATE public.organizations SET name = 'Viento Sur Editado QA' WHERE id = $1", [south]);
    const changed = await apply(plan.id, { previewHash: plan.previewHash, note: "limpiar los dos" });
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toMatchObject({ error: { code: "stale_preview", details: { changed: 1, changedItemIds: [southItem!.id] } } });
    // Nada escrito: ni la otra ficha, ni el lote.
    expect(await nameOf("organizations", north)).toBe(`Viento${ZERO_WIDTH_SPACE} Norte QA`);
    expect(await batch(plan.id)).toMatchObject({
      status: "previewed", appliedBy: null, note: null,
      items: [expect.objectContaining({ status: "pending", runId: null }), expect.objectContaining({ status: "pending", runId: null })],
    });

    // Excluir lo que cambió y aplicar el resto con el mismo hash.
    const rest = await apply(plan.id, { previewHash: plan.previewHash, excludeItemIds: [southItem!.id], note: "limpiar solo el que no cambió" });
    expect(rest.statusCode, rest.body).toBe(200);
    expect(rest.json()).toMatchObject({ status: "done", counts: { applied: 1, excluded: 1 } });
    expect(await nameOf("organizations", north)).toBe("Viento Norte QA");
    expect(await nameOf("organizations", south)).toBe("Viento Sur Editado QA");
    expect((await batch(plan.id, "&status=excluded")).items.map((item) => item.id)).toEqual([southItem!.id]);
    expect((await batch(plan.id, "&status=applied")).items.map((item) => item.id)).toEqual([northItem!.id]);
    await waitForCurationScans();
  }, 60_000);

  it("un ítem que queda obsoleto en medio del lote → skipped_stale y el resto se aplica", async () => {
    const names = ["Uno", "Dos", "Tres"].map((word) => `Sello${ZERO_WIDTH_SPACE} ${word} QA`);
    const orgs: number[] = [];
    for (const name of names) orgs.push(await one("INSERT INTO public.organizations(name) VALUES($1) RETURNING id", [name]));
    expect((await runCurationScan({ trigger: "manual" })).status).toBe("ok");
    const findings: number[] = [];
    for (const org of orgs) findings.push(await openFinding("caracteres_invisibles", "organization", org));
    const plan = await preview({ mode: "selected", findingIds: findings });
    expect(plan.items.map((item) => item.findingId)).toEqual(findings);

    // Mientras se aplica el primer ítem, alguien edita la ficha del segundo por fuera de Curaduría.
    const original = cleanTextAction.apply.bind(cleanTextAction);
    const spy = vi.spyOn(cleanTextAction, "apply").mockImplementation(async (context, finding, params, itemPreview) => {
      const outcome = await original(context, finding, params, itemPreview);
      if (finding.entity.id === orgs[0]) await getPool().query("UPDATE public.organizations SET name = 'Sello Dos A Mano QA' WHERE id = $1", [orgs[1]]);
      return outcome;
    });
    let response;
    try {
      response = await apply(plan.id, { previewHash: plan.previewHash, note: "limpiar los tres sellos" });
    } finally {
      spy.mockRestore();
    }
    expect(response.statusCode, response.body).toBe(200);
    const result: BatchView = response.json();
    expect(result).toMatchObject({ status: "partial", counts: { applied: 2, skippedStale: 1, failed: 0, pending: 0 } });
    expect(result.items.map((item) => [item.findingId, item.status, item.errorCode])).toEqual([
      [findings[0], "applied", null], [findings[1], "skipped_stale", "stale"], [findings[2], "applied", null],
    ]);
    expect(result.items[1]!.runId).toBeNull();
    expect(await nameOf("organizations", orgs[0]!)).toBe("Sello Uno QA");
    expect(await nameOf("organizations", orgs[1]!)).toBe("Sello Dos A Mano QA");
    expect(await nameOf("organizations", orgs[2]!)).toBe("Sello Tres QA");
    // El ítem obsoleto no dejó run ni auditoría.
    expect(await rows("SELECT 1 FROM ingest.merge_audit WHERE organization_id = $1", [orgs[1]])).toEqual([]);

    // Deshacer revierte lo aplicado, en orden inverso, y no toca el obsoleto.
    const undone = await undo(plan.id, "deshacer los sellos");
    expect(undone.statusCode, undone.body).toBe(200);
    const reverse: BatchView = undone.json();
    expect(reverse.items.map((item) => item.undoOfItemId)).toEqual([result.items[2]!.id, result.items[0]!.id]);
    expect(reverse).toMatchObject({ status: "done", counts: { applied: 2 } });
    expect(await nameOf("organizations", orgs[0]!)).toBe(names[0]);
    expect(await nameOf("organizations", orgs[1]!)).toBe("Sello Dos A Mano QA");
    expect(await nameOf("organizations", orgs[2]!)).toBe(names[2]);
    expect((await batch(plan.id)).items.map((item) => item.status)).toEqual(["undone", "skipped_stale", "undone"]);
    await waitForCurationScans();
  }, 60_000);

  it("si un hallazgo se cierra mientras espera su turno, queda skipped_stale y no escribe su ficha", async () => {
    const names = ["A", "B"].map((word) => `Archivo${ZERO_WIDTH_SPACE} ${word} QA`);
    const orgs: number[] = [];
    for (const name of names) orgs.push(await one("INSERT INTO public.organizations(name) VALUES($1) RETURNING id", [name]));
    expect((await runCurationScan({ trigger: "manual" })).status).toBe("ok");
    const findings = await Promise.all(orgs.map((org) => openFinding("caracteres_invisibles", "organization", org)));
    const plan = await preview({ mode: "selected", findingIds: findings });

    // La persona revisa y cierra el segundo hallazgo mientras el primero ya se
    // está aplicando. El lote no puede usar el estado que leyó al previsualizar.
    const original = cleanTextAction.apply.bind(cleanTextAction);
    const spy = vi.spyOn(cleanTextAction, "apply").mockImplementation(async (context, finding, params, itemPreview) => {
      const outcome = await original(context, finding, params, itemPreview);
      if (finding.id === findings[0]) {
        await getPool().query(`
          UPDATE ingest.curation_findings
             SET status = 'ignored', ignored_at = now(), ignored_by = 'QA', ignore_reason = 'falso_positivo'
           WHERE id = $1`, [findings[1]]);
      }
      return outcome;
    });
    let response;
    try {
      response = await apply(plan.id, { previewHash: plan.previewHash, note: "limpiar solo lo que sigue abierto" });
    } finally {
      spy.mockRestore();
    }

    expect(response.statusCode, response.body).toBe(200);
    expect((response.json() as BatchView)).toMatchObject({
      status: "partial", counts: { applied: 1, skippedStale: 1 },
      items: [
        { findingId: findings[0], status: "applied" },
        { findingId: findings[1], status: "skipped_stale", errorCode: "not_open" },
      ],
    });
    expect(await nameOf("organizations", orgs[0]!)).toBe("Archivo A QA");
    expect(await nameOf("organizations", orgs[1]!)).toBe(names[1]);
    expect(await rows("SELECT 1 FROM ingest.merge_audit WHERE organization_id = $1", [orgs[1]])).toEqual([]);
    await waitForCurationScans();
  }, 60_000);

  it("aplica hasta CRV_CURATION_FIX_BATCH_MAX por llamada; otra llamada explícita continúa", async () => {
    const orgs: number[] = [];
    for (const word of ["Norte", "Sur", "Este", "Oeste"]) {
      orgs.push(await one("INSERT INTO public.organizations(name) VALUES($1) RETURNING id", [`Radio${ZERO_WIDTH_SPACE} ${word} QA`]));
    }
    expect((await runCurationScan({ trigger: "manual" })).status).toBe("ok");
    const findings: number[] = [];
    for (const org of orgs) findings.push(await openFinding("caracteres_invisibles", "organization", org));
    const plan = await preview({ mode: "selected", findingIds: findings });

    process.env["CRV_CURATION_FIX_BATCH_MAX"] = "2";
    resetEnvCache();
    try {
      const first = await apply(plan.id, { previewHash: plan.previewHash, note: "radios, primera tanda" });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toMatchObject({ status: "running", counts: { applied: 2, pending: 2 } });
      expect(await nameOf("organizations", orgs[2]!)).toBe(`Radio${ZERO_WIDTH_SPACE} Este QA`);

      // Entre una llamada y otra, alguien edita una ficha que falta: en medio del lote, obsoleto y el resto sigue.
      await getPool().query("UPDATE public.organizations SET name = 'Radio Este Renombrada QA' WHERE id = $1", [orgs[2]]);
      const second = await apply(plan.id, { previewHash: plan.previewHash, note: "radios, segunda tanda" });
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json()).toMatchObject({ status: "partial", note: "radios, primera tanda", counts: { applied: 3, skippedStale: 1, pending: 0 } });
      expect(await nameOf("organizations", orgs[3]!)).toBe("Radio Oeste QA");
      expect(await nameOf("organizations", orgs[2]!)).toBe("Radio Este Renombrada QA");

      // Terminado, no hay continuación posible.
      expect((await apply(plan.id, { previewHash: plan.previewHash, note: "tercera" })).json()).toMatchObject({ error: { code: "not_open" } });
    } finally {
      delete process.env["CRV_CURATION_FIX_BATCH_MAX"];
      resetEnvCache();
    }
    await waitForCurationScans();
  }, 60_000);

  it("limpiar un artista hasta el nombre exacto de otro propone fusionar; la fusión se aplica y se deshace (M6)", async () => {
    const clean = await one("INSERT INTO public.artists(name, origin_city) VALUES('Marea Alta QA', 'Barquisimeto') RETURNING id");
    const dirty = `Marea${ZERO_WIDTH_SPACE} Alta QA`;
    const duplicate = await one("INSERT INTO public.artists(name) VALUES($1) RETURNING id", [dirty]);
    const album = await one("INSERT INTO public.albums(artist_id, title) VALUES($1, 'Oleaje QA') RETURNING id", [duplicate]);
    // Las dos fichas tienen alias primario: la fusión deja secundario el del duplicado y deshacerla lo devuelve.
    await one("INSERT INTO ingest.artist_aliases(artist_id, alias, normalized_alias, is_primary) VALUES($1, 'Marea Alta QA', 'marea alta qa', true) RETURNING id", [clean]);
    await one("INSERT INTO ingest.artist_aliases(artist_id, alias, normalized_alias, is_primary) VALUES($1, 'La Marea Alta QA', 'la marea alta qa', true) RETURNING id", [duplicate]);
    expect((await runCurationScan({ trigger: "manual" })).status).toBe("ok");
    const findingId = await openFinding("caracteres_invisibles", "artist", duplicate);

    const renaming = await preview({ mode: "individual", findingIds: [findingId] });
    expect(renaming.counts).toMatchObject({ items: 1, pending: 0, blocked: 1 });
    const blocked = renaming.items[0]!;
    expect(blocked).toMatchObject({
      status: "blocked", errorCode: "collision", actionKey: "limpiar_texto",
      blocked: { code: "collision" },
      collisions: [{ kind: "artist", id: clean, label: "Marea Alta QA", exact: true }],
      proposal: { actionKey: "fusionar", params: { kind: "artist", keepId: clean, dropId: duplicate } },
    });
    // Nada que aplicar en ese lote: renombrar fallaría por `artists.name` UNIQUE.
    const refused = await apply(renaming.id, { previewHash: renaming.previewHash, note: "renombrar" });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ error: { code: "not_fixable" } });
    expect(await nameOf("artists", duplicate)).toBe(dirty);

    async function snapshot() {
      return {
        artists: await rows("SELECT to_jsonb(a) - 'updated_at' - 'created_at' AS row FROM public.artists a ORDER BY a.id"),
        albums: await rows("SELECT to_jsonb(a) - 'updated_at' - 'created_at' AS row FROM public.albums a ORDER BY a.id"),
        aliases: await rows("SELECT to_jsonb(a) - 'created_at' AS row FROM ingest.artist_aliases a ORDER BY a.id"),
        redirects: await rows("SELECT entity_kind, from_id, to_id FROM ingest.entity_redirects ORDER BY entity_kind, from_id"),
      };
    }
    const before = await snapshot();

    // La propuesta, tal cual, como corrección individual.
    const merging = await preview({ mode: "individual", findingIds: [findingId], actionKey: blocked.proposal!.actionKey, overrides: { params: blocked.proposal!.params } });
    expect(merging.items[0]).toMatchObject({
      status: "pending", actionKey: "fusionar", level: 1,
      after: { keep: { id: clean, name: "Marea Alta QA" }, removed: { id: duplicate, name: dirty }, nameAsAlias: dirty },
    });
    expect(merging.items[0]!.touched).toEqual(expect.arrayContaining([{ kind: "artist", id: clean }, { kind: "artist", id: duplicate }]));
    const merged = await apply(merging.id, { previewHash: merging.previewHash, note: "es la misma banda con un invisible en el nombre" });
    expect(merged.statusCode, merged.body).toBe(200);
    const mergeItem = (merged.json() as BatchView).items[0]!;
    expect(mergeItem).toMatchObject({ status: "applied", runId: expect.any(Number) });
    expect(await nameOf("artists", duplicate)).toBeUndefined();
    expect((await rows("SELECT artist_id::text FROM public.albums WHERE id = $1", [album]))[0]).toEqual({ artist_id: String(clean) });
    expect(await rows("SELECT to_id::text FROM ingest.entity_redirects WHERE entity_kind = 'artist' AND from_id = $1", [duplicate])).toEqual([{ to_id: String(clean) }]);
    expect(await rows("SELECT alias, is_primary FROM ingest.artist_aliases WHERE artist_id = $1 ORDER BY alias", [clean])).toEqual([
      { alias: "La Marea Alta QA", is_primary: false }, { alias: "Marea Alta QA", is_primary: true }, { alias: dirty, is_primary: false },
    ]);

    // La ficha retirada por la fusión resuelve su hallazgo como corrección de Curaduría, con el run de la fusión (M1).
    await waitForCurationScans();
    expect((await rows("SELECT status, resolution, resolved_by_run_id::text AS run FROM ingest.curation_findings WHERE id = $1", [findingId]))[0])
      .toEqual({ status: "resolved", resolution: "fixed_by_curation", run: String(mergeItem.runId) });

    const undone = await undo(merging.id, "no eran la misma banda");
    expect(undone.statusCode, undone.body).toBe(200);
    expect(undone.json()).toMatchObject({ mode: "undo", status: "done", counts: { applied: 1 } });
    expect(await snapshot()).toEqual(before);
    expect(await nameOf("artists", duplicate)).toBe(dirty);
    await waitForCurationScans();
    expect((await rows("SELECT status FROM ingest.curation_findings WHERE id = $1", [findingId]))[0]).toEqual({ status: "open" });
  }, 90_000);

  it("un grupo solo aplica nivel ≤ 1; la misma fusión de nivel 2 sí se previsualiza en una selección (§2.1.5)", async () => {
    const withArticle = await one("INSERT INTO public.artists(name) VALUES('Los Relampagos QA') RETURNING id");
    const bare = await one("INSERT INTO public.artists(name) VALUES('Relampagos QA') RETURNING id");
    expect((await runCurationScan({ trigger: "manual" })).status).toBe("ok");
    const pair = JSON.stringify([Math.min(withArticle, bare), Math.max(withArticle, bare)]);
    const [finding] = await rows<{ id: string; signature: string }>(
      "SELECT id::text, signature FROM ingest.curation_findings WHERE detector = 'artistas_equivalentes' AND evidence->'pair' = $1::jsonb AND status = 'open'", [pair]);
    expect(finding).toMatchObject({ signature: "sin_articulo_o_espacios" });

    const group = await preview({
      mode: "group", filter: { category: "fichas_repetidas", detector: "artistas_equivalentes", signature: "sin_articulo_o_espacios" },
    });
    const groupItem = group.items.find((item) => item.findingId === Number(finding!.id));
    expect(groupItem).toMatchObject({ status: "blocked", actionKey: "fusionar", level: 2, errorCode: "level" });
    expect(group.counts).toMatchObject({ pending: 0 });
    expect((await apply(group.id, { previewHash: group.previewHash, note: "fusionar en grupo" })).statusCode).toBe(422);

    const selected = await preview({ mode: "selected", findingIds: [Number(finding!.id)] });
    expect(selected.items[0]).toMatchObject({ status: "pending", actionKey: "fusionar", level: 2 });
    // Un valor escrito a mano solo vale para una corrección individual.
    const invalid = await app.inject({ method: "POST", url: "/curation/fixes/preview", headers, payload: { mode: "selected", findingIds: [Number(finding!.id)], overrides: { params: { value: "x" } } } });
    expect(invalid.statusCode).toBe(400);
    expect(await nameOf("artists", withArticle)).toBe("Los Relampagos QA");
    expect(await nameOf("artists", bare)).toBe("Relampagos QA");
  }, 60_000);

  it("deshacer no pisa un cambio posterior: la corrección queda not_undoable con el motivo", async () => {
    const dirty = `Estudio${ZERO_WIDTH_SPACE} Faro QA`;
    const org = await one("INSERT INTO public.organizations(name) VALUES($1) RETURNING id", [dirty]);
    expect((await runCurationScan({ trigger: "manual" })).status).toBe("ok");
    const plan = await preview({ mode: "individual", findingIds: [await openFinding("caracteres_invisibles", "organization", org)] });
    const applied = await apply(plan.id, { previewHash: plan.previewHash, note: "limpiar el estudio" });
    expect(applied.json()).toMatchObject({ status: "done" });
    await waitForCurationScans();

    await getPool().query("UPDATE public.organizations SET name = 'Estudio Faro Nuevo QA' WHERE id = $1", [org]);
    const refused = await undo(plan.id, "deshacer tarde");
    expect(refused.statusCode, refused.body).toBe(200);
    const reverse: BatchView = refused.json();
    expect(reverse).toMatchObject({ status: "failed", counts: { applied: 0, skippedStale: 1 } });
    expect(reverse.items[0]).toMatchObject({ status: "skipped_stale", errorCode: "not_open", error: expect.stringContaining("cambió después de la corrección") });
    expect(await nameOf("organizations", org)).toBe("Estudio Faro Nuevo QA");
    expect(await batch(plan.id)).toMatchObject({ status: "done", items: [expect.objectContaining({ status: "not_undoable", errorCode: "not_open" })] });
    // Nada más que deshacer.
    expect((await undo(plan.id, "otra vez")).statusCode).toBe(422);
    await waitForCurationScans();
  }, 60_000);
});
