// CRV · QA visual del detector de conflictos de Curaduría contra un contenedor
// de prueba — nunca contra la base de desarrollo.
//
// Siembra un catálogo limpio con casos conocidos, analiza con el código real,
// levanta API y web, inicia sesión como admin de QA y captura a 1280 y 400 px:
// el tablero de conflictos, una categoría, «Otros» y la verificación tras una
// corrección hecha por la API (con lo que la corrección desencadenó).
//
// Comprueba lo que no se ve en una captura: menú lateral por categoría con
// «Otros» (plegado en un botón a 400 px), subgrupos de «Otros» que se despliegan
// por tandas, sin overflow horizontal, sin errores de consola, y que «No es un
// problema» guarda la decisión.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "@playwright/test";
import { startPgContainer } from "../../../test/support/pg-container.js";
import { applyCore } from "../../../test/support/apply-core.js";
import { cleanSnapshot } from "../../../test/support/curation-snapshot.js";
import { migrateUp } from "../../../src/db/migrate.js";
import { getPool, closeDb } from "../../../src/db/client.js";
import { resetEnvCache } from "../../../src/config/env.js";
import { buildApp } from "../../../src/api/app.js";
import { runCurationScan, waitForCurationScans } from "../../../src/curation/scan.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const outputDir = path.join(root, "docs/ui-qa/curaduria");
const QA_USER = "qa-curaduria";
const QA_PASSWORD = randomBytes(18).toString("base64url");
const QA_TOKEN = randomBytes(24).toString("base64url");
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("sin puerto"))));
    });
  });
}

function waitForUrl(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try {
        if ((await fetch(url)).ok) return resolve();
      } catch { /* El servidor aún está arrancando. */ }
      if (Date.now() >= deadline) return reject(new Error(`Timeout esperando ${url}`));
      setTimeout(() => void attempt(), 200);
    };
    void attempt();
  });
}

function stopChild(child: ChildProcess | undefined): void {
  if (!child || child.killed || !child.pid) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
}

async function passwordHash(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, result) => (error ? reject(error) : resolve(result)));
  });
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

async function one(sql: string, params: unknown[] = []): Promise<number> {
  return Number((await getPool().query<{ id: string }>(sql, params)).rows[0]!.id);
}

/** Catálogo limpio (el mismo de las pruebas unitarias) con los casos conocidos encima. */
async function seed(): Promise<{ dirtyArtist: number }> {
  const snapshot = cleanSnapshot();
  const pool = getPool();
  for (const artist of snapshot.artists) {
    await pool.query("INSERT INTO public.artists(name, origin_city, formed_year) VALUES($1, $2, $3)", [artist.name, artist.originCity, artist.formedYear]);
  }
  for (const album of snapshot.albums) {
    await pool.query("INSERT INTO public.albums(artist_id, title, release_year, album_type) VALUES($1, $2, $3, 'studio_album')", [album.artistId, album.title, album.releaseYear]);
  }
  for (const track of snapshot.tracks) {
    await pool.query("INSERT INTO public.tracks(album_id, disc_number, track_number, title, duration_seconds) VALUES($1, $2, $3, $4, $5)",
      [track.albumId, track.disc, track.number, track.title, track.durationSeconds]);
  }
  for (const person of snapshot.persons) {
    const id = await one("INSERT INTO public.persons(name) VALUES($1) RETURNING id", [person.name]);
    await pool.query("INSERT INTO public.artist_members(artist_id, person_id, role) VALUES($1, $2, 'Guitarra')", [((id - 1) % snapshot.artists.length) + 1, id]);
  }

  // Casos conocidos: uno por categoría de forma, más una anomalía para «Otros».
  const dirtyArtist = 1;
  await pool.query("UPDATE public.artists SET name = $2 WHERE id = $1", [dirtyArtist, `Trueno${ZERO_WIDTH_SPACE} Negro`]);
  await pool.query("UPDATE public.tracks SET title = $2 WHERE id = $1", [5, "Sombra Eléctrico - Calle Ciudad"]);
  await pool.query("UPDATE public.albums SET title = 'Memoria § Ciudad' WHERE id = 4");
  const org = await one("INSERT INTO public.organizations(name, organization_type) VALUES('Estudios Sonoros QA', 'recording_studio') RETURNING id");
  const studioPerson = await one("INSERT INTO public.persons(name) VALUES('Estudios Sonoros QA') RETURNING id");
  await pool.query("INSERT INTO public.album_credits(album_id, person_id, credit_type, role) VALUES(2, $1, 'recording', 'Grabación')", [studioPerson]);
  await pool.query("INSERT INTO public.album_credits(album_id, organization_id, credit_type, role) VALUES(3, $1, 'recording', 'Grabación')", [org]);
  await one("INSERT INTO public.persons(name) VALUES('4:39') RETURNING id");
  // Muchos signos raros distintos en títulos de disco: «Otros» recibe decenas
  // de subgrupos, el caso que se despliega por tandas.
  const rareSigns = ["¶", "†", "‡", "¤", "‰", "¥", "£", "∞", "≈", "★", "♪", "☼", "✓", "¢", "µ", "÷"];
  for (const [offset, sign] of rareSigns.entries()) {
    await pool.query("UPDATE public.albums SET title = $2 WHERE id = $1", [10 + offset, `Memoria ${sign} Ciudad ${offset + 1}`]);
  }
  return { dirtyArtist };
}

async function waitForApp(page: Page): Promise<void> {
  await page.waitForFunction(() => (document.querySelector("#root")?.childElementCount ?? 0) > 0, undefined, { timeout: 60_000 });
}

async function assertNoOverflow(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 1) throw new Error(`${label}: overflow horizontal de ${overflow}px`);
}

const container = await startPgContainer();
let web: ChildProcess | undefined;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;

try {
  process.env["DATABASE_URL"] = container.databaseUrl;
  process.env["LOG_LEVEL"] = "silent";
  process.env["CRV_OPERATOR_TOKEN"] = QA_TOKEN;
  // El .env de producción sirve la API bajo /crv; aquí la API de QA vive en /.
  process.env["CRV_SESSION_COOKIE_PATH"] = "/";
  process.env["CRV_COLLABORATORS_JSON"] = JSON.stringify([
    { username: QA_USER, name: "QA Curaduria", role: "admin", passwordHash: await passwordHash(QA_PASSWORD) },
  ]);
  resetEnvCache();
  await applyCore(container.name);
  await migrateUp();
  const { dirtyArtist } = await seed();
  const first = await runCurationScan({ trigger: "manual" });
  if (first.status !== "ok") throw new Error(`el análisis inicial falló: ${first.error ?? "?"}`);
  console.log(`QA: ${first.total} hallazgos sembrados · ${JSON.stringify(first.byCategory)}`);

  const port = await freePort();
  const webUrl = `http://127.0.0.1:${port}`;
  process.env["CRV_ALLOWED_ORIGINS"] = webUrl;
  resetEnvCache();
  app = await buildApp();
  const apiAddress = await app.listen({ host: "127.0.0.1", port: 0 });
  web = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: path.join(root, "web"), env: { ...process.env, VITE_API_BASE_URL: apiAddress }, stdio: "ignore", detached: true,
  });
  process.once("exit", () => stopChild(web));
  process.once("SIGINT", () => { stopChild(web); process.exit(130); });
  process.once("SIGTERM", () => { stopChild(web); process.exit(143); });
  await mkdir(outputDir, { recursive: true });
  await waitForUrl(webUrl);

  const browser = await chromium.launch({ headless: true });
  try {
    for (const [index, viewport] of [
      { name: "desktop", width: 1280, height: 1000 },
      { name: "mobile", width: 400, height: 900 },
    ].entries()) {
      const page = await browser.newPage({ viewport });
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) pageErrors.push(message.text()); });

      await page.goto(`${webUrl}/curaduria`, { waitUntil: "domcontentloaded" });
      await waitForApp(page);
      await page.getByRole("button", { name: "Iniciar sesión", exact: true }).first().click();
      await page.getByLabel("Usuario").fill(QA_USER);
      await page.getByLabel("Contraseña").fill(QA_PASSWORD);
      await page.getByRole("dialog").getByRole("button", { name: "Iniciar sesión", exact: true }).click();

      // 1. Tablero: menú lateral por categoría (con «Otros») y la cola vieja retirada.
      //    A 400 px el menú está plegado en un botón que muestra la sección abierta.
      const tabs = page.getByRole("navigation", { name: "Herramientas de curaduría" });
      const menuToggle = page.getByRole("button", { name: /Sección/u });
      if (index === 1) {
        await menuToggle.waitFor({ timeout: 20_000 });
        if (await tabs.isVisible()) throw new Error(`${viewport.name}: el menú de curaduría debería empezar plegado`);
        await menuToggle.click();
      }
      await tabs.getByRole("link", { name: /Otros/u }).waitFor({ timeout: 20_000 }).catch(async (error: unknown) => {
        await page.screenshot({ path: path.join(outputDir, `${viewport.name}-sesion-fallo.png`), fullPage: true });
        const shown = (await page.locator("body").innerText()).slice(0, 500).replaceAll("\n", " | ");
        throw new Error(`${viewport.name}: no apareció el menú. La página muestra: ${shown} (${(error as Error).message.split("\n")[0]})`);
      });
      for (const label of ["Conflictos", "Nombres sucios", "Mal segmentados", "Ficha de otro tipo", "Posibles duplicados"]) {
        if (await tabs.getByRole("link", { name: new RegExp(label, "u") }).count() !== 1) throw new Error(`${viewport.name}: falta «${label}» en el menú`);
      }
      if (await tabs.getByText("Cola de revisión").count()) throw new Error(`${viewport.name}: sigue «Cola de revisión» en el menú`);
      if (index === 1) {
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(outputDir, `${viewport.name}-menu.png`), fullPage: true });
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => document.querySelector(".cside__toggle")?.getAttribute("aria-expanded") === "false");
      }
      await page.getByText("Último análisis", { exact: false }).first().waitFor();
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-conflictos.png`), fullPage: true });
      await assertNoOverflow(page, `${viewport.name} /curaduria`);

      // 2. Una categoría, con el tramo marcado del carácter invisible.
      // En la segunda pasada la corrección de la primera ya lo resolvió: se ve en «Resueltos».
      await page.goto(`${webUrl}/curaduria/categoria/nombres_sucios${index === 0 ? "" : "?status=resolved"}`, { waitUntil: "domcontentloaded" });
      await page.locator(".cval__cp").first().waitFor({ timeout: 20_000 }).catch(async (error: unknown) => {
        await page.screenshot({ path: path.join(outputDir, `${viewport.name}-nombres-sucios-fallo.png`), fullPage: true });
        const shown = (await page.locator("main").innerText()).slice(0, 600).replaceAll("\n", " | ");
        const html = await page.locator(".cval").first().innerHTML().catch(() => "(sin .cval)");
        throw new Error(`${viewport.name}: sin marca de invisible. Muestra: ${shown} · .cval=${html} (${(error as Error).message.split("\n")[0]})`);
      });
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-nombres-sucios.png`), fullPage: true });
      await assertNoOverflow(page, `${viewport.name} nombres_sucios`);

      // 3. «Otros»: la anomalía sembrada aparece sin regla escrita para ella, y
      //    sus subgrupos se ven por tandas en vez de todos de golpe.
      await page.goto(`${webUrl}/curaduria/categoria/otros`, { waitUntil: "domcontentloaded" });
      await page.getByText("Memoria § Ciudad", { exact: false }).first().waitFor({ timeout: 20_000 });
      const subgroups = page.getByRole("group", { name: "Filtrar por subgrupo" });
      const subgroupChips = subgroups.locator(".cchip--sub");
      const initialChips = await subgroupChips.count();
      if (initialChips !== 7) throw new Error(`${viewport.name}: se esperaban «Todos» y 6 subgrupos de entrada, hay ${initialChips}`);
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-otros.png`), fullPage: true });
      await subgroups.getByRole("button", { name: /^Ver \d+ más/u }).click();
      await page.waitForFunction((count) => document.querySelectorAll(".cfilters--sub .cchip--sub").length > count, initialChips);
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-otros-mas.png`), fullPage: true });
      await assertNoOverflow(page, `${viewport.name} otros`);

      // 4. «No es un problema» guarda la decisión.
      await page.goto(`${webUrl}/curaduria/categoria/ficha_de_otro_tipo`, { waitUntil: "domcontentloaded" });
      const ignoreButton = page.getByRole("button", { name: "No es un problema" }).first();
      await ignoreButton.waitFor({ timeout: 20_000 });
      const before = await page.getByRole("button", { name: "No es un problema" }).count();
      await ignoreButton.click();
      await page.getByText("Hallazgo ignorado", { exact: false }).first().waitFor();
      await page.waitForFunction((count) => document.querySelectorAll(".cfind").length < count, before);
      await assertNoOverflow(page, `${viewport.name} ficha_de_otro_tipo`);

      // 5. Corrección por la API (solo la primera vez): quita el invisible pero
      //    mete la ciudad en el nombre. El detector debe verificarla solo.
      if (index === 0) {
        const response = await fetch(`${apiAddress}/artists/${dirtyArtist}`, {
          method: "PATCH",
          headers: { authorization: `Bearer ${QA_TOKEN}`, "x-crv-operator": "QA Curaduria", "content-type": "application/json", origin: webUrl },
          body: JSON.stringify({ name: "Trueno Negro (Caracas)" }),
        });
        if (!response.ok) throw new Error(`la corrección falló: ${response.status} ${await response.text()}`);
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          const { rows } = await getPool().query("SELECT 1 FROM ingest.curation_scans WHERE trigger = 'correccion' AND status = 'ok'");
          if (rows.length) break;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        await waitForCurationScans();
      }
      await page.goto(`${webUrl}/curaduria`, { waitUntil: "domcontentloaded" });
      await page.getByText(/desencadenados? por la corrección/u).first().waitFor({ timeout: 20_000 });
      await page.getByText("La corrección desencadenó", { exact: false }).first().waitFor();
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-verificacion.png`), fullPage: true });

      await page.getByRole("link", { name: /desencadenados? por la corrección/u }).first().click();
      await page.getByText("Apareció al corregir", { exact: false }).first().waitFor({ timeout: 20_000 });
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-desencadenados.png`), fullPage: true });
      await assertNoOverflow(page, `${viewport.name} desencadenados`);

      if (pageErrors.length) throw new Error(`${viewport.name}: ${pageErrors.join("; ")}`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`QA visual de Curaduría: capturas en ${path.relative(root, outputDir)} (1280 y 400 px), sin overflow ni errores de consola.`);
} finally {
  stopChild(web);
  if (app) await app.close();
  await closeDb();
  await container.stop();
}
