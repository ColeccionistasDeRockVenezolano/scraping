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
// por tandas, sin overflow horizontal, sin errores de consola, que «No es un
// problema» pide un motivo y guarda la decisión, y que «Son distintas» guarda el
// par (PLAN_CURADURIA E2).
//
// De E8, además: el botón principal de la tarjeta lleva el nombre de la acción
// recomendada, la vista previa resalta el tramo que cambia, aplicar deja la
// barra de resultado y un «Deshacer» a mano, el lote aparece en el historial,
// «seleccionar los N que cumplen el filtro» sale al elegir uno, los atajos de
// teclado mueven el foco y en móvil las acciones viven en una hoja inferior.
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
async function seed(): Promise<{ dirtyArtist: number; spacedArtist: number }> {
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
  // Signos raros de cada clase (puntuación, moneda, símbolo) en cuatro campos:
  // «Otros» agrupa por clase y campo (B1), así que recibe 12 subgrupos, el caso
  // que se despliega por tandas. El signo va en medio para que ningún detector
  // de forma (signo colgante) lo explique antes.
  const rareSigns: Array<[table: string, column: string, id: number, sign: string]> = [
    ["albums", "title", 10, "¥"], ["albums", "title", 11, "★"],
    ["tracks", "title", 20, "†"], ["tracks", "title", 21, "£"], ["tracks", "title", 22, "♪"],
    ["artists", "name", 30, "‡"], ["artists", "name", 31, "¢"], ["artists", "name", 32, "∞"],
    ["persons", "name", 40, "‰"], ["persons", "name", 41, "¤"], ["persons", "name", 42, "≈"],
  ];
  for (const [table, column, id, sign] of rareSigns) {
    // Nombres de tabla y columna fijos de esta lista, no vienen de fuera.
    await pool.query(`UPDATE public.${table} SET ${column} = regexp_replace(${column}, ' ', $2) WHERE id = $1`, [id, ` ${sign} `]);
  }
  // Dos nombres con entidades HTML: tienen acción recomendada (`decodificar_html`)
  // y una alternativa (`limpiar_texto`), así que sirven para la tarjeta con
  // acciones reales, «Otras correcciones» y la vista previa (E8). Cada pasada
  // corrige uno, y ninguno es el caso del análisis de verificación del final.
  await one("INSERT INTO public.artists(name, origin_city) VALUES('Ra&iacute;ces Vivas QA', 'Barquisimeto') RETURNING id");
  await one("INSERT INTO public.artists(name, origin_city) VALUES('Ni&ntilde;os del Sur QA', 'Mérida') RETURNING id");
  // Dos nombres con un carácter invisible reservados para la autocorrección
  // (E10): el otro invisible del catálogo —«Trueno Negro»— lo corrige la API al
  // final, y aquí hace falta algo que ninguna otra parte del QA toque.
  await one("INSERT INTO public.artists(name, origin_city) VALUES($1, 'Mérida') RETURNING id", [`Bruma${ZERO_WIDTH_SPACE} Austral QA`]);
  await one("INSERT INTO public.artists(name, origin_city) VALUES($1, 'Cumaná') RETURNING id", [`Faro${ZERO_WIDTH_SPACE} Nocturno QA`]);
  // Un artista con espacios de más: es la corrección por la API de la segunda
  // pasada. Cada pasada necesita la suya —la verificación del panorama enseña
  // la ÚLTIMA corrección— y esta no la toca ni el QA de la web ni la
  // autocorrección, que solo tiene autorizados los invisibles.
  const spacedArtist = await one("INSERT INTO public.artists(name, origin_city) VALUES('Marea  Baja QA', 'Caracas') RETURNING id");
  // Un par de artistas escritos de otra forma, para «Son distintas».
  await one("INSERT INTO public.artists(name, origin_city) VALUES('Los Relámpago QA', 'Caracas') RETURNING id");
  await one("INSERT INTO public.artists(name, origin_city) VALUES('Relámpago QA', 'Maracay') RETURNING id");
  return { dirtyArtist, spacedArtist };
}

async function lastScanId(): Promise<number> {
  return Number((await getPool().query<{ id: string }>("SELECT coalesce(max(id), 0)::text AS id FROM ingest.curation_scans")).rows[0]!.id);
}

/** Espera el análisis de verificación que dispara una escritura de la API (posterior a `afterId`). */
async function waitForCorrectionScan(afterId: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const { rows } = await getPool().query("SELECT 1 FROM ingest.curation_scans WHERE trigger = 'correccion' AND status = 'ok' AND id > $1", [afterId]);
    if (rows.length) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await waitForCurationScans();
}

async function waitForApp(page: Page): Promise<void> {
  await page.waitForFunction(() => (document.querySelector("#root")?.childElementCount ?? 0) > 0, undefined, { timeout: 60_000 });
}

/**
 * En móvil las acciones de una tarjeta están en una hoja inferior (E8.9): antes
 * de pulsar cualquiera hay que abrirla. En escritorio ya están a la vista.
 */
async function openCardActions(page: Page, mobile: boolean): Promise<void> {
  if (!mobile) return;
  await page.locator(".cfind").first().getByRole("button", { name: "Acciones" }).click();
  await page.getByRole("dialog").waitFor({ timeout: 10_000 });
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
  // El QA sí la enciende: es lo que se va a enseñar (E10). En producción va
  // apagada y solo la enciende quien la administra.
  process.env["CRV_CURATION_AUTOFIX"] = "true";
  // El .env de producción sirve la API bajo /crv; aquí la API de QA vive en /.
  process.env["CRV_SESSION_COOKIE_PATH"] = "/";
  process.env["CRV_COLLABORATORS_JSON"] = JSON.stringify([
    { username: QA_USER, name: "QA Curaduria", role: "admin", passwordHash: await passwordHash(QA_PASSWORD) },
  ]);
  resetEnvCache();
  await applyCore(container.name);
  await migrateUp();
  const { dirtyArtist, spacedArtist } = await seed();
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

      // 4. «No es un problema» pide un motivo y guarda la decisión con él.
      //    En móvil las acciones de la tarjeta viven en una hoja inferior (E8.9),
      //    así que primero se abre.
      await page.goto(`${webUrl}/curaduria/categoria/ficha_de_otro_tipo`, { waitUntil: "domcontentloaded" });
      await page.locator(".cfind").first().waitFor({ timeout: 20_000 });
      const before = await page.locator(".cfind").count();
      await openCardActions(page, index === 1);
      const ignoreButton = page.getByRole("button", { name: "No es un problema" }).first();
      await ignoreButton.waitFor({ timeout: 20_000 });
      await ignoreButton.click();
      const ignoreDialog = page.getByRole("dialog");
      // Sin motivo no se guarda.
      await ignoreDialog.getByRole("button", { name: "No es un problema" }).click();
      await ignoreDialog.getByText("Elige un motivo.").waitFor();
      await ignoreDialog.getByLabel(/Falso positivo/u).check();
      await ignoreDialog.getByLabel(/Nota/u).fill("QA: el detector se equivocó");
      if (await ignoreDialog.getByText("Elige un motivo.").count()) throw new Error(`${viewport.name}: el aviso de motivo sigue tras elegir uno`);
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-ignorar-motivo.png`), fullPage: true });
      await assertNoOverflow(page, `${viewport.name} diálogo de motivo`);
      await ignoreDialog.getByRole("button", { name: "No es un problema" }).click();
      await page.getByText("Hallazgo ignorado", { exact: false }).first().waitFor();
      await page.waitForFunction((count) => document.querySelectorAll(".cfind").length < count, before);
      await assertNoOverflow(page, `${viewport.name} ficha_de_otro_tipo`);
      const reasons = await getPool().query<{ n: string }>(
        "SELECT count(*)::text AS n FROM ingest.curation_findings WHERE status = 'ignored' AND ignore_reason = 'falso_positivo' AND ignore_note = 'QA: el detector se equivocó'");
      if (Number(reasons.rows[0]!.n) !== index + 1) throw new Error(`${viewport.name}: el ignorado no guardó su motivo`);

      // 4b. «Son distintas» guarda el par (solo la primera vez: después ya no está abierto).
      if (index === 0) {
        await page.goto(`${webUrl}/curaduria/categoria/fichas_repetidas`, { waitUntil: "domcontentloaded" });
        await page.locator(".cfind").first().waitFor({ timeout: 20_000 });
        await openCardActions(page, index === 1);
        const distinctButton = page.getByRole("button", { name: "Son distintas" }).first();
        await distinctButton.waitFor({ timeout: 20_000 });
        const beforeDistinct = await lastScanId();
        await distinctButton.click();
        const distinctDialog = page.getByRole("dialog");
        await distinctDialog.getByLabel(/Motivo/u).fill("QA: bandas distintas de ciudades distintas");
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(outputDir, `${viewport.name}-son-distintas.png`), fullPage: true });
        await distinctDialog.getByRole("button", { name: "Son distintas" }).click();
        await page.getByText("Par declarado distinto", { exact: false }).first().waitFor();
        const pairs = await getPool().query<{ decided_by: string }>("SELECT decided_by FROM ingest.curation_distinct_pairs");
        if (pairs.rows.length !== 1) throw new Error(`${viewport.name}: se esperaba un par declarado distinto, hay ${pairs.rows.length}`);
        // Su verificación termina antes de la corrección del paso 5, para no confundirlas.
        await waitForCorrectionScan(beforeDistinct);
        await assertNoOverflow(page, `${viewport.name} fichas_repetidas`);
      }

      // 5. Triaje con teclado y selección por filtro (E8.3/E8.6) sobre los
      //    nombres con entidades HTML, que sí tienen corrección de un clic.
      await page.goto(`${webUrl}/curaduria/categoria/nombres_sucios?detector=entidades_html`, { waitUntil: "domcontentloaded" });
      const card = page.locator(".cfind").first();
      await card.waitFor({ timeout: 20_000 });
      await page.keyboard.press("j");
      await page.locator(".cfind--focused").first().waitFor({ timeout: 10_000 });
      await page.keyboard.press("x");
      const selectionBar = page.getByRole("toolbar", { name: "Acciones sobre lo seleccionado" });
      await selectionBar.waitFor({ timeout: 10_000 });
      await selectionBar.getByRole("button", { name: /^Seleccionar los .* que cumplen el filtro$/u }).waitFor({ timeout: 10_000 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-seleccion-total.png`), fullPage: true });
      await assertNoOverflow(page, `${viewport.name} selección por filtro`);
      await page.keyboard.press("?");
      const helpDialog = page.getByRole("dialog");
      await helpDialog.getByText("Atajos de teclado").first().waitFor({ timeout: 10_000 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-teclado.png`), fullPage: true });
      await helpDialog.getByRole("button", { name: "Entendido" }).click();
      await selectionBar.getByRole("button", { name: "Vaciar selección" }).click();

      // 6. Tarjeta con la acción recomendada → vista previa → aplicar →
      //    «Deshacer» a mano (E8.1/E8.2/E8.4). En móvil las acciones están en
      //    una hoja inferior (E8.9).
      if (index === 1) {
        await card.getByRole("button", { name: "Acciones" }).click();
        const sheet = page.getByRole("dialog");
        await sheet.getByRole("button", { name: /Decodificar/u }).waitFor({ timeout: 10_000 });
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(outputDir, `${viewport.name}-acciones-hoja.png`), fullPage: true });
        await assertNoOverflow(page, `${viewport.name} hoja de acciones`);
        await sheet.getByRole("button", { name: /Decodificar/u }).click();
      } else {
        const primary = card.locator(".cfind__actions .btn--primary").first();
        const primaryLabel = (await primary.innerText()).trim();
        if (!/decodificar/iu.test(primaryLabel)) {
          throw new Error(`${viewport.name}: el botón principal debería ser la acción recomendada, dice «${primaryLabel}»`);
        }
        const menuButton = card.getByRole("button", { name: "Otras correcciones" });
        if (!await menuButton.count()) {
          throw new Error(`${viewport.name}: falta «Otras correcciones» en un hallazgo con dos acciones`);
        }
        await menuButton.click();
        const menu = card.getByRole("menu");
        await menu.getByRole("menuitem", { name: /Limpiar el texto/u }).waitFor({ timeout: 10_000 });
        await page.waitForTimeout(200);
        await page.screenshot({ path: path.join(outputDir, `${viewport.name}-otras-correcciones.png`), fullPage: true });
        // Un menú tiene que poder abandonarse con el teclado.
        await page.keyboard.press("Escape");
        await menu.waitFor({ state: "detached", timeout: 5_000 });
        await primary.click();
      }

      const fixDialog = page.getByRole("dialog");
      await fixDialog.locator(".cdiff").first().waitFor({ timeout: 20_000 });
      if (!await fixDialog.locator(".cdiff mark").count()) {
        throw new Error(`${viewport.name}: la vista previa no resalta el tramo que cambia`);
      }
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-vista-previa.png`), fullPage: true });
      await assertNoOverflow(page, `${viewport.name} vista previa`);
      const beforeFix = await lastScanId();
      await fixDialog.getByLabel(/^Motivo/u).fill("QA: decodificar la entidad HTML");
      await fixDialog.getByRole("button", { name: /^Aplicar/u }).click();
      await fixDialog.locator(".cprogress").waitFor({ timeout: 20_000 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-lote-aplicado.png`), fullPage: true });
      await page.locator(".toast__action", { hasText: "Deshacer" }).waitFor({ timeout: 10_000 });
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-deshacer.png`), fullPage: true });
      await assertNoOverflow(page, `${viewport.name} lote aplicado`);
      await fixDialog.locator(".form-actions").getByRole("button", { name: "Cerrar" }).click();
      const pending = await getPool().query<{ n: string }>("SELECT count(*)::text AS n FROM public.artists WHERE name LIKE '%&%;%'");
      if (Number(pending.rows[0]!.n) !== 1 - index) {
        throw new Error(`${viewport.name}: quedan ${pending.rows[0]!.n} nombres con entidad HTML, se esperaba ${1 - index}`);
      }
      await waitForCorrectionScan(beforeFix);

      // 7. Historial de correcciones con su deshacer (E8.5).
      await page.goto(`${webUrl}/curaduria/correcciones`, { waitUntil: "domcontentloaded" });
      await page.getByRole("link", { name: /^Lote #/u }).first().waitFor({ timeout: 20_000 });
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-correcciones.png`), fullPage: true });
      await assertNoOverflow(page, `${viewport.name} correcciones`);
      await page.getByRole("link", { name: /^Lote #/u }).first().click();
      await page.locator(".cprogress").waitFor({ timeout: 20_000 });
      await page.getByRole("button", { name: "Deshacer este lote" }).waitFor({ timeout: 10_000 });
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-lote-detalle.png`), fullPage: true });
      await assertNoOverflow(page, `${viewport.name} detalle del lote`);

      // 8. Corrección por la API: arregla un problema del nombre pero mete la
      //    ciudad, y el detector lo verifica solo. Una por pasada, sobre fichas
      //    distintas: el panorama enseña la ÚLTIMA corrección, así que la de la
      //    primera pasada ya no vale cuando llega la segunda.
      const patched = index === 0
        ? { id: dirtyArtist, name: "Trueno Negro (Caracas)" }
        : { id: spacedArtist, name: "Marea Baja QA (Caracas)" };
      const beforePatch = await lastScanId();
      const response = await fetch(`${apiAddress}/artists/${patched.id}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${QA_TOKEN}`, "x-crv-operator": "QA Curaduria", "content-type": "application/json", origin: webUrl },
        body: JSON.stringify({ name: patched.name }),
      });
      if (!response.ok) throw new Error(`la corrección falló: ${response.status} ${await response.text()}`);
      await waitForCorrectionScan(beforePatch);
      await page.goto(`${webUrl}/curaduria`, { waitUntil: "domcontentloaded" });
      await page.getByText(/desencadenados? por la corrección/u).first().waitFor({ timeout: 20_000 });
      await page.getByText("La corrección desencadenó", { exact: false }).first().waitFor();
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-verificacion.png`), fullPage: true });

      await page.getByRole("link", { name: /desencadenados? por la corrección/u }).first().click();
      await page.getByText("Apareció al corregir", { exact: false }).first().waitFor({ timeout: 20_000 });
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-desencadenados.png`), fullPage: true });
      await assertNoOverflow(page, `${viewport.name} desencadenados`);

      // 9. Autocorrección (E10): autorizar una acción de nivel 0, correrla y ver
      //    lo corregido hoy con su deshacer, aquí y en el panorama.
      await page.goto(`${webUrl}/curaduria/autocorreccion`, { waitUntil: "domcontentloaded" });
      await waitForApp(page);
      await page.getByRole("heading", { name: "Autocorrección", exact: true }).waitFor({ timeout: 20_000 });
      if (index === 0) {
        // Lo que exige criterio humano no se puede autorizar: no está en la lista.
        const offered = await page.locator("#autofix-option option").allInnerTexts();
        if (offered.some((text) => /Fusionar/u.test(text))) throw new Error(`${viewport.name}: la lista blanca ofrece una acción de nivel 1`);
        await page.selectOption("#autofix-option", "caracteres_invisibles|*|limpiar_texto");
        await page.getByLabel("Encenderla ya").check();
        await page.getByRole("button", { name: "Autorizar" }).click();
      }
      await page.getByRole("button", { name: "Apagar", exact: true }).first().waitFor({ timeout: 20_000 });
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-autocorreccion.png`), fullPage: true });
      await assertNoOverflow(page, `${viewport.name} autocorrección`);

      await page.getByRole("button", { name: /Correr ahora/u }).click();
      await page.getByRole("link", { name: /^Lote #/u }).first().waitFor({ timeout: 20_000 });
      await page.getByRole("button", { name: /Deshacer el lote/u }).first().waitFor({ timeout: 10_000 });
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-autocorreccion-hoy.png`), fullPage: true });
      if (index === 0) {
        const left = await getPool().query<{ n: string }>("SELECT count(*)::text AS n FROM public.artists WHERE name LIKE $1", [`%${ZERO_WIDTH_SPACE}%`]);
        if (left.rows[0]!.n !== "0") throw new Error(`${viewport.name}: la autocorrección dejó ${left.rows[0]!.n} nombres con carácter invisible`);
      }

      await page.goto(`${webUrl}/curaduria`, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "Autocorrecciones de hoy" }).waitFor({ timeout: 20_000 });
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-autocorreccion-panorama.png`), fullPage: true });
      await assertNoOverflow(page, `${viewport.name} panorama con autocorrección`);

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
