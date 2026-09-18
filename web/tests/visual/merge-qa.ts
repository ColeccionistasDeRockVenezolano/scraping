// CRV · QA visual de la fusión de personas (E11.6) contra un contenedor de
// prueba — nunca contra la base de desarrollo.
//
// Siembra con el código real (el detector propone el par; el servicio lo
// fusiona en el caso de la redirección), levanta la API y la web, y captura a
// 1280 y 400 px: la página de duplicados, el modal de fusión, el aviso de
// ficha fusionada y el paso de elegir la otra ficha.
//
// Comprueba de paso lo que no se ve en una captura: sin overflow horizontal,
// sin errores de consola y con el foco atrapado en el modal (Tab no se escapa)
// y Esc cerrando.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { startPgContainer } from "../../../test/support/pg-container.js";
import { applyCore } from "../../../test/support/apply-core.js";
import { migrateUp } from "../../../src/db/migrate.js";
import { getPool, closeDb } from "../../../src/db/client.js";
import { resetEnvCache } from "../../../src/config/env.js";
import { buildApp } from "../../../src/api/app.js";
import { findPersonCandidates, openPersonCandidateReviews } from "../../../src/review/person-candidates.js";
import { mergeEntities, previewEntityMerge } from "../../../src/merge/entity-merge.js";
import { withOperatorRun } from "../../../src/merge/operator.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const outputDir = path.join(root, "docs/ui-qa/merge");
const QA_USER = "qa-fusion";
const QA_PASSWORD = "qa-fusion-2026-segura";

/**
 * Puerto libre del sistema para el servidor de desarrollo. Con un puerto fijo,
 * un `vite` que sobrevivió a una corrida fallida se reutiliza y el QA acaba
 * hablando con una web que apunta a una API muerta (pasado real: la página
 * mostraba «No se pudo cargar»).
 */
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
      } catch { /* El servidor aún está arrancando. */ }
      if (Date.now() >= deadline) return reject(new Error(`Timeout esperando ${url}`));
      setTimeout(() => void attempt(), 200);
    };
    void attempt();
  });
}

function stopChild(child: ChildProcess | undefined): void {
  if (!child || child.killed || !child.pid) return;
  // `detached`: npm y vite son un grupo propio; matar al grupo evita dejar
  // servidores huérfanos escuchando (y contaminando la corrida siguiente).
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

/**
 * Espera a que la SPA pinte algo. `networkidle` no basta: la primera carga
 * contra el servidor de desarrollo puede tardar (vite transforma a demanda) y
 * con la máquina ocupada el cuerpo llega vacío.
 */
async function waitForApp(page: import("@playwright/test").Page, timeoutMs = 60_000): Promise<void> {
  await page.waitForFunction(
    () => (document.querySelector("#root")?.childElementCount ?? 0) > 0, undefined, { timeout: timeoutMs });
}

/** Mismo formato que scripts/hash-collaborator-password.mjs, para la sesión de QA. */
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

const container = await startPgContainer();
let web: ChildProcess | undefined;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;

try {
  process.env["DATABASE_URL"] = container.databaseUrl;
  process.env["LOG_LEVEL"] = "silent";
  // El .env del repo fija Path=/crv (producción bajo /crv/api); aquí el API
  // escucha en la raíz y las lecturas admin necesitan la cookie en todo path.
  process.env["CRV_SESSION_COOKIE_PATH"] = "/";
  process.env[`CRV_COLLABORATORS_JSON`] = JSON.stringify([
    { username: QA_USER, name: "QA Visual", passwordHash: await passwordHash(QA_PASSWORD) },
  ]);
  resetEnvCache();
  await applyCore(container.name);
  await migrateUp();

  // ---- Siembra: el par que el detector propone, con conflicto y relleno ----
  const band = await one("INSERT INTO public.artists(name) VALUES('Banda QA Fusión') RETURNING id");
  const album = await one("INSERT INTO public.albums(artist_id,title) VALUES($1,'Disco QA Fusión') RETURNING id", [band]);
  const keepId = await one(`INSERT INTO public.persons(name,nationality) VALUES('Rómulo "Chino" García QA','Venezolana') RETURNING id`);
  const dropId = await one(`INSERT INTO public.persons(name,nationality,biography) VALUES('Rómulo García QA','Argentina','Biografía que solo tiene la ficha que desaparece.') RETURNING id`);
  await getPool().query("INSERT INTO public.artist_members(artist_id,person_id,role) VALUES($1,$2,'Guitarra')", [band, dropId]);
  await getPool().query("INSERT INTO public.album_credits(album_id,person_id,credit_type,role) VALUES($1,$2,'musician','Guitarra'),($1,$2,'producer','Producción')", [album, dropId]);
  // Organizaciones sembradas: el capturador general también visita una ficha.
  await one("INSERT INTO public.organizations(name,organization_type) VALUES('Estudio QA Visual','recording_studio') RETURNING id");
  // Ficha con nombre que no parece de persona: la ficha debe avisar y ofrecer
  // convertirla (E11.7). Se captura para que ese aviso quede verificado.
  const junkId = await one("INSERT INTO public.persons(name) VALUES('Estudio Basura QA') RETURNING id");

  const scan = await findPersonCandidates();
  const proposed = scan.candidates.filter((candidate) => [candidate.a.id, candidate.b.id].includes(keepId) && [candidate.a.id, candidate.b.id].includes(dropId));
  if (proposed.length !== 1) throw new Error(`el detector no propuso el par sembrado (${proposed.length})`);
  const opened = await openPersonCandidateReviews(proposed, "QA visual de la fusión (contenedor desechable)", "QA Visual");
  console.log(`QA: par sembrado ${keepId}/${dropId} · ${scan.candidates.length} candidatos · ${opened.opened} revisión abierta (run ${opened.runId})`);

  // ---- Siembra: una fusión ya hecha, para el aviso de enlace fusionado ----
  const mergedKeep = await one("INSERT INTO public.persons(name) VALUES('Fusionado QA A') RETURNING id");
  const mergedDrop = await one("INSERT INTO public.persons(name) VALUES('Fusionado QA B') RETURNING id");
  const preview = await previewEntityMerge(getPool(), "person", mergedKeep, mergedDrop);
  await withOperatorRun({ name: "qa:merge", operator: "QA Visual", note: "QA visual del aviso de redirección (E11.2)" },
    (context) => mergeEntities(context, { kind: "person", keepId: mergedKeep, dropId: mergedDrop, previewHash: preview.previewHash, keepDropNameAsAlias: true }));

  // El puerto de la web se elige libre ANTES de construir la API: el CORS solo
  // acepta ese origen exacto.
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
  // Si el proceso muere a mitad, el servidor de desarrollo se lleva consigo.
  process.once("exit", () => stopChild(web));
  process.once("SIGINT", () => { stopChild(web); process.exit(130); });
  process.once("SIGTERM", () => { stopChild(web); process.exit(143); });
  await waitForUrl(webUrl);
  await mkdir(outputDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    for (const viewport of [
      { name: "desktop", width: 1280, height: 1000 },
      { name: "mobile", width: 400, height: 900 },
    ]) {
      const page = await browser.newPage({ viewport });
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) pageErrors.push(message.text()); });

      // 0. Sesión de colaborador: desde 49a3f76 la página de duplicados exige
      //    una cuenta administradora (antes se abría sin sesión).
      await page.goto(`${webUrl}/personas/${junkId}`, { waitUntil: "domcontentloaded" });
      await waitForApp(page);
      await page.getByRole("button", { name: "Iniciar sesión como colaborador" }).click();
      await page.getByLabel("Usuario").fill(QA_USER);
      await page.getByLabel("Contraseña").fill(QA_PASSWORD);
      await page.getByRole("button", { name: "Iniciar sesión", exact: true }).click();
      // Esperar a que la sesión tome efecto antes de navegar (si no, el goto
      // cancela el login en vuelo y la página queda como visitante).
      await page.getByRole("button", { name: "Convertir en organización…" }).waitFor({ timeout: 15000 });
      await page.goto(`${webUrl}/personas/duplicados`, { waitUntil: "domcontentloaded" });
      await waitForApp(page);
      const row = page.getByText("Rómulo García QA", { exact: false }).first();
      await row.waitFor({ timeout: 15000 }).catch(async (error: unknown) => {
        // Sin fila: se guarda lo que la página muestra de verdad (estado vacío o
        // error de la API) para que el fallo diga qué pasó y no solo que faltó.
        await page.screenshot({ path: path.join(outputDir, `${viewport.name}-duplicados-fallo.png`), fullPage: true });
        const shown = (await page.locator("main, .app-main, body").first().innerText()).slice(0, 400);
        throw new Error(`${viewport.name}: no apareció la fila del par sembrado. La página muestra: ${shown.replaceAll("\n", " | ")} (${(error as Error).message.split("\n")[0]})`);
      });
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-duplicados.png`), fullPage: true });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 1) throw new Error(`${viewport.name}: overflow horizontal de ${overflow}px en /personas/duplicados`);

      // 2. Modal de fusión: abre con la previsualización, atrapa el foco y Esc cierra.
      await page.getByRole("button", { name: "Comparar y fusionar" }).first().click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      await page.getByText("Se moverán", { exact: false }).waitFor();
      // La tabla lista solo los campos de esa entidad: una persona no muestra
      // «Ciudad» (artista) ni «Web» (organización).
      for (const foreign of ["Ciudad", "Web"]) {
        if (await dialog.getByText(foreign, { exact: true }).count() > 0) {
          throw new Error(`${viewport.name}: el modal de personas muestra el campo «${foreign}», que no es suyo`);
        }
      }
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-modal-fusion.png`), fullPage: false });

      const focusInside = async () => page.evaluate(() => !!document.querySelector(".modal-panel")?.contains(document.activeElement));
      if (!(await focusInside())) throw new Error(`${viewport.name}: el foco no entró al modal`);
      for (let step = 0; step < 25; step += 1) {
        await page.keyboard.press("Tab");
        if (!(await focusInside())) throw new Error(`${viewport.name}: el foco se escapó del modal en el Tab ${step + 1}`);
      }
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });

      // 3. Enlace a una ficha fusionada: redirige a la que quedó, con aviso.
      await page.goto(`${webUrl}/personas/${mergedDrop}`, { waitUntil: "domcontentloaded" });
      await waitForApp(page);
      await page.waitForURL(`**/personas/${mergedKeep}`);
      await page.getByText("Esta ficha se fusionó con otra", { exact: false }).first().waitFor();
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-ficha-fusionada.png`), fullPage: true });

      // 4. Ficha con nombre que no parece de persona: el aviso es público (E11.7).
      await page.goto(`${webUrl}/personas/${junkId}`, { waitUntil: "domcontentloaded" });
      await waitForApp(page);
      await page.getByText("Este nombre no parece de una persona", { exact: false }).first().waitFor();
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-persona-sospechosa.png`), fullPage: true });

      // 5. Con la sesión ya abierta: «Fusionar con…» y los botones de conversión
      //    (la conversión es una escritura: sin sesión no se ofrecen).
      await page.getByRole("button", { name: "Convertir en organización…" }).waitFor();
      await page.getByRole("button", { name: "Convertir en artista…" }).waitFor();
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-convertir.png`), fullPage: true });
      await page.getByRole("button", { name: "Fusionar con…" }).waitFor();
      await page.getByRole("button", { name: "Fusionar con…" }).click();
      await page.getByRole("dialog").waitFor();
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-elegir-ficha.png`), fullPage: false });
      await page.keyboard.press("Escape");

      if (pageErrors.length) throw new Error(`${viewport.name}: ${pageErrors.join("; ")}`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  // La herramienta de capturas del proyecto, apuntada a este contenedor (nunca
  // a la base de desarrollo): 1280 y 400 px sobre las fichas sembradas.
  const capture = spawnSync(process.execPath, ["web/tests/visual/capture.mjs"], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      CRV_WEB_URL: webUrl,
      CRV_CAPTURE_DIR: path.join(root, "docs/ui-qa/e11"),
      CRV_CAPTURE_MODE: "e11",
      CRV_CAPTURE_EDIT_ROUTE: "/discos/1",
      CRV_CAPTURE_VIEWPORTS: JSON.stringify([{ name: "desktop", width: 1280, height: 1000 }, { name: "mobile", width: 400, height: 900 }]),
      CRV_CAPTURE_ROUTES: JSON.stringify([
        ["buscador", "/?q=Rómulo"],
        ["artistas", "/artistas"],
        ["artista-qa", "/artistas/1"],
        ["disco-qa", "/discos/1"],
        ["persona-qa", "/personas/1"],
        ["persona-sospechosa", `/personas/${junkId}`],
        ["organizacion-qa", "/organizaciones/1"],
        ["personas-duplicados", "/personas/duplicados"],
        ["revision", "/revision"],
        ["revision-detalle", "/revision/1"],
      ]),
      CRV_CAPTURE_USERNAME: QA_USER,
      CRV_CAPTURE_PASSWORD: QA_PASSWORD,
    },
  });
  if (capture.status !== 0) throw new Error(`capture.mjs falló (salida ${capture.status})`);
  console.log(`Capturas de la herramienta del proyecto: ${path.relative(root, path.join(root, "docs/ui-qa/e11"))} (1280 y 400 px).`);
  console.log(`QA visual de fusión: capturas en ${path.relative(root, outputDir)} (1280 y 400 px), sin overflow ni errores de consola.`);
} finally {
  stopChild(web);
  if (app) await app.close();
  await closeDb();
  await container.stop();
}
