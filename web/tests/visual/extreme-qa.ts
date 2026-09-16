import { spawn, type ChildProcess } from "node:child_process";
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startPgContainer } from "../../../test/support/pg-container.js";
import { applyCore } from "../../../test/support/apply-core.js";
import { migrateUp } from "../../../src/db/migrate.js";
import { getPool, closeDb } from "../../../src/db/client.js";
import { resetEnvCache } from "../../../src/config/env.js";
import { buildApp } from "../../../src/api/app.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const outputDir = path.join(root, "docs/ui-qa/extreme");

function waitForUrl(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try {
        const response = await fetch(url);
        if (response.ok) return resolve();
      } catch { /* El servidor aún está arrancando. */ }
      if (Date.now() >= deadline) return reject(new Error(`Timeout esperando ${url}`));
      setTimeout(() => void attempt(), 200);
    };
    void attempt();
  });
}

function stopChild(child: ChildProcess | undefined): void {
  if (child && !child.killed) child.kill("SIGTERM");
}

const container = await startPgContainer();
let web: ChildProcess | undefined;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;

try {
  process.env.DATABASE_URL = container.databaseUrl;
  process.env.LOG_LEVEL = "silent";
  resetEnvCache();
  await applyCore(container.name);
  await migrateUp();

  const pool = getPool();
  const longName = "La Orquesta Interminable de los Archivos Eléctricos Venezolanos y Sus Resonancias Transcontinentales";
  const biography = Array.from({ length: 18 }, (_, index) =>
    `Párrafo ${index + 1}. Fixture sintético de QA visual, creado únicamente en una base desechable para comprobar lectura prolongada, ritmo vertical y ajuste responsive sin presentarlo como información real.`,
  ).join("\n\n");

  const artistResult = await pool.query<{ id: string }>(
    `INSERT INTO artists (name, artist_type, biography, origin_city, origin_country, formed_year, notes)
     VALUES ($1, 'band', $2, 'Caracas con un nombre de ubicación deliberadamente extenso', 'Venezuela', 1987, 'VISUAL_QA_TEMP')
     RETURNING id`,
    [longName, biography],
  );
  const artistId = Number(artistResult.rows[0]?.id);
  const albumResult = await pool.query<{ id: string }>(
    `INSERT INTO albums (artist_id, title, release_year, album_type, genre, description, notes)
     VALUES ($1, $2, 2026, 'studio_album', 'Rock experimental, archivo sonoro y música electroacústica', $3, 'VISUAL_QA_TEMP')
     RETURNING id`,
    [artistId, `${longName}: Cartografía completa de una noche que parecía no terminar nunca`, biography],
  );
  const albumId = Number(albumResult.rows[0]?.id);

  await pool.query(
    `INSERT INTO persons (name, nationality, is_venezuelan, notes)
     SELECT CASE WHEN n <= 30
       THEN 'Músico de prueba ' || lpad(n::text, 2, '0') || ' con un nombre artístico extraordinariamente largo'
       ELSE 'Colaborador de prueba ' || lpad((n - 30)::text, 2, '0') || ' para archivo visual'
     END, 'Fixture sintético', false, 'VISUAL_QA_TEMP'
     FROM generate_series(1, 80) AS n`,
  );
  await pool.query(
    `INSERT INTO tracks (album_id, disc_number, track_number, title, duration_seconds, youtube_start_seconds, notes)
     SELECT $1, 1, n,
       'Pista de prueba ' || lpad(n::text, 3, '0') || CASE WHEN n % 7 = 0 THEN ' con un título extremadamente largo para comprobar el comportamiento de las columnas' ELSE '' END,
       120 + n, (n - 1) * 181, 'VISUAL_QA_TEMP'
     FROM generate_series(1, 100) AS n`,
    [albumId],
  );
  await pool.query(
    `WITH visual_people AS (
       SELECT id, row_number() OVER (ORDER BY id) AS n FROM persons WHERE notes = 'VISUAL_QA_TEMP'
     )
     INSERT INTO album_credits (album_id, person_id, credit_type, role, notes)
     SELECT $1, id,
       CASE WHEN n <= 30 THEN 'musician'::credit_type ELSE 'other'::credit_type END,
       CASE WHEN n <= 30 THEN 'Instrumento principal, coros y arreglos adicionales' ELSE 'Colaboración técnica documentada con una función deliberadamente extensa' END,
       'VISUAL_QA_TEMP'
     FROM visual_people`,
    [albumId],
  );

  app = await buildApp();
  const apiAddress = await app.listen({ host: "127.0.0.1", port: 0 });
  web = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", "5174"], {
    cwd: path.join(root, "web"),
    env: { ...process.env, VITE_API_BASE_URL: apiAddress },
    stdio: "ignore",
  });
  await waitForUrl("http://127.0.0.1:5174");
  await mkdir(outputDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    for (const viewport of [
      { name: "desktop", width: 1440, height: 1000 },
      { name: "mobile", width: 390, height: 844 },
    ]) {
      const page = await browser.newPage({ viewport });
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto(`http://127.0.0.1:5174/discos/${albumId}`, { waitUntil: "networkidle" });
      if (await page.locator(".credit-group").nth(0).locator(".credit-row").count() !== 30) throw new Error(`${viewport.name}: no se renderizaron los 30 músicos`);
      if (await page.locator(".credit-group").nth(5).locator(".credit-row").count() !== 50) throw new Error(`${viewport.name}: no se renderizaron los 50 créditos adicionales`);
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-album-denso.png`), fullPage: true });

      const overflow = await page.evaluate(() => ({
        amount: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        offenders: [...document.querySelectorAll("body *")]
          .filter((element) => element.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
          .slice(0, 12)
          .map((element) => ({ tag: element.tagName.toLowerCase(), className: element.className, right: Math.round(element.getBoundingClientRect().right) })),
      }));
      if (overflow.amount > 1) throw new Error(`${viewport.name}: overflow horizontal de ${overflow.amount}px: ${JSON.stringify(overflow.offenders)}`);
      await page.locator(".table-wrap--scroll").evaluate((element) => { element.scrollTop = element.scrollHeight; });
      const lastTrack = page.getByText("Pista de prueba 100", { exact: false });
      if (!(await lastTrack.isVisible())) throw new Error(`${viewport.name}: la pista 100 no queda accesible`);
      await lastTrack.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-pista-100.png`), fullPage: false });

      await page.goto(`http://127.0.0.1:5174/artistas/${artistId}`, { waitUntil: "networkidle" });
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-nombre-biografia-largos.png`), fullPage: true });
      const artistOverflow = await page.evaluate(() => ({
        amount: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        offenders: [...document.querySelectorAll("body *")]
          .filter((element) => element.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
          .slice(0, 12)
          .map((element) => ({ tag: element.tagName.toLowerCase(), className: element.className, right: Math.round(element.getBoundingClientRect().right) })),
      }));
      if (artistOverflow.amount > 1) throw new Error(`${viewport.name}: overflow horizontal en texto largo de ${artistOverflow.amount}px: ${JSON.stringify(artistOverflow.offenders)}`);
      if (pageErrors.length) throw new Error(`${viewport.name}: ${pageErrors.join("; ")}`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
} finally {
  stopChild(web);
  if (app) await app.close();
  await closeDb();
  await container.stop();
}
