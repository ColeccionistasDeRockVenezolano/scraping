// CRV · Regenera src/doctor/core-catalog.json desde el core canónico.
//
//   npm run core:catalog
//
// Levanta un PostgreSQL desechable, aplica `crv_simple_v1.sql` VERBATIM y
// guarda la huella resultante. Solo debe reejecutarse si el core cambia, lo
// cual requiere aprobación explícita del propietario (CONTRACT §13).
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { startPgContainer } from "../test/support/pg-container.js";
import { applyCore } from "../test/support/apply-core.js";
import { readCoreCatalog } from "../src/doctor/core-catalog.js";
import { assertSupportedNode } from "../src/config/runtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

async function main(): Promise<void> {
  assertSupportedNode();
  const coreSql = await readFile(path.join(ROOT, "crv_simple_v1.sql"), "utf8");
  const coreSha256 = createHash("sha256").update(coreSql).digest("hex");

  const container = await startPgContainer();
  try {
    await applyCore(container.name);
    const pool = new Pool({ connectionString: container.databaseUrl });
    try {
      const entries = await readCoreCatalog(pool);
      const out = { coreSha256, generatedAt: new Date().toISOString(), entries };
      const target = path.join(ROOT, "src", "doctor", "core-catalog.json");
      await writeFile(target, `${JSON.stringify(out, null, 2)}\n`, "utf8");
      // eslint-disable-next-line no-console
      console.log(`core-catalog.json: ${entries.length} entradas (core ${coreSha256.slice(0, 12)}…)`);
    } finally {
      await pool.end();
    }
  } finally {
    await container.stop();
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
