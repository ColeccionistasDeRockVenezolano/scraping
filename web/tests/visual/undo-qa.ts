// CRV · QA end-to-end de «Deshacer» (diario de cambios, migración 0028)
// contra un contenedor de prueba — nunca contra la base de desarrollo.
//
// Por la interfaz real, comprobando la base después de cada paso:
//   1. editar un disco deja la barra «Deshacer» a la vista;
//   2. deshacer desde la barra devuelve el campo y la barra pasa a «Rehacer»;
//   3. rehacer vuelve a aplicar la edición;
//   4. retirar una persona → «Deshacer» en la barra la devuelve;
//   5. la ficha retirada ofrece «Deshacer retiro» en su propio 404;
//   6. la ficha lista «Cambios de esta ficha» y el Historial lista todo;
//   7. en móvil la barra queda sobre la navegación inferior, sin desbordar.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Locator, type Page } from "@playwright/test";
import { startPgContainer } from "../../../test/support/pg-container.js";
import { applyCore } from "../../../test/support/apply-core.js";
import { migrateUp } from "../../../src/db/migrate.js";
import { getPool, closeDb } from "../../../src/db/client.js";
import { resetEnvCache } from "../../../src/config/env.js";
import { buildApp } from "../../../src/api/app.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const outputDir = path.join(root, "docs/ui-qa/undo");
const QA_USER = "qa-admin";
const QA_PASSWORD = "qa-admin-2026-segura";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error("sin puerto libre"))));
    });
  });
}

function waitForUrl(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try {
        const response = await fetch(url);
        if (response.ok) return resolve();
      } catch { /* Aún arrancando. */ }
      if (Date.now() >= deadline) return reject(new Error(`Timeout esperando ${url}`));
      setTimeout(() => void attempt(), 200);
    };
    void attempt();
  });
}

function stopChild(child: ChildProcess | undefined): void {
  if (!child?.pid) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
}

async function waitForApp(page: Page, timeoutMs = 60_000): Promise<void> {
  await page.waitForFunction(() => (document.querySelector("#root")?.childElementCount ?? 0) > 0, undefined, { timeout: timeoutMs });
}

async function passwordHash(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, result) => (error ? reject(error) : resolve(result)));
  });
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

async function rows<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query<T>(sql, params)).rows;
}

function assertEqual(actual: unknown, expected: unknown, what: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${what}: esperaba ${JSON.stringify(expected)}, hay ${JSON.stringify(actual)}`);
  }
  console.log(`   ✓ ${what}`);
}

const container = await startPgContainer();
let web: ChildProcess | undefined;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;

try {
  process.env["DATABASE_URL"] = container.databaseUrl;
  process.env["LOG_LEVEL"] = "silent";
  process.env["CRV_SESSION_COOKIE_PATH"] = "/";
  process.env["CRV_COLLABORATORS_JSON"] = JSON.stringify([
    { username: QA_USER, name: "QA Admin", passwordHash: await passwordHash(QA_PASSWORD) },
  ]);
  resetEnvCache();
  await applyCore(container.name);
  await migrateUp();

  const one = async (sql: string, params: unknown[] = []): Promise<number> =>
    Number((await rows<{ id: string }>(sql, params))[0]!.id);
  const artist = await one("INSERT INTO public.artists(name, artist_type, origin_country) VALUES('Los Reversibles QA','band','Venezuela') RETURNING id");
  const album = await one("INSERT INTO public.albums(artist_id, title) VALUES($1,'Disco Reversible QA') RETURNING id", [artist]);
  const retirable = await one("INSERT INTO public.persons(name) VALUES('Persona Retirable QA') RETURNING id");
  const retirable2 = await one("INSERT INTO public.persons(name) VALUES('Persona Retirada QA') RETURNING id");
  // Se edita el año, no el género: `albums.genre` es una proyección de los
  // géneros asignados y la API rechaza escribirlo a mano.
  const yearOf = async () => (await rows<{ release_year: number | null }>("SELECT release_year FROM public.albums WHERE id=$1", [album]))[0]!.release_year;
  const personExists = async (id: number) => (await rows("SELECT 1 FROM public.persons WHERE id=$1", [id])).length === 1;

  const port = await freePort();
  const webUrl = `http://127.0.0.1:${port}`;
  process.env["CRV_ALLOWED_ORIGINS"] = webUrl;
  resetEnvCache();
  app = await buildApp();
  const apiAddress = await app.listen({ host: "127.0.0.1", port: 0 });
  web = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: path.join(root, "web"),
    env: { ...process.env, VITE_API_BASE_URL: apiAddress },
    stdio: "ignore",
    detached: true,
  });
  process.once("exit", () => stopChild(web));
  await waitForUrl(webUrl);
  await mkdir(outputDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) pageErrors.push(message.text());
    });
    const shot = (name: string) => page.screenshot({ path: path.join(outputDir, `desktop-${name}.png`) });
    const bar = page.locator(".undo-bar");
    const confirmUndo = async (dialog: Locator, note: string, button: RegExp) => {
      await dialog.getByLabel("Motivo *").fill(note);
      await dialog.getByRole("button", { name: button }).click();
      await dialog.waitFor({ state: "detached", timeout: 15000 });
    };

    // ---- Sesión ----------------------------------------------------------------
    await page.goto(`${webUrl}/discos/${album}`, { waitUntil: "domcontentloaded" });
    await waitForApp(page);
    await page.getByRole("button", { name: "Iniciar sesión como colaborador" }).click();
    await page.getByLabel("Usuario").fill(QA_USER);
    await page.getByLabel("Contraseña").fill(QA_PASSWORD);
    await page.getByRole("button", { name: "Iniciar sesión", exact: true }).click();
    await page.locator(".page-actions").getByRole("button", { name: "Editar" }).waitFor({ timeout: 15000 });

    // ---- 1. Editar → la barra ofrece deshacer ---------------------------------
    await page.locator(".page-actions").getByRole("button", { name: "Editar" }).click();
    const edit = page.getByRole("dialog");
    await edit.getByLabel("Año de publicación").fill("1998");
    await edit.getByLabel("Motivo *").fill("QA: año del disco");
    await edit.getByRole("button", { name: "Guardar" }).click();
    // Si no cierra, el motivo está escrito en el propio modal: decirlo aquí
    // ahorra abrir el navegador a mano.
    await edit.waitFor({ state: "detached", timeout: 15000 }).catch(async (error: Error) => {
      throw new Error(`el modal de edición no cerró: ${(await edit.innerText()).replace(/\s+/gu, " ").slice(0, 400)}`, { cause: error });
    });
    assertEqual(await yearOf(), 1998, "edición guardada");
    await bar.getByText("Edición de disco").waitFor({ timeout: 15000 });
    await bar.getByRole("button", { name: "Deshacer" }).waitFor();
    await shot("1-barra-tras-editar");

    // ---- 2. Deshacer desde la barra ---------------------------------------------
    await bar.getByRole("button", { name: "Deshacer" }).click();
    const undo = page.getByRole("dialog");
    await undo.getByText("se revierte").first().waitFor({ timeout: 15000 });
    await shot("2-dialogo-deshacer");
    await confirmUndo(undo, "QA: el año no era ese", /^Deshacer #\d+$/u);
    assertEqual(await yearOf(), null, "deshacer devuelve el año");
    await bar.getByText(/Deshiciste #\d+/u).waitFor({ timeout: 15000 });
    await bar.getByRole("button", { name: "Rehacer" }).waitFor();
    await shot("3-barra-rehacer");

    // ---- 3. Rehacer -------------------------------------------------------------
    await bar.getByRole("button", { name: "Rehacer" }).click();
    await confirmUndo(page.getByRole("dialog"), "QA: sí era ese año", /^Rehacer #\d+$/u);
    assertEqual(await yearOf(), 1998, "rehacer vuelve a aplicar la edición");

    // ---- 6a. Cambios de esta ficha ----------------------------------------------
    await page.getByRole("heading", { name: "Cambios de esta ficha" }).scrollIntoViewIfNeeded();
    const fichaRows = page.locator(".section", { has: page.getByRole("heading", { name: "Cambios de esta ficha" }) }).locator(".change-row");
    await fichaRows.first().waitFor({ timeout: 15000 });
    assertEqual(await fichaRows.count(), 3, "la ficha lista edición, deshacer y rehacer");
    await page.getByRole("heading", { name: "Cambios de esta ficha" }).screenshot({ path: path.join(outputDir, "desktop-4-cambios-ficha-titulo.png") });
    await page.locator(".section", { has: page.getByRole("heading", { name: "Cambios de esta ficha" }) }).screenshot({ path: path.join(outputDir, "desktop-4-cambios-ficha.png") });

    // ---- 4. Retirar → deshacer desde la barra ------------------------------------
    await page.goto(`${webUrl}/personas/${retirable}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Retirar" }).click();
    const retire = page.getByRole("dialog");
    await retire.getByLabel("Motivo *").fill("QA: retiro por error");
    await retire.getByRole("button", { name: "Retirar" }).click();
    await page.waitForURL(/\/personas$/u, { timeout: 15000 });
    assertEqual(await personExists(retirable), false, "persona retirada");
    await bar.getByText("Retiro de persona").waitFor({ timeout: 15000 });
    await shot("5-barra-tras-retirar");
    await bar.getByRole("button", { name: "Deshacer" }).click();
    const undoRetire = page.getByRole("dialog");
    await undoRetire.getByText("Persona Retirable QA").first().waitFor({ timeout: 15000 });
    await confirmUndo(undoRetire, "QA: no había que retirarla", /^Deshacer #\d+$/u);
    assertEqual(await personExists(retirable), true, "deshacer el retiro la devuelve con su mismo id");

    // ---- 5. «Deshacer retiro» desde el 404 de la ficha ---------------------------
    await page.goto(`${webUrl}/personas/${retirable2}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Retirar" }).click();
    const retire2 = page.getByRole("dialog");
    await retire2.getByLabel("Motivo *").fill("QA: retiro que luego se lamenta");
    await retire2.getByRole("button", { name: "Retirar" }).click();
    await page.waitForURL(/\/personas$/u, { timeout: 15000 });
    await page.goto(`${webUrl}/personas/${retirable2}`, { waitUntil: "domcontentloaded" });
    await page.getByText("Esta ficha fue retirada del catálogo").waitFor({ timeout: 15000 });
    await shot("6-ficha-retirada");
    await page.getByRole("button", { name: /Deshacer retiro/u }).click();
    await confirmUndo(page.getByRole("dialog"), "QA: se retiró por error", /^Deshacer #\d+$/u);
    assertEqual(await personExists(retirable2), true, "«Deshacer retiro» desde la ficha la devuelve");
    await page.getByRole("heading", { name: "Persona Retirada QA" }).waitFor({ timeout: 15000 });

    // ---- 6b. Historial ----------------------------------------------------------
    await page.goto(`${webUrl}/historial`, { waitUntil: "domcontentloaded" });
    await page.locator(".change-row").first().waitFor({ timeout: 15000 });
    const listed = await page.locator(".change-row").count();
    if (listed < 7) throw new Error(`historial: esperaba al menos 7 cambios, hay ${listed}`);
    console.log(`   ✓ historial lista ${listed} cambios`);
    await page.screenshot({ path: path.join(outputDir, "desktop-7-historial.png"), fullPage: true });

    // ---- 7. Móvil -----------------------------------------------------------------
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${webUrl}/discos/${album}`, { waitUntil: "domcontentloaded" });
    await page.locator(".page-actions").getByRole("button", { name: "Editar" }).click();
    const editMobile = page.getByRole("dialog");
    await editMobile.getByLabel("Año de publicación").fill("1999");
    await editMobile.getByLabel("Motivo *").fill("QA: móvil");
    await editMobile.getByRole("button", { name: "Guardar" }).click();
    await editMobile.waitFor({ state: "detached", timeout: 15000 });
    await bar.getByRole("button", { name: "Deshacer" }).waitFor({ timeout: 15000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 1) throw new Error(`móvil: overflow de ${overflow}px`);
    const [barBox, navBox] = await Promise.all([bar.boundingBox(), page.locator(".main-nav").boundingBox()]);
    if (!barBox || !navBox || barBox.y + barBox.height > navBox.y + 1) throw new Error("móvil: la barra queda bajo la navegación inferior");
    console.log("   ✓ móvil: barra visible sobre la navegación, sin desborde");
    await page.screenshot({ path: path.join(outputDir, "mobile-barra.png") });

    if (pageErrors.length) throw new Error(`errores de consola: ${pageErrors.join("; ")}`);
    console.log(`QA de deshacer: todo en verde. Capturas en ${path.relative(root, outputDir)}.`);
  } finally {
    await browser.close();
  }
} finally {
  stopChild(web);
  if (app) await app.close();
  await closeDb();
  await container.stop();
}
