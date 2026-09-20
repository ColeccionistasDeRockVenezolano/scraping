// CRV · QA visual del detector de conflictos de Curaduría contra un contenedor
// de prueba — nunca contra la base de desarrollo.
//
// Siembra un catálogo limpio con casos conocidos, analiza con el código real,
// levanta API y web, inicia sesión como admin de QA y captura a 1280 y 400 px:
// el tablero de conflictos, una categoría, «Otros» y la verificación tras una
// corrección hecha por la API (con lo que la corrección desencadenó).
//
// Comprueba lo que no se ve en una captura: menú lateral por categoría con
// «Otros» (plegado en un botón a 400 px), subgrupos por tandas, sin overflow
// horizontal ni errores de consola; E8 añade teclado, vista previa/aplicar/
// deshacer e historial de correcciones, además de las decisiones E2/E7.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createHash, randomBytes, scrypt as scryptCallback } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Locator, type Page } from "@playwright/test";
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
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

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
  const dirtyMobileArtist = 2;
  await pool.query("UPDATE public.artists SET name = $2 WHERE id = $1", [dirtyArtist, `Trueno${ZERO_WIDTH_SPACE} Negro`]);
  await pool.query("UPDATE public.artists SET name = $2 WHERE id = $1", [dirtyMobileArtist, `Tormenta${ZERO_WIDTH_SPACE} Solar QA`]);
  await pool.query("UPDATE public.tracks SET title = $2 WHERE id = $1", [5, "Sombra Eléctrico - Calle Ciudad"]);
  await pool.query("UPDATE public.albums SET title = 'Memoria § Ciudad' WHERE id = 4");
  const org = await one("INSERT INTO public.organizations(name, organization_type) VALUES('Estudios Sonoros QA', 'recording_studio') RETURNING id");
  const studioPerson = await one("INSERT INTO public.persons(name) VALUES('Estudios Sonoros QA') RETURNING id");
  await pool.query("INSERT INTO public.album_credits(album_id, person_id, credit_type, role) VALUES(2, $1, 'recording', 'Grabación')", [studioPerson]);
  await pool.query("INSERT INTO public.album_credits(album_id, organization_id, credit_type, role) VALUES(3, $1, 'recording', 'Grabación')", [org]);
  await one("INSERT INTO public.persons(name) VALUES('4:39') RETURNING id");

  // E8: suficiente volumen para comprobar «Seleccionar los N que cumplen el
  // filtro» más allá de la primera página, sin reutilizar ids de la UI.
  for (let index = 1; index <= 26; index += 1) {
    await one("INSERT INTO public.organizations(name) VALUES($1) RETURNING id", [
      `QA Lote ${String(index).padStart(2, "0")}${ZERO_WIDTH_SPACE} Curaduría`,
    ]);
  }
  // Una fila con dos acciones aplicables para ejercitar el selector por fila.
  await one("INSERT INTO public.organizations(name) VALUES('QA Acción alternativa -') RETURNING id");
  // Una corrección determinista que colisiona con otra ficha real.
  await one("INSERT INTO public.artists(name) VALUES('QA Colision Limpia') RETURNING id");
  await one("INSERT INTO public.artists(name) VALUES($1) RETURNING id", [`QA Colision${ZERO_WIDTH_SPACE} Limpia`]);

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
  // Un par de artistas escritos de otra forma, para «Son distintas».
  await one("INSERT INTO public.artists(name, origin_city) VALUES('Los Relámpago QA', 'Caracas') RETURNING id");
  await one("INSERT INTO public.artists(name, origin_city) VALUES('Relámpago QA', 'Maracay') RETURNING id");

  // E7 visual: un conflicto llevado por review_queue (A/B/otro) y dos
  // conflictos directos para la acción grupal por trust_level, incluido empate.
  const sourceHigh = await one("INSERT INTO ingest.sources(slug,name,url,site_type,trust_level,enabled) VALUES('qa-e7-high','QA fuente alta','https://qa.invalid/high','website','high',true) RETURNING id");
  const sourceLow = await one("INSERT INTO ingest.sources(slug,name,url,site_type,trust_level,enabled) VALUES('qa-e7-low','QA fuente baja','https://qa.invalid/low','website','low',true) RETURNING id");
  const sourceHigh2 = await one("INSERT INTO ingest.sources(slug,name,url,site_type,trust_level,enabled) VALUES('qa-e7-high-2','QA fuente alta 2','https://qa.invalid/high-2','website','high',true) RETURNING id");
  const makeConflict = async (name: string, sourceA: number, sourceB: number, valueA: string, valueB: string) => {
    const artistId = await one("INSERT INTO public.artists(name,origin_city) VALUES($1,'Valencia') RETURNING id", [name]);
    const claimA = await one(`
      INSERT INTO ingest.claims(source_id,entity_kind,artist_id,field,raw_value,raw_hash,status,confidence)
      VALUES($1,'artist',$2,'origin_city',to_jsonb($3::text),$4,'conflict','high') RETURNING id`,
      [sourceA, artistId, valueA, sha256(`${name}:A:${valueA}`)]);
    const claimB = await one(`
      INSERT INTO ingest.claims(source_id,entity_kind,artist_id,field,raw_value,raw_hash,status,confidence)
      VALUES($1,'artist',$2,'origin_city',to_jsonb($3::text),$4,'conflict','high') RETURNING id`,
      [sourceB, artistId, valueB, sha256(`${name}:B:${valueB}`)]);
    const conflictId = await one(`
      INSERT INTO ingest.conflicts(claim_a_id,claim_b_id,entity_kind,field,value_a,value_b)
      VALUES($1,$2,'artist','origin_city',to_jsonb($3::text),to_jsonb($4::text)) RETURNING id`,
      [claimA, claimB, valueA, valueB]);
    return { artistId, claimA, claimB, conflictId };
  };
  const reviewConflict = await makeConflict("QA E7 revisión", sourceHigh, sourceLow, "Caracas", "Maracay");
  await one(`
    INSERT INTO ingest.review_queue(kind,conflict_id,claim_a_id,claim_b_id,artist_a_id,priority,notes)
    VALUES('field_conflict',$1,$2,$3,$4,9,'QA conflicto desde tarjeta') RETURNING id`,
    [reviewConflict.conflictId, reviewConflict.claimA, reviewConflict.claimB, reviewConflict.artistId]);
  await makeConflict("QA E7 confianza", sourceHigh, sourceLow, "Caracas", "Coro");
  await makeConflict("QA E7 empate", sourceHigh, sourceHigh2, "Mérida", "Barquisimeto");

  // E7: revisiones genéricas que deben poder aceptarse/rechazarse desde la
  // tarjeta sin salir de Curaduría.
  await one("INSERT INTO ingest.review_queue(kind,priority,notes,payload) VALUES('missing_url',8,'QA aceptar revisión','{}'::jsonb) RETURNING id");
  await one("INSERT INTO ingest.review_queue(kind,priority,notes,payload) VALUES('new_source',8,'QA rechazar revisión','{}'::jsonb) RETURNING id");

  // E7: person_duplicate debe abrir su comparador con el par exacto, aunque
  // la revisión no dependa de la página actual de candidatos.
  const duplicateA = await one("INSERT INTO public.persons(name) VALUES('QA Persona Duplicada Uno') RETURNING id");
  const duplicateB = await one("INSERT INTO public.persons(name) VALUES('QA Persona Duplicada Dos') RETURNING id");
  await one(`
    INSERT INTO ingest.review_queue(kind,person_a_id,person_b_id,priority,notes,payload)
    VALUES('person_duplicate',$1,$2,9,'QA precarga duplicado',$3::jsonb) RETURNING id`,
    [duplicateA, duplicateB, JSON.stringify({ score: 0.95, features: [] })]);

  return { dirtyArtist };
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

async function assertNoOverflow(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 1) throw new Error(`${label}: overflow horizontal de ${overflow}px`);
}

/** WCAG AA para texto normal: comprueba color computado contra el primer fondo opaco. */
async function assertTextContrast(locator: Locator, label: string, minimum = 4.5): Promise<void> {
  const result = await locator.first().evaluate((element) => {
    const parse = (value: string): [number, number, number, number] => {
      const match = /rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)/u.exec(value);
      if (!match) throw new Error(`color no parseable: ${value}`);
      return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? 1 : Number(match[4])];
    };
    const backgroundOf = (start: Element): [number, number, number, number] => {
      let current: Element | null = start;
      while (current) {
        const bg = parse(getComputedStyle(current).backgroundColor);
        if (bg[3] >= 0.99) return bg;
        current = current.parentElement;
      }
      return [10, 10, 10, 1];
    };
    const composite = (fg: [number, number, number, number], bg: [number, number, number, number], opacity: number): [number, number, number] => {
      const alpha = Math.max(0, Math.min(1, fg[3] * opacity));
      return [
        fg[0] * alpha + bg[0] * (1 - alpha),
        fg[1] * alpha + bg[1] * (1 - alpha),
        fg[2] * alpha + bg[2] * (1 - alpha),
      ];
    };
    const luminance = (rgb: [number, number, number]): number => {
      const linear = rgb.map((component) => {
        const value = component / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
    };
    const style = getComputedStyle(element);
    const fgRaw = parse(style.color);
    const bgRaw = backgroundOf(element);
    let opacity = 1;
    let current: Element | null = element;
    while (current) {
      opacity *= Number(getComputedStyle(current).opacity || "1");
      current = current.parentElement;
    }
    const fg = composite(fgRaw, bgRaw, opacity);
    const bg: [number, number, number] = [bgRaw[0], bgRaw[1], bgRaw[2]];
    const [lighter, darker] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
    return { ratio: (lighter! + 0.05) / (darker! + 0.05), color: style.color, background: `rgb(${bg.join(", ")})` };
  });
  if (result.ratio + 1e-6 < minimum) {
    throw new Error(`${label}: contraste ${result.ratio.toFixed(2)}:1 < ${minimum}:1 (${result.color} sobre ${result.background})`);
  }
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
  let triggeredScanId: number | null = null;
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
      for (const label of ["Conflictos", "Nombres sucios", "Mal segmentados", "Ficha de otro tipo", "Posibles duplicados", "Correcciones"]) {
        if (await tabs.getByRole("link", { name: new RegExp(label, "u") }).count() !== 1) throw new Error(`${viewport.name}: falta «${label}» en el menú`);
      }
      const duplicatesLink = tabs.getByRole("link", { name: /Posibles duplicados/u });
      const duplicatesCount = Number((await duplicatesLink.locator(".cside__count").innerText()).replace(/\D/gu, ""));
      if (!Number.isFinite(duplicatesCount) || duplicatesCount < 1) {
        throw new Error(`${viewport.name}: «Posibles duplicados» no muestra su contador vivo`);
      }
      if (await tabs.getByText("Cola de revisión").count()) throw new Error(`${viewport.name}: sigue «Cola de revisión» en el menú`);
      if (index === 1) {
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(outputDir, `${viewport.name}-menu.png`), fullPage: true });
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => document.querySelector(".cside__toggle")?.getAttribute("aria-expanded") === "false");
      }
      await page.getByText("Último análisis", { exact: false }).first().waitFor();
      await assertTextContrast(page.locator(".page-kicker"), `${viewport.name}: encabezado de Curaduría`);
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-conflictos.png`), fullPage: true });
      await assertNoOverflow(page, `${viewport.name} /curaduria`);

      // 2. Una categoría, con un caso independiente por viewport para poder
      // probar preview/aplicar/deshacer tanto en escritorio como en móvil.
      const targetName = index === 0 ? "Trueno" : "Tormenta";
      await page.goto(`${webUrl}/curaduria/categoria/nombres_sucios?q=${encodeURIComponent(targetName)}`, { waitUntil: "domcontentloaded" });
      const targetCard = page.locator(".cfind").filter({ hasText: targetName }).first();
      await targetCard.locator(".cval__cp").first().waitFor({ timeout: 20_000 }).catch(async (error: unknown) => {
        await page.screenshot({ path: path.join(outputDir, `${viewport.name}-nombres-sucios-fallo.png`), fullPage: true });
        const shown = (await page.locator("main").innerText()).slice(0, 600).replaceAll("\n", " | ");
        const html = await page.locator(".cval").first().innerHTML().catch(() => "(sin .cval)");
        throw new Error(`${viewport.name}: sin marca de invisible. Muestra: ${shown} · .cval=${html} (${(error as Error).message.split("\n")[0]})`);
      });
      await targetCard.focus();
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-nombres-sucios.png`), fullPage: true });
      await assertNoOverflow(page, `${viewport.name} nombres_sucios`);

      if (index === 0) {
        // E8.3: seleccionar todos los hallazgos del filtro usa el filtro real,
        // no una lista de ids limitada a la página visible.
        await page.goto(`${webUrl}/curaduria/categoria/nombres_sucios?detector=caracteres_invisibles`, { waitUntil: "domcontentloaded" });
        const selectAll = page.getByRole("button", { name: /Seleccionar los \d+ que cumplen el filtro/u });
        await selectAll.waitFor({ timeout: 20_000 });
        const totalMatch = /(\d+)/u.exec(await selectAll.innerText());
        if (!totalMatch || Number(totalMatch[1]) <= 25) throw new Error("E8: la selección total no supera la primera página");
        await selectAll.click();
        const selectedToolbar = page.getByRole("toolbar", { name: "Acciones sobre lo seleccionado" });
        await selectedToolbar.getByText(/seleccionados por filtro/u).waitFor();

        const groupPreviewRequest = page.waitForRequest((request) =>
          request.method() === "POST" && request.url().includes("/curation/fixes/preview"));
        await selectedToolbar.getByRole("button", { name: "Corregir seleccionados" }).click();
        const groupRequest = await groupPreviewRequest;
        const groupBody = groupRequest.postDataJSON() as Record<string, unknown>;
        const groupFilterBody = groupBody["filter"] as Record<string, unknown> | undefined;
        if (groupBody["mode"] !== "group" || groupBody["findingIds"] !== undefined || groupFilterBody?.["detector"] !== "caracteres_invisibles") {
          throw new Error(`E8: selección total no usó filter: ${JSON.stringify(groupBody)}`);
        }
        let batchDialog = page.getByRole("dialog");
        await batchDialog.getByRole("table").waitFor({ timeout: 20_000 });
        await page.screenshot({ path: path.join(outputDir, "desktop-seleccion-total-preview.png"), fullPage: true });
        await batchDialog.getByRole("button", { name: "Cancelar" }).click();
        await selectedToolbar.getByRole("button", { name: "Vaciar selección" }).click();

        // E8.2: la misma vista previa sirve para una selección explícita.
        const picks = page.locator('input[id^="cfind-pick-"]');
        if (await picks.count() < 2) throw new Error("E8: faltan dos hallazgos corregibles para probar selección explícita");
        await picks.nth(0).check();
        await picks.nth(1).check();
        const selectedPreviewRequest = page.waitForRequest((request) =>
          request.method() === "POST" && request.url().includes("/curation/fixes/preview"));
        await selectedToolbar.getByRole("button", { name: "Corregir seleccionados" }).click();
        const selectedRequest = await selectedPreviewRequest;
        const selectedBody = selectedRequest.postDataJSON() as Record<string, unknown>;
        const selectedIds = selectedBody["findingIds"] as unknown[] | undefined;
        if (selectedBody["mode"] !== "selected" || !selectedIds || selectedIds.length !== 2) {
          throw new Error(`E8: selección explícita no envió dos findingIds: ${JSON.stringify(selectedBody)}`);
        }
        batchDialog = page.getByRole("dialog");
        await batchDialog.getByRole("table").waitFor({ timeout: 20_000 });
        if (await batchDialog.locator("tbody tr").count() < 2) throw new Error("E8: preview seleccionado no muestra sus dos filas");
        await page.screenshot({ path: path.join(outputDir, "desktop-seleccionados-preview.png"), fullPage: true });
        await batchDialog.getByRole("button", { name: "Cancelar" }).click();
        await selectedToolbar.getByRole("button", { name: "Vaciar selección" }).click();

        // E8.2: una fila con varias acciones puede cambiarse y obliga a
        // recalcular el hash/vista previa antes de aplicar.
        await page.goto(`${webUrl}/curaduria/categoria/nombres_sucios?detector=signos_colgantes&q=${encodeURIComponent("QA Acción alternativa")}`, { waitUntil: "domcontentloaded" });
        const alternateCard = page.locator(".cfind").filter({ hasText: "QA Acción alternativa" }).first();
        await alternateCard.getByRole("button", { name: /Recortar/u }).click();
        batchDialog = page.getByRole("dialog");
        const actionSelect = batchDialog.getByLabel(/Acción para/u);
        await actionSelect.waitFor({ timeout: 20_000 });
        const options = await actionSelect.locator("option").allTextContents();
        if (options.length < 2) throw new Error(`E8: la fila no ofrece acciones alternativas: ${options.join(" | ")}`);
        await actionSelect.selectOption("limpiar_texto");
        await batchDialog.getByText(/Cambiaste una acción/u).waitFor();
        const overrideRequestPromise = page.waitForRequest((request) =>
          request.method() === "POST" && request.url().includes("/curation/fixes/preview"));
        await batchDialog.getByRole("button", { name: "Actualizar vista previa" }).click();
        const overrideRequest = await overrideRequestPromise;
        const overrideBody = overrideRequest.postDataJSON() as {
          overrides?: { byFinding?: Record<string, { actionKey?: string }> };
        };
        if (!Object.values(overrideBody.overrides?.byFinding ?? {}).some((item) => item.actionKey === "limpiar_texto")) {
          throw new Error(`E8: el cambio de acción por fila no llegó al preview: ${JSON.stringify(overrideBody)}`);
        }
        await batchDialog.getByRole("table").waitFor({ timeout: 20_000 });
        await page.screenshot({ path: path.join(outputDir, "desktop-accion-por-fila.png"), fullPage: true });
        await batchDialog.getByRole("button", { name: "Cancelar" }).click();

        // E8.2/M6: una colisión real se muestra antes de cualquier escritura.
        await page.goto(`${webUrl}/curaduria/categoria/nombres_sucios?detector=caracteres_invisibles&q=${encodeURIComponent("QA Colision")}`, { waitUntil: "domcontentloaded" });
        const collisionCard = page.locator(".cfind").filter({ hasText: "QA Colision" }).first();
        await collisionCard.getByRole("button", { name: /Limpiar/u }).click();
        batchDialog = page.getByRole("dialog");
        const collisionPreview = batchDialog.getByRole("button", { name: "Ver corrección" });
        if (await collisionPreview.count()) await collisionPreview.click();
        await batchDialog.getByRole("table").waitFor({ timeout: 20_000 });
        await batchDialog.getByText(/Colisión con «QA Colision Limpia»/u).waitFor();
        await page.screenshot({ path: path.join(outputDir, "desktop-colision-preview.png"), fullPage: true });
        await batchDialog.getByRole("button", { name: "Cancelar" }).click();
      }

      // E7: en escritorio se ejercita la decisión A/B desde tarjeta y el
      // lote por trust_level con un empate que debe quedar fuera.
      if (index === 0) {
        await page.goto(`${webUrl}/curaduria/categoria/valores_en_disputa?detector=cola_de_revision&signature=review%3Afield_conflict`, { waitUntil: "domcontentloaded" });
        await page.getByText("QA fuente alta", { exact: true }).waitFor({ timeout: 20_000 });
        await page.getByText("QA fuente baja", { exact: true }).waitFor();
        const evidenceSides = page.locator(".decision-side");
        if (await evidenceSides.count() < 2) throw new Error("E7: faltan los lados A/B del conflicto");
        for (let sideIndex = 0; sideIndex < 2; sideIndex += 1) {
          const side = evidenceSides.nth(sideIndex);
          const text = await side.innerText();
          if (!/\d{1,2}\/\d{1,2}\/\d{4}/u.test(text)) throw new Error(`E7: el lado ${sideIndex ? "B" : "A"} no muestra la fecha de la evidencia`);
          const evidenceLink = side.getByRole("link", { name: "Ver evidencia" });
          const href = await evidenceLink.getAttribute("href");
          if (!href?.startsWith("https://qa.invalid/")) throw new Error(`E7: el lado ${sideIndex ? "B" : "A"} no muestra la URL de evidencia`);
          await assertTextContrast(side.locator(".decision-side__label"), `E7 lado ${sideIndex ? "B" : "A"}`);
        }
        await page.screenshot({ path: path.join(outputDir, "desktop-e7-conflicto-ab.png"), fullPage: true });
        await page.getByRole("button", { name: "Elegir A" }).first().click();
        const decisionDialog = page.getByRole("dialog");
        await decisionDialog.getByLabel("Motivo *").fill("QA visual E7: elegir la evidencia de la fuente alta");
        await decisionDialog.getByRole("button", { name: "Guardar decisión" }).click();
        await page.getByText("Decisión guardada con auditoría.", { exact: false }).waitFor();

        await page.goto(`${webUrl}/curaduria/categoria/valores_en_disputa?detector=conflictos_abiertos`, { waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: "Resolver por fuente más confiable" }).click();
        const trustDialog = page.getByRole("dialog");
        await trustDialog.getByText(/1 elegibles · 1 empates/u).waitFor({ timeout: 20_000 });
        await page.screenshot({ path: path.join(outputDir, "desktop-e7-confianza-preview.png"), fullPage: true });
        await trustDialog.getByLabel("Motivo *").fill("QA visual E7: aplicar solo trust_level estrictamente mayor");
        await trustDialog.getByRole("button", { name: "Aplicar 1 decisiones" }).click();
        await trustDialog.getByText(/Aplicados: 1 · obsoletos: 0 · fallidos: 0/u).waitFor({ timeout: 20_000 });
        await page.screenshot({ path: path.join(outputDir, "desktop-e7-confianza-aplicada.png"), fullPage: true });
        await page.keyboard.press("Escape");

        // Revisiones vivas: Aceptar y Rechazar desde la tarjeta.
        await page.goto(`${webUrl}/curaduria/categoria/revision_de_ingesta?detector=cola_de_revision&signature=review%3Amissing_url`, { waitUntil: "domcontentloaded" });
        const acceptCard = page.locator(".cfind").filter({ hasText: "QA aceptar revisión" }).first();
        await acceptCard.getByRole("button", { name: "Aceptar" }).click();
        let reviewDialog = page.getByRole("dialog");
        await reviewDialog.getByLabel("Motivo *").fill("QA visual E7: aceptar revisión desde Curaduría");
        await reviewDialog.getByRole("button", { name: "Guardar decisión" }).click();
        await page.getByText("Decisión guardada con auditoría.", { exact: false }).waitFor({ timeout: 20_000 });

        await page.goto(`${webUrl}/curaduria/categoria/revision_de_ingesta?detector=cola_de_revision&signature=review%3Anew_source`, { waitUntil: "domcontentloaded" });
        const rejectCard = page.locator(".cfind").filter({ hasText: "QA rechazar revisión" }).first();
        await rejectCard.getByRole("button", { name: "Rechazar" }).click();
        reviewDialog = page.getByRole("dialog");
        await reviewDialog.getByLabel("Motivo *").fill("QA visual E7: rechazar revisión desde Curaduría");
        await reviewDialog.getByRole("button", { name: "Guardar decisión" }).click();
        await page.getByText("Decisión guardada con auditoría.", { exact: false }).waitFor({ timeout: 20_000 });
        await page.screenshot({ path: path.join(outputDir, "desktop-e7-revisiones.png"), fullPage: true });

        // person_duplicate: el enlace especializado debe precargar ese par.
        await page.goto(`${webUrl}/curaduria/categoria/fichas_repetidas?detector=cola_de_revision&signature=review%3Aperson_duplicate`, { waitUntil: "domcontentloaded" });
        await page.getByRole("link", { name: "Comparar este par" }).first().click();
        await page.getByRole("dialog").getByRole("heading", { name: "Fusionar personas" }).waitFor({ timeout: 20_000 });
        await page.getByText("QA Persona Duplicada Uno", { exact: false }).first().waitFor();
        await page.getByText("QA Persona Duplicada Dos", { exact: false }).first().waitFor();
        await page.screenshot({ path: path.join(outputDir, "desktop-e7-duplicado-precargado.png"), fullPage: true });
        await page.keyboard.press("Escape");

        // Volver al caso E8 de escritorio después de las decisiones E7.
        await page.goto(`${webUrl}/curaduria/categoria/nombres_sucios?q=${encodeURIComponent(targetName)}`, { waitUntil: "domcontentloaded" });
      }

      // E8: teclado + hoja de acciones móvil + preview → aplicar → deshacer
      // se ejecutan en ambos viewports.
      const e8Card = page.locator(".cfind").filter({ hasText: targetName }).first();
      await e8Card.focus();
      await page.keyboard.press("?");
      await page.getByRole("dialog").getByText("Atajos de Curaduría", { exact: true }).waitFor();
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-atajos.png`), fullPage: true });
      await page.keyboard.press("Escape");

      if (index === 0) {
        await page.keyboard.press("j");
        if (await page.locator(".cfind.is-keyboard-active").count() !== 1) {
          throw new Error("desktop: j/k no deja una tarjeta de Curaduría activa");
        }
        await e8Card.focus();
        await page.keyboard.press("x");
        await page.getByRole("toolbar", { name: "Acciones sobre lo seleccionado" }).waitFor();
        await page.keyboard.press("x");
      } else {
        await page.screenshot({ path: path.join(outputDir, "mobile-hoja-acciones.png"), fullPage: true });
      }

      const correctionButton = e8Card.locator(".cfind__actions--primary .btn--primary").first();
      const consequence = correctionButton.locator(".cfind__action-consequence");
      await consequence.waitFor();
      if (!(await consequence.innerText()).match(/^N[0-2] · .+/u)) throw new Error(`${viewport.name}: la acción recomendada no muestra nivel + consecuencia`);
      await assertTextContrast(correctionButton, `${viewport.name}: botón recomendado`);
      await assertTextContrast(consequence, `${viewport.name}: consecuencia de la acción`);
      await correctionButton.hover();
      await assertTextContrast(correctionButton, `${viewport.name}: botón recomendado en hover`);
      await page.mouse.move(0, 0);
      await correctionButton.click();
      const fixDialog = page.getByRole("dialog");
      const seePreview = fixDialog.getByRole("button", { name: "Ver corrección" });
      if (await seePreview.count()) await seePreview.click();
      await fixDialog.getByRole("table").waitFor();
      await fixDialog.getByText(/^Toca:/u).first().waitFor();
      const includeRow = fixDialog.getByRole("checkbox", { name: /Incluir/u }).first();
      await includeRow.uncheck();
      await includeRow.check();
      await fixDialog.locator(".fix-diff .cval").first().waitFor();
      await fixDialog.getByLabel("Motivo *").fill(`QA visual ${viewport.name}: comprobar preview/apply/undo`);
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-preview-lote.png`), fullPage: true });
      await fixDialog.getByRole("button", { name: /^Aplicar \d+ correcciones$/u }).click();
      await fixDialog.getByText("Lote aplicado", { exact: true }).waitFor({ timeout: 20_000 });
      await fixDialog.getByRole("progressbar", { name: "Progreso del lote" }).waitFor();
      await fixDialog.getByText(/aplicados:\s*1/iu).waitFor();
      await page.getByRole("button", { name: "Deshacer", exact: true }).waitFor({ timeout: 10_000 });
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-lote-aplicado.png`), fullPage: true });
      await fixDialog.getByLabel("Motivo para deshacer *").fill(`QA visual ${viewport.name}: restaurar el dato original`);
      await fixDialog.getByRole("button", { name: "Deshacer este lote" }).click();
      await fixDialog.getByText("Lote deshecho.", { exact: false }).waitFor({ timeout: 20_000 });
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-lote-desecho.png`), fullPage: true });
      await fixDialog.getByRole("button", { name: "Cerrar", exact: true }).last().click();

      await page.goto(`${webUrl}/curaduria/correcciones`, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "Correcciones" }).waitFor();
      await page.locator("tbody tr").first().waitFor();
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-correcciones.png`), fullPage: true });
      await assertNoOverflow(page, `${viewport.name} correcciones`);

      // 3. «Otros»: la anomalía sembrada aparece sin regla escrita para ella, y
      //    sus subgrupos se ven por tandas en vez de todos de golpe.
      await page.goto(`${webUrl}/curaduria/categoria/otros`, { waitUntil: "domcontentloaded" });
      await page.getByText("Memoria § Ciudad", { exact: false }).first().waitFor({ timeout: 20_000 });
      const subgroups = page.getByRole("group", { name: "Filtrar por subgrupo" });
      const subgroupChips = subgroups.locator(".cchip--sub");
      const initialChips = await subgroupChips.count();
      if (initialChips !== 7) throw new Error(`${viewport.name}: se esperaban «Todos» y 6 subgrupos de entrada, hay ${initialChips}`);
      const readableEvidence = page.locator(".cfind__evidence").first();
      await readableEvidence.locator(":scope > summary").click();
      await readableEvidence.locator(".evidence-list").waitFor();
      if (await readableEvidence.locator(".evidence-list__row").count() < 1) throw new Error(`${viewport.name}: la evidencia no tiene filas legibles`);
      if (await readableEvidence.locator(".evidence-raw pre").isVisible()) throw new Error(`${viewport.name}: el JSON técnico aparece abierto por defecto`);
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-evidencia-legible.png`), fullPage: true });
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-otros.png`), fullPage: true });
      await subgroups.getByRole("button", { name: /^Ver \d+ más/u }).click();
      await page.waitForFunction((count) => document.querySelectorAll(".cfilters--sub .cchip--sub").length > count, initialChips);
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-otros-mas.png`), fullPage: true });
      await assertNoOverflow(page, `${viewport.name} otros`);

      // 4. «No es un problema» pide un motivo y guarda la decisión con él.
      await page.goto(`${webUrl}/curaduria/categoria/ficha_de_otro_tipo`, { waitUntil: "domcontentloaded" });
      const ignoreButton = page.getByRole("button", { name: "No es un problema" }).first();
      await ignoreButton.waitFor({ timeout: 20_000 });
      const before = await page.getByRole("button", { name: "No es un problema" }).count();
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

      // 5. Corrección por la API (solo la primera vez): quita el invisible pero
      //    mete la ciudad en el nombre. El detector debe verificarla solo.
      if (index === 0) {
        const beforePatch = await lastScanId();
        const response = await fetch(`${apiAddress}/artists/${dirtyArtist}`, {
          method: "PATCH",
          headers: { authorization: `Bearer ${QA_TOKEN}`, "x-crv-operator": "QA Curaduria", "content-type": "application/json", origin: webUrl },
          body: JSON.stringify({ name: "Trueno Negro (Caracas)" }),
        });
        if (!response.ok) throw new Error(`la corrección falló: ${response.status} ${await response.text()}`);
        await waitForCorrectionScan(beforePatch);
        triggeredScanId = await lastScanId();
      }

      if (index === 0) {
        await page.goto(`${webUrl}/curaduria`, { waitUntil: "domcontentloaded" });
        await page.getByRole("link", { name: /desencadenados? por la corrección/u }).first().waitFor({ timeout: 20_000 });
        await page.getByText("La corrección desencadenó", { exact: false }).first().waitFor();
        await page.screenshot({ path: path.join(outputDir, `${viewport.name}-verificacion.png`), fullPage: true });
        await page.getByRole("link", { name: /desencadenados? por la corrección/u }).first().click();
      } else {
        if (triggeredScanId === null) throw new Error("mobile: no se conservó el análisis desencadenado del pase desktop");
        await page.goto(`${webUrl}/curaduria/hallazgos?scanId=${triggeredScanId}&chained=true`, { waitUntil: "domcontentloaded" });
        await page.screenshot({ path: path.join(outputDir, `${viewport.name}-verificacion.png`), fullPage: true });
      }
      await page.getByText("Apareció al corregir", { exact: false }).first().waitFor({ timeout: 20_000 });
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-desencadenados.png`), fullPage: true });
      await assertNoOverflow(page, `${viewport.name} desencadenados`);
      if (index === 1) {
        await page.getByRole("button", { name: "Marcar como revisado" }).first().click();
        await page.getByText("Cadena revisada", { exact: false }).first().waitFor({ timeout: 20_000 });
        const archived = await getPool().query<{ n: string }>(
          `SELECT count(*)::text AS n FROM ingest.curation_findings
            WHERE evidence ? 'triggeredHistory' AND NOT (evidence ? 'triggeredBy')`
        );
        if (Number(archived.rows[0]!.n) < 1) throw new Error("mobile: Marcar como revisado no archivó triggeredBy");
      }

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
