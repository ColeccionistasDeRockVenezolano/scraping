import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.CRV_WEB_URL ?? "http://127.0.0.1:5173";
const outputDir = path.resolve(process.env.CRV_CAPTURE_DIR ?? "../docs/ui-qa/current");
const mode = process.env.CRV_CAPTURE_MODE ?? "current";

const routes = [
  ["buscador", "/?q=Caramelos"],
  ["artistas", "/artistas?q=Caramelos"],
  ["artista-caramelos", "/artistas/58"],
  ["disco-las-paticas", "/discos/57"],
  ["persona-asier", "/personas/2698"],
  ["organizacion-mad-box", "/organizaciones/176"],
  ["revision", "/revision"],
  ["revision-detalle", "/revision/191119"],
];

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const allFailures = [];

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
]) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const failures = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) failures.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => failures.push(`page: ${error.message}`));

  for (const [name, route] of routes) {
    await page.goto(`${baseUrl}${route}`, { waitUntil: "networkidle" });
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

  await page.goto(`${baseUrl}/artistas`, { waitUntil: "networkidle" });
  await page.evaluate(() => {
    localStorage.setItem("crv.operatorToken", "crv-visual-qa-operator-token-2026");
    localStorage.setItem("crv.operatorName", "QA visual");
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Nuevo artista" }).click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(outputDir, `${mode}-${viewport.name}-form-crear.png`), fullPage: false });
  await page.goto(`${baseUrl}/discos/57`, { waitUntil: "networkidle" });
  await page.locator(".page-actions").getByRole("button", { name: "Editar", exact: true }).click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(outputDir, `${mode}-${viewport.name}-form-editar.png`), fullPage: false });

  if (failures.length) allFailures.push(`${viewport.name}:\n${failures.join("\n")}`);
  await context.close();
}

await browser.close();
if (allFailures.length) throw new Error(allFailures.join("\n"));
