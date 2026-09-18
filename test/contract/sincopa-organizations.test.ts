import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { migrateUp } from "../../src/db/migrate.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { applySincopaOrganizationRepair, planSincopaOrganizationRepair } from "../../src/review/sincopa-organizations.js";

// Auditoría de pruebas #4 — `review/sincopa-organizations.ts` retira
// organizaciones del core (reparación destructiva, con cuatro guardas) y no
// tenía ninguna prueba. Aquí se ejercen las guardas una por una y el retiro
// real: run, snapshot en params, claims rechazados y segunda pasada sin nada.
const FIXTURES = path.resolve("test/fixtures/adapters");

describe("reparación de organizaciones de Sincopa (contrato)", () => {
  let container: PgContainer;
  let dataDir: string;
  let sincopaId: number;
  let otherSourceId: number;

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    dataDir = await mkdtemp(path.join(tmpdir(), "crv-sincopa-"));
    process.env["DATA_DIR"] = dataDir;
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();

    sincopaId = await one(
      "INSERT INTO ingest.sources(slug,name,site_type,trust_level,enabled) VALUES('sincopa','Sincopa','database','high',false) RETURNING id");
    otherSourceId = await one(
      "INSERT INTO ingest.sources(slug,name,site_type,trust_level,enabled) VALUES('rockzuela','Rockzuela','blogspot','medium',false) RETURNING id");
    // Los snapshots crudos que la reparación vuelve a parsear con el parser
    // vigente: de ahí sale la lista de nombres que SÍ son organizaciones.
    await storePage("sincopa.html", "https://www.sincopa.com/rock_pop/artist_rock/banda.htm");
    await storePage("sincopa-album.html", "https://www.sincopa.com/rock_pop/cdinfo_rock/disco.htm");
  }, 180_000);

  afterAll(async () => {
    await closeDb();
    await container?.stop();
    await rm(dataDir, { recursive: true, force: true });
  }, 60_000);

  async function one(sql: string, params: unknown[] = []): Promise<number> {
    const { rows } = await getPool().query<{ id: string }>(sql, params);
    return Number(rows[0]!.id);
  }

  async function storePage(fixture: string, url: string): Promise<void> {
    const bytes = await readFile(path.join(FIXTURES, fixture));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(path.join(dataDir, fixture), bytes);
    await getPool().query(`
      INSERT INTO ingest.raw_pages(source_id,url,canonical_url,http_status,content_type,sha256,byte_size,stored_path)
      VALUES($1,$2,$2,200,'text/html; charset=windows-1252',$3,$4,$5)`,
    [sincopaId, url, sha256, bytes.length, fixture]);
  }

  const newOrganization = async (name: string): Promise<number> =>
    one("INSERT INTO public.organizations(name,organization_type) VALUES($1,'record_label') RETURNING id", [name]);

  async function newClaim(organizationId: number, sourceId: number, status: string): Promise<number> {
    return one(`
      INSERT INTO ingest.claims(source_id,entity_kind,organization_id,field,raw_value,raw_hash,status,identity_key)
      SELECT $1,'organization',$2,'name',to_jsonb(o.name),
             encode(sha256(convert_to('organization:'||o.id||':'||$3,'UTF8')),'hex'), $3::ingest.claim_status, 'org-qa:'||o.id
        FROM public.organizations o WHERE o.id=$2
      RETURNING id`, [sourceId, organizationId, status]);
  }

  it("solo propone lo que el parser vigente ya no reconoce y ninguna otra fuente sostiene", async () => {
    const protectedOrg = await newOrganization("Palacio"); // nombre real de la extracción corregida
    await newClaim(protectedOrg, sincopaId, "accepted");

    const fake = await newOrganization("Falso Sello QA");
    await newClaim(fake, sincopaId, "accepted");

    // Claim externo RECHAZADO: no protege (la guarda es «no rechazado»).
    const rejectedExternal = await newOrganization("Sello Con Claim Externo Rechazado QA");
    await newClaim(rejectedExternal, sincopaId, "accepted");
    await newClaim(rejectedExternal, otherSourceId, "rejected");

    // Claim externo vivo: protege.
    const externalAlive = await newOrganization("Sello Con Evidencia Externa QA");
    await newClaim(externalAlive, sincopaId, "accepted");
    await newClaim(externalAlive, otherSourceId, "accepted");

    // Sin claims de Sincopa: la reparación ni la mira.
    const noClaims = await newOrganization("Sello Sin Claims QA");

    const plan = await planSincopaOrganizationRepair();
    expect(plan.validNames).toBeGreaterThan(0);
    const candidateIds = plan.candidates.map((candidate) => candidate.id);
    expect(candidateIds).toEqual(expect.arrayContaining([fake, rejectedExternal]));
    expect(candidateIds).not.toContain(protectedOrg);
    expect(candidateIds).not.toContain(externalAlive);
    expect(candidateIds).not.toContain(noClaims);
    expect(plan.candidates.find((candidate) => candidate.id === fake)).toMatchObject({
      name: "Falso Sello QA", sincopaClaims: 1,
    });
  });

  it("una organización con dependientes en public se salta, con la lista de dependientes", async () => {
    const dependent = await newOrganization("Sello Con Dependencias QA");
    await newClaim(dependent, sincopaId, "accepted");
    const artist = await one("INSERT INTO public.artists(name,origin_country) VALUES('Artista QA','Venezuela') RETURNING id");
    await getPool().query(
      "INSERT INTO public.albums(artist_id,title,album_type,label_id) VALUES($1,'Disco QA','studio_album',$2)", [artist, dependent]);

    const plan = await planSincopaOrganizationRepair();
    expect(plan.candidates.map((candidate) => candidate.id)).not.toContain(dependent);
    const skipped = plan.skipped.find((item) => item.id === dependent);
    expect(skipped).toBeDefined();
    expect(skipped!.dependents.some((row) => row.table.endsWith("albums") && row.column === "label_id" && row.rows === 1)).toBe(true);
  });

  it("apply exige nota, retira de verdad con run y auditoría, y repetir no hace nada", async () => {
    await expect(applySincopaOrganizationRepair("   ")).rejects.toThrow(/nota obligatoria/u);

    const before = await planSincopaOrganizationRepair();
    const candidates = before.candidates.map((candidate) => candidate.id).sort((a, b) => a - b);
    expect(candidates.length).toBeGreaterThanOrEqual(2);

    const result = await applySincopaOrganizationRepair("QA: reparación de organizaciones de Sincopa");
    expect(result.removed.map((removal) => removal.id).sort((a, b) => a - b)).toEqual(candidates);
    for (const removal of result.removed) {
      expect(removal.claimsRejected.length).toBeGreaterThanOrEqual(1);
      expect(removal.snapshot["name"]).toBeTruthy();
    }

    // Ya no están en el core.
    const remaining = await getPool().query("SELECT id FROM public.organizations WHERE id = ANY($1::bigint[])", [candidates]);
    expect(remaining.rows).toEqual([]);

    // El run guarda contadores y el snapshot de lo retirado (no hay padre donde copiar la historia).
    const run = await getPool().query<{ kind: string; status: string; counters: Record<string, number>; params: { removedOrganizations: Array<{ snapshot: { name: string } }> } }>(
      "SELECT kind, status, counters, params FROM ingest.scrape_runs WHERE id=$1", [result.runId]);
    expect(run.rows[0]).toMatchObject({ kind: "merge_run", status: "ok" });
    expect(run.rows[0]!.counters).toMatchObject({ removed: candidates.length, skipped: before.skipped.length });
    expect(run.rows[0]!.params.removedOrganizations.map((item) => item.snapshot.name)).toContain("Falso Sello QA");

    // Los claims de nombre quedaron rechazados (nunca borrados) y su nota
    // nombra el run: el retiro suelta el destino y deja constancia.
    const rejectedIds = result.removed.flatMap((removal) => removal.claimsRejected);
    expect(rejectedIds.length).toBeGreaterThanOrEqual(candidates.length);
    const rejected = await getPool().query<{ status: string; notes: string | null }>(
      "SELECT status, notes FROM ingest.claims WHERE id = ANY($1::bigint[])", [rejectedIds]);
    expect(rejected.rows.every((row) => row.status === "rejected" && (row.notes ?? "").includes(`run ${result.runId}`))).toBe(true);

    // Segunda pasada: ya no hay nada que retirar.
    const again = await planSincopaOrganizationRepair();
    expect(again.candidates).toEqual([]);
    const second = await applySincopaOrganizationRepair("QA: segunda pasada");
    expect(second.removed).toEqual([]);
  });
});
