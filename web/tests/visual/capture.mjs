import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.CRV_WEB_URL ?? "http://127.0.0.1:5173";
const outputDir = path.resolve(process.env.CRV_CAPTURE_DIR ?? "../docs/ui-qa/current");
const mode = process.env.CRV_CAPTURE_MODE ?? "current";

// Rutas por defecto: el juego de la base de desarrollo. Con CRV_CAPTURE_ROUTES
// (JSON [[nombre, ruta], …]), CRV_CAPTURE_EDIT_ROUTE y CRV_CAPTURE_VIEWPORTS el
// mismo capturador sirve para una base de prueba, sin tocar la de desarrollo.
const defaultRoutes = [
  ["buscador", "/?q=Caramelos"],
  ["artistas", "/artistas?q=Caramelos"],
  ["artista-caramelos", "/artistas/58"],
  ["disco-las-paticas", "/discos/57"],
  ["persona-asier", "/personas/2698"],
  ["organizacion-mad-box", "/organizaciones/176"],
  ["curaduria-conflictos", "/curaduria"],
  ["curaduria-mal-segmentados", "/curaduria/categoria/mal_segmentados"],
  ["curaduria-otros", "/curaduria/categoria/otros"],
  ["revision-detalle", "/revision/191119"],
];

const routes = process.env.CRV_CAPTURE_ROUTES ? JSON.parse(process.env.CRV_CAPTURE_ROUTES) : defaultRoutes;
const editRoute = process.env.CRV_CAPTURE_EDIT_ROUTE ?? "/discos/57";
const viewports = process.env.CRV_CAPTURE_VIEWPORTS
  ? JSON.parse(process.env.CRV_CAPTURE_VIEWPORTS)
  : [{ name: "desktop", width: 1440, height: 1000 }, { name: "mobile", width: 390, height: 844 }];

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const allFailures = [];

/**
 * Navega y espera a que la red se estabilice, con tope: `networkidle` a secas
 * puede no llegar nunca si una página deja una conexión viva (y entonces el
 * fallo no dice nada útil). Se da un margen corto para que React pinte lo que
 * llegó tarde.
 */
async function openRoute(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => undefined);
  // Sin esto se capturan pantallas a medio cargar (una ficha con «Cargando…» y
  // el aviso de sesión en curso no demuestran nada). Con tope corto: esperar
  // 15 s por ruta multiplicaba la duración del QA entero.
  await page.waitForFunction(() => {
    const content = document.querySelector("main") ?? document.body;
    return !/Cargando|Comprobando acceso/u.test(content.innerText);
  }, undefined, { timeout: 4000 }).catch(() => undefined);
  await page.waitForTimeout(400);
}

for (const viewport of viewports) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const failures = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) failures.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => failures.push(`page: ${error.message}`));

  for (const [name, route] of routes) {
    try {
      await openRoute(page, `${baseUrl}${route}`);
    } catch (error) {
      failures.push(`${route}: ${error.message.split("\n")[0]}`);
      const shown = await page.locator("body").innerText().catch(() => "");
      if (shown) failures.push(`${route}: la página muestra «${shown.slice(0, 160).replaceAll("\n", " ")}»`);
      continue;
    }
    await page.screenshot({ path: path.join(outputDir, `${mode}-${viewport.name}-${name}.png`), fullPage: true });
    const overflow = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      offenders: [...document.querySelectorAll("body *")]
        .filter((element) => element.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
        .slice(0, 8)
        .map((element) => `${element.tagName.toLowerCase()}.${element.className}`),
    }));
    if (overflow.document > 1) failures.push(`${route}: overflow ${overflow.document}px (${overflow.offenders.join(", ")})`);
  }

  const qaUsername = process.env.CRV_CAPTURE_USERNAME;
  const qaPassword = process.env.CRV_CAPTURE_PASSWORD;
  if (!qaUsername || !qaPassword) throw new Error("CRV_CAPTURE_USERNAME y CRV_CAPTURE_PASSWORD son obligatorios para capturar formularios");
  await openRoute(page, `${baseUrl}/artistas`);
  await page.getByRole("button", { name: "Iniciar sesión como colaborador" }).click();
  await page.getByLabel("Usuario").fill(qaUsername);
  await page.getByLabel("Contraseña").fill(qaPassword);
  await page.getByRole("button", { name: "Iniciar sesión", exact: true }).click();
  // El botón de crear aparece cuando la sesión está activa. Si no llega, el
  // fallo dice qué muestra la interfaz en vez de quedarse esperando.
  await page.getByRole("button", { name: "Nuevo artista" }).waitFor({ timeout: 15000 }).catch(async (error) => {
    const shown = await page.locator("body").innerText().catch(() => "");
    failures.push(`sesión de colaborador: no apareció «Nuevo artista» tras iniciar sesión (${error.message.split("\\n")[0]}). La página muestra «${shown.slice(0, 200).replaceAll("\\n", " ")}»`);
  });
  if (failures.length) { await context.close(); continue; }
  await page.getByRole("button", { name: "Nuevo artista" }).click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(outputDir, `${mode}-${viewport.name}-form-crear.png`), fullPage: false });
  await openRoute(page, `${baseUrl}${editRoute}`);
  await page.locator(".page-actions").getByRole("button", { name: "Editar", exact: true }).click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(outputDir, `${mode}-${viewport.name}-form-editar.png`), fullPage: false });

  if (failures.length) allFailures.push(`${viewport.name}:\n${failures.join("\n")}`);
  await context.close();
}

await browser.close();
if (allFailures.length) throw new Error(allFailures.join("\n"));
