// CRV · Test de contrato: la huella del catálogo core detecta drift real en
// una base viva (PHASES F0). El hash del archivo y el diff de pg_dump prueban
// que el core y las migraciones no cambian; esto prueba lo que faltaba: que
// `doctor` se entera si alguien altera `public` a mano.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { CORE_CATALOG, readCoreCatalog, diffCoreCatalog } from "../../src/doctor/core-catalog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

describe("huella del catálogo core", () => {
  let container: PgContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await startPgContainer();
    await applyCore(container.name);
    pool = new Pool({ connectionString: container.databaseUrl });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  }, 60_000);

  it("el snapshot commiteado corresponde al core canónico vigente", async () => {
    const sql = await readFile(path.join(ROOT, "crv_simple_v1.sql"), "utf8");
    const sha256 = createHash("sha256").update(sql).digest("hex");
    expect(CORE_CATALOG.coreSha256).toBe(sha256);
    expect(CORE_CATALOG.entries.length).toBeGreaterThan(0);
  });

  it("el core recién aplicado coincide entrada por entrada con el snapshot", async () => {
    const actual = await readCoreCatalog(pool);
    const { missing, extra } = diffCoreCatalog(actual);
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it("detecta una columna añadida al core (lo que los conteos no ven)", async () => {
    await pool.query("ALTER TABLE public.artists ADD COLUMN drift_probe text");
    try {
      const { missing, extra } = diffCoreCatalog(await readCoreCatalog(pool));
      expect(missing).toEqual([]);
      expect(extra).toContain("COL artists.drift_probe text");
    } finally {
      await pool.query("ALTER TABLE public.artists DROP COLUMN drift_probe");
    }
    expect(diffCoreCatalog(await readCoreCatalog(pool))).toEqual({ missing: [], extra: [] });
  });

  it("detecta un CHECK del core eliminado", async () => {
    const { rows } = await pool.query<{ conname: string; def: string }>(
      `SELECT con.conname, pg_get_constraintdef(con.oid) AS def
         FROM pg_constraint con
         JOIN pg_class rel ON rel.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = rel.relnamespace
        WHERE n.nspname = 'public' AND rel.relname = 'tracks' AND con.contype = 'c'
        ORDER BY con.conname LIMIT 1`,
    );
    const target = rows[0];
    expect(target).toBeDefined();
    const { conname, def } = target!;

    await pool.query(`ALTER TABLE public.tracks DROP CONSTRAINT ${conname}`);
    try {
      const { missing, extra } = diffCoreCatalog(await readCoreCatalog(pool));
      expect(extra).toEqual([]);
      expect(missing).toContain(`CONSTRAINT tracks.${conname} ${def}`);
    } finally {
      await pool.query(`ALTER TABLE public.tracks ADD CONSTRAINT ${conname} ${def}`);
    }
    expect(diffCoreCatalog(await readCoreCatalog(pool))).toEqual({ missing: [], extra: [] });
  });
});
