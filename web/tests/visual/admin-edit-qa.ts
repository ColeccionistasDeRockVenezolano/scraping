// CRV · QA end-to-end de las funciones de administración (2026-09-18) contra
// un contenedor de prueba — nunca contra la base de desarrollo.
//
// Cubre, por la interfaz real y comprobando la BASE DE DATOS después de cada
// paso: editar la ficha del disco, corregir un crédito (rol y acreditado),
// editar un formato, corregir una membresía (incluida la persona), gestionar
// los vínculos persona↔organización (alta, edición, retiro), dividir una
// persona, fusionar dos discos, ver el historial de cambios y aplicar/deshacer
// un lote de corrección de curaduría (vista previa incluida).
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "@playwright/test";
import { startPgContainer } from "../../../test/support/pg-container.js";
import { applyCore } from "../../../test/support/apply-core.js";
import { migrateUp } from "../../../src/db/migrate.js";
import { getPool, closeDb } from "../../../src/db/client.js";
import { resetEnvCache } from "../../../src/config/env.js";
import { buildApp } from "../../../src/api/app.js";
import { runCurationScan } from "../../../src/curation/scan.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const outputDir = path.join(root, "docs/ui-qa/admin-edit");
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
  if (!child || child.killed || !child.pid) return;
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
  if (String(actual) !== String(expected)) {
    throw new Error(`${what}: se esperaba ${JSON.stringify(expected)} y la base dice ${JSON.stringify(actual)}`);
  }
}

const container = await startPgContainer();
let web: ChildProcess | undefined;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;

try {
  process.env["DATABASE_URL"] = container.databaseUrl;
  process.env["LOG_LEVEL"] = "silent";
  // El .env del repo fija Path=/crv (la producción vive bajo /crv/api); en el
  // contenedor el API escucha en la raíz, así que la cookie debe viajar con
  // Path=/ o el navegador no la manda en las escrituras.
  process.env["CRV_SESSION_COOKIE_PATH"] = "/";
  process.env["CRV_COLLABORATORS_JSON"] = JSON.stringify([
    { username: QA_USER, name: "QA Admin", passwordHash: await passwordHash(QA_PASSWORD) },
  ]);
  resetEnvCache();
  await applyCore(container.name);
  await migrateUp();

  // ---- Siembra (SQL directo: el foco es la interfaz de administración) ----
  const one = async (sql: string, params: unknown[] = []): Promise<number> =>
    Number((await rows<{ id: string }>(sql, params))[0]!.id);
  const artist1 = await one("INSERT INTO public.artists(name, artist_type, origin_country) VALUES('Los Editables QA','band','Venezuela') RETURNING id");
  const artist2 = await one("INSERT INTO public.artists(name, artist_type, origin_country) VALUES('Banda Destino QA','band','Venezuela') RETURNING id");
  const albumA = await one("INSERT INTO public.albums(artist_id, title) VALUES($1,'Disco Editable QA') RETURNING id", [artist1]);
  const albumB = await one("INSERT INTO public.albums(artist_id, title) VALUES($1,'Disco A Fusionar QA') RETURNING id", [artist1]);
  const trackB = await one("INSERT INTO public.tracks(album_id, title, disc_number, track_number) VALUES($1,'Pista Exclusiva QA',1,1) RETURNING id", [albumB]);
  const alice = await one("INSERT INTO public.persons(name) VALUES('Alicia Editable QA') RETURNING id");
  const beto = await one("INSERT INTO public.persons(name) VALUES('Beto Editable QA') RETURNING id");
  const dirty = await one("INSERT INTO public.persons(name) VALUES('QA Con  Doble Espacio') RETURNING id");
  const org1 = await one("INSERT INTO public.organizations(name, organization_type) VALUES('Estudio Editable QA','recording_studio') RETURNING id");
  const membershipId = await one("INSERT INTO public.artist_members(artist_id, person_id, role) VALUES($1,$2,'Voz') RETURNING id", [artist1, alice]);
  const creditId = await one("INSERT INTO public.album_credits(album_id, person_id, credit_type, role) VALUES($1,$2,'musician','Guitarra') RETURNING id", [albumA, alice]);
  await getPool().query("INSERT INTO public.album_formats(album_id, format, quality, archive_status) VALUES($1,'MP3','unknown','unknown')", [albumA]);
  const combinada = await one("INSERT INTO public.persons(name) VALUES('Combinada QA') RETURNING id");
  await getPool().query("INSERT INTO public.album_credits(album_id, person_id, credit_type, role) VALUES($1,$2,'musician','Metales')", [albumA, combinada]);
  console.log(`QA: sembrado disco ${albumA}/${albumB}, personas ${alice}/${beto}/${combinada}/${dirty}`);

  // El detector encuentra el nombre con espacios de más (la corrección del lote).
  const scan = await runCurationScan({ trigger: "manual" });
  console.log(`QA: análisis ${scan.scanId} · ${scan.total} hallazgos · ${scan.inserted} nuevos`);

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
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) pageErrors.push(message.text());
      if (message.type() === "error") console.log(`   !! consola: ${message.text().slice(0, 300)}`);
    });
    page.on("requestfailed", (request) => {
      console.log(`   !! FALLÓ ${request.method()} ${request.url()} :: ${request.failure()?.errorText ?? ""}`);
    });

    const shot = (name: string) => page.screenshot({ path: path.join(outputDir, `desktop-${name}.png`), fullPage: true });

    // Trazas de diagnóstico: toda petición no-GET de la interfaz, con payload y respuesta.
    page.on("request", (request) => {
      if (request.method() === "GET") return;
      console.log(`   REQ ${request.method()} ${new URL(request.url()).pathname} cookie=${/crv_session/u.test(request.headers()["cookie"] ?? "")}`);
    });
    page.on("response", (response) => {
      const request = response.request();
      if (request.method() === "GET") return;
      if (/auth\/login/u.test(request.url())) console.log(`   set-cookie= ${JSON.stringify(response.headers()["set-cookie"] ?? "(ninguna)")}`);
      void response.text().then((body) => {
        console.log(`   ${request.method()} ${new URL(request.url()).pathname} -> ${response.status()} req=${(request.postData() ?? "").slice(0, 200)} res=${body.slice(0, 200)}`);
      }).catch(() => { /* sin cuerpo */ });
    });

    const closeModal = async (dialog: import("@playwright/test").Locator, what: string, extra?: () => Promise<unknown>) => {
      try {
        await dialog.waitFor({ state: "detached", timeout: 15000 });
      } catch (error) {
        await page.screenshot({ path: path.join(outputDir, `fallo-${what}.png`), fullPage: true }).catch(() => {});
        const text = await dialog.innerText().catch(() => "(sin texto)");
        const detail = extra ? await extra().catch(() => "(sin detalle)") : "";
        throw new Error(`[${what}] el modal no cerró (${(error as Error).message.split("\n")[0]}). extra=${JSON.stringify(detail)}\n--- modal ---\n${text.slice(0, 900)}`, { cause: error });
      }
    };

    // ---- Sesión de colaborador ------------------------------------------------
    await page.goto(`${webUrl}/discos/${albumA}`, { waitUntil: "domcontentloaded" });
    await waitForApp(page);
    await page.getByRole("button", { name: "Iniciar sesión como colaborador" }).click();
    await page.getByLabel("Usuario").fill(QA_USER);
    await page.getByLabel("Contraseña").fill(QA_PASSWORD);
    await page.getByRole("button", { name: "Iniciar sesión", exact: true }).click();
    await page.locator(".page-actions").getByRole("button", { name: "Fusionar con…" }).waitFor({ timeout: 15000 });
    console.log("   cookies tras login: " + JSON.stringify((await context.cookies()).map((cookie) => ({ name: cookie.name, domain: cookie.domain, path: cookie.path, sameSite: cookie.sameSite, secure: cookie.secure }))));

    // ---- 1. Editar la ficha del disco (género) --------------------------------
    await page.locator(".page-actions").getByRole("button", { name: "Editar" }).click();
    const editAlbum = page.getByRole("dialog");
    await editAlbum.getByLabel("Género").fill("Rock QA");
    await editAlbum.getByLabel("Motivo *").fill("QA: clasificar el género del disco");
    console.log(`   valores antes de guardar: género=${JSON.stringify(await editAlbum.getByLabel("Género").inputValue())} motivo=${JSON.stringify(await editAlbum.getByLabel("Motivo *").inputValue())}`);
    await editAlbum.getByRole("button", { name: "Guardar" }).click();
    await closeModal(editAlbum, "editar-disco", async () => editAlbum.innerText());
    assertEqual((await rows<{ genre: string }>("SELECT genre FROM public.albums WHERE id=$1", [albumA]))[0]!.genre, "Rock QA", "género del disco");

    // ---- 2. Corregir un crédito: rol + acreditado (persona → artista) ---------
    const creditRow = page.locator("li.credit-row", { hasText: "Alicia Editable QA" }).first();
    await creditRow.getByRole("button", { name: "Editar" }).click();
    const editCredit = page.getByRole("dialog");
    await editCredit.getByLabel("Rol (texto de la fuente) *").fill("Guitarra líder");
    await editCredit.getByLabel("Se acredita a").selectOption("artist");
    const creditPicker = editCredit.getByLabel("Acreditado *");
    await creditPicker.click();
    await creditPicker.fill("Banda Destino QA");
    await editCredit.getByRole("option", { name: /Banda Destino QA/ }).click({ timeout: 15000 });
    await editCredit.getByLabel("Motivo *").fill("QA: el crédito era de la banda, no de la persona");
    await editCredit.getByRole("button", { name: "Guardar corrección" }).click();
    await closeModal(editCredit, "editar-credito");
    const creditRowDb = (await rows<{ person_id: string | null; artist_id: string | null; role: string }>(
      "SELECT person_id::text, artist_id::text, role FROM public.album_credits WHERE id=$1", [creditId]))[0]!;
    assertEqual(creditRowDb.person_id, null, "crédito: persona liberada");
    assertEqual(creditRowDb.artist_id, artist2, "crédito: artista acreditado");
    assertEqual(creditRowDb.role, "Guitarra líder", "crédito: rol");
    const creditAudit = await rows<{ field: string }>(
      "SELECT field FROM ingest.merge_audit WHERE entity_kind='album_credit' AND album_credit_id=$1 ORDER BY id", [creditId]);
    for (const field of ["role", "person_id", "artist_id"]) {
      if (!creditAudit.some((row) => row.field === field)) throw new Error(`auditoría del crédito sin fila para ${field}`);
    }
    await page.locator("li.credit-row", { hasText: "Banda Destino QA" }).first().waitFor();
    await shot("credito-corregido");

    // ---- 3. Editar un formato (calidad y estado) ------------------------------
    const formatRow = page.locator("li.chip", { hasText: "MP3" }).first();
    await formatRow.getByRole("button", { name: "Editar" }).click();
    const editFormat = page.getByRole("dialog");
    await editFormat.getByLabel("Calidad").selectOption("HQ");
    await editFormat.getByLabel("Estado del archivo").selectOption("published");
    await editFormat.getByLabel("Motivo *").fill("QA: el archivo está en alta y publicado");
    await editFormat.getByRole("button", { name: "Guardar corrección" }).click();
    await closeModal(editFormat, "editar-formato");
    const formatDb = (await rows<{ quality: string; archive_status: string }>(
      "SELECT quality, archive_status FROM public.album_formats WHERE album_id=$1 AND format='MP3'", [albumA]))[0]!;
    assertEqual(formatDb.quality, "HQ", "formato: calidad");
    assertEqual(formatDb.archive_status, "published", "formato: estado");

    // ---- 4. Corregir una membresía: persona + rol + hasta ---------------------
    await page.goto(`${webUrl}/artistas/${artist1}`, { waitUntil: "domcontentloaded" });
    await waitForApp(page);
    const memberRow = page.locator("tbody tr", { hasText: "Alicia Editable QA" }).first();
    await memberRow.getByRole("button", { name: "Editar" }).click();
    const editMember = page.getByRole("dialog");
    const memberPicker = editMember.getByLabel("Persona *");
    await memberPicker.click();
    await memberPicker.fill("Beto Editable QA");
    await editMember.getByRole("option", { name: /Beto Editable QA/ }).click({ timeout: 15000 });
    await editMember.getByLabel("Rol *").fill("Voz principal");
    await editMember.getByLabel("Hasta (año)").fill("2001");
    await editMember.getByLabel("Motivo *").fill("QA: la membresía era de Beto y con otro rol");
    await editMember.getByRole("button", { name: "Guardar corrección" }).click();
    await closeModal(editMember, "editar-miembro");
    const memberDb = (await rows<{ person_id: string; role: string; to_year: number }>(
      "SELECT person_id::text, role, to_year FROM public.artist_members WHERE id=$1", [membershipId]))[0]!;
    assertEqual(memberDb.person_id, beto, "membresía: persona");
    assertEqual(memberDb.role, "Voz principal", "membresía: rol");
    assertEqual(memberDb.to_year, 2001, "membresía: año final");

    // ---- 5. Organizaciones de la persona: alta, edición y retiro --------------
    await page.goto(`${webUrl}/personas/${alice}`, { waitUntil: "domcontentloaded" });
    await waitForApp(page);
    await page.getByRole("button", { name: "+ Añadir organización" }).click();
    const addOrg = page.getByRole("dialog");
    const orgPicker = addOrg.getByLabel("Organización *");
    await orgPicker.click();
    await orgPicker.fill("Estudio Editable QA");
    await addOrg.getByRole("option", { name: /Estudio Editable QA/ }).click({ timeout: 15000 });
    await addOrg.getByLabel("Rol *").fill("Coros");
    await addOrg.getByLabel("Desde (año)").fill("1998");
    await addOrg.getByLabel("Motivo *").fill("QA: registro el paso por el estudio");
    await addOrg.getByRole("button", { name: "Añadir", exact: true }).click();
    await closeModal(addOrg, "alta-organizacion");
    const orgLink = (await rows<{ id: string; role: string; from_year: number; organization_id: string }>(
      "SELECT id::text, role, from_year, organization_id::text FROM public.person_organizations WHERE person_id=$1", [alice]))[0]!;
    assertEqual(orgLink.organization_id, org1, "vínculo: organización");
    assertEqual(orgLink.role, "Coros", "vínculo: rol inicial");
    assertEqual(orgLink.from_year, 1998, "vínculo: desde");

    const orgRow = page.locator("tbody tr", { hasText: "Estudio Editable QA" }).first();
    await orgRow.getByRole("button", { name: "Editar" }).click();
    const editOrg = page.getByRole("dialog");
    await editOrg.getByLabel("Rol *").fill("Dirección");
    await editOrg.getByLabel("Motivo *").fill("QA: el rol correcto es dirección");
    await editOrg.getByRole("button", { name: "Guardar corrección" }).click();
    await closeModal(editOrg, "editar-organizacion");
    assertEqual((await rows<{ role: string }>("SELECT role FROM public.person_organizations WHERE id=$1", [Number(orgLink.id)]))[0]!.role, "Dirección", "vínculo: rol corregido");

    await orgRow.getByRole("button", { name: "Quitar" }).click();
    const removeOrg = page.getByRole("dialog");
    await removeOrg.locator("#confirm-note").fill("QA: el vínculo no correspondía");
    await removeOrg.getByRole("button", { name: "Quitar", exact: true }).click();
    await closeModal(removeOrg, "retirar-organizacion");
    assertEqual((await rows("SELECT 1 FROM public.person_organizations WHERE person_id=$1", [alice])).length, 0, "vínculo retirado");

    // ---- 6. Dividir a la persona combinada ------------------------------------
    await page.goto(`${webUrl}/personas/${combinada}`, { waitUntil: "domcontentloaded" });
    await waitForApp(page);
    await page.getByRole("button", { name: "Dividir en varias…" }).click();
    const split = page.getByRole("dialog");
    await split.getByLabel("Nombre 1").fill("Combinada Uno QA");
    await split.getByLabel("Nombre 2").fill("Combinada Dos QA");
    await split.getByRole("button", { name: "Previsualizar reparto" }).click();
    await split.getByText("Ficha nueva", { exact: false }).first().waitFor({ timeout: 15000 });
    await split.locator("#split-note").fill("QA: la ficha combinaba dos personas distintas");
    await split.getByRole("button", { name: "Dividir la persona" }).click();
    await split.getByText("División completada", { exact: false }).waitFor({ timeout: 30000 });
    await shot("division");
    await split.getByRole("button", { name: "Ir a las fichas" }).click();
    await page.waitForURL(/\/personas\/\d+/u);
    const targets = await rows<{ id: string }>("SELECT id::text FROM public.persons WHERE name IN ('Combinada Uno QA','Combinada Dos QA') ORDER BY id");
    if (targets.length !== 2) throw new Error(`la división no dejó dos fichas (${targets.length})`);
    assertEqual((await rows("SELECT 1 FROM public.persons WHERE id=$1", [combinada])).length, 0, "ficha combinada retirada");
    const metales = await rows<{ person_id: string }>("SELECT person_id::text FROM public.album_credits WHERE album_id=$1 AND role='Metales' AND person_id = ANY($2::bigint[])", [albumA, targets.map((row) => Number(row.id))]);
    assertEqual(metales.length, 2, "créditos repartidos a los dos destinos");

    // ---- 7. Fusionar dos discos (con vista previa) ----------------------------
    await page.goto(`${webUrl}/discos/${albumB}`, { waitUntil: "domcontentloaded" });
    await waitForApp(page);
    await page.locator(".page-actions").getByRole("button", { name: "Fusionar con…" }).click();
    const merge = page.getByRole("dialog");
    const mergePicker = merge.getByRole("combobox");
    await mergePicker.click();
    await mergePicker.fill("Disco Editable QA");
    await merge.getByRole("option", { name: /Disco Editable QA/ }).click({ timeout: 15000 });
    // La previsualización llega cuando aparece el primer panel comparado.
    await merge.locator(".compare-side").first().waitFor({ timeout: 20000 });
    // El motor recomienda el que quede; aquí se fuerza que quede el disco A.
    let keepSide = await merge.locator(".compare-side").first().innerText();
    if (!keepSide.includes("Disco Editable QA")) {
      await merge.getByRole("button", { name: /Intercambiar/ }).click();
      await merge.locator(".compare-side").first().filter({ hasText: "Disco Editable QA" }).waitFor({ timeout: 20000 });
      keepSide = await merge.locator(".compare-side").first().innerText();
    }
    await merge.locator("#album-merge-note").fill("QA: son el mismo disco, se conserva el título completo");
    await merge.getByRole("button", { name: /^Fusionar «/u }).click();
    await merge.getByText("Fusión completada", { exact: false }).waitFor({ timeout: 30000 });
    await shot("fusion-discos");
    await merge.getByRole("button", { name: "Ir al disco" }).click();
    await page.waitForURL(`**/discos/${albumA}`);
    assertEqual((await rows("SELECT 1 FROM public.albums WHERE id=$1", [albumB])).length, 0, "disco que desaparece retirado");
    assertEqual((await rows("SELECT to_id::text FROM ingest.entity_redirects WHERE entity_kind='album' AND from_id=$1", [albumB]))[0]!.to_id, String(albumA), "redirección del disco");
    assertEqual((await rows<{ album_id: string }>("SELECT album_id::text FROM public.tracks WHERE id=$1", [trackB]))[0]!.album_id, String(albumA), "pista movida al disco que queda");

    // ---- 8. Historial de cambios en la ficha ----------------------------------
    const history = page.locator(".section", { hasText: "Historial de cambios" }).first();
    await history.waitFor({ timeout: 15000 });
    await history.locator("tbody tr").first().waitFor({ timeout: 15000 });
    const historyRows = await history.locator("tbody tr").count();
    if (historyRows < 2) throw new Error(`el historial del disco tiene ${historyRows} filas; se esperaban al menos 2`);
    if (!(await history.innerText()).includes("Género")) throw new Error("el historial no muestra el cambio de «Género»");
    await shot("historial");

    // ---- 9. Lote de curaduría: vista previa → aplicar → deshacer --------------
    await page.goto(`${webUrl}/curaduria/hallazgos?q=Doble`, { waitUntil: "domcontentloaded" });
    await waitForApp(page);
    const finding = page.locator("article.cfind", { hasText: "QA Con" }).first();
    await finding.waitFor({ timeout: 20000 });
    await finding.getByRole("button", { name: "Corregir" }).click();
    const batch = page.getByRole("dialog");
    await batch.getByRole("button", { name: "Ver corrección" }).click();
    await batch.getByRole("button", { name: /Aplicar 1/u }).waitFor({ timeout: 20000 });
    await batch.locator("#fixbatch-note").fill("QA: quitar los espacios repetidos");
    await batch.getByRole("button", { name: /Aplicar 1/u }).click();
    await batch.getByText("Lote aplicado", { exact: false }).waitFor({ timeout: 30000 });
    assertEqual((await rows<{ name: string }>("SELECT name FROM public.persons WHERE id=$1", [dirty]))[0]!.name, "QA Con Doble Espacio", "lote aplicado: nombre limpio");
    await shot("lote-aplicado");
    await batch.locator("#fixbatch-undo-note").fill("QA: revertir para probar el deshacer");
    await batch.getByRole("button", { name: "Deshacer este lote" }).click();
    await batch.getByText("Lote deshecho", { exact: false }).waitFor({ timeout: 30000 });
    assertEqual((await rows<{ name: string }>("SELECT name FROM public.persons WHERE id=$1", [dirty]))[0]!.name, "QA Con  Doble Espacio", "lote deshecho: nombre restaurado");

    // ---- Cierre: móvil, sin overflow ni errores --------------------------------
    await page.setViewportSize({ width: 400, height: 900 });
    for (const [name, url] of [["disco", `/discos/${albumA}`], ["persona", `/personas/${(await rows<{ id: string }>("SELECT id::text FROM public.persons WHERE name='Combinada Uno QA'"))[0]!.id}`]] as const) {
      await page.goto(`${webUrl}${url}`, { waitUntil: "domcontentloaded" });
      await waitForApp(page);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 1) throw new Error(`móvil: overflow de ${overflow}px en ${url}`);
      await page.screenshot({ path: path.join(outputDir, `mobile-${name}.png`), fullPage: true });
    }

    if (pageErrors.length) throw new Error(`errores de consola: ${pageErrors.join("; ")}`);
    console.log(`QA de administración: todo en verde. Capturas en ${path.relative(root, outputDir)}.`);
  } finally {
    await browser.close();
  }
} finally {
  stopChild(web);
  if (app) await app.close();
  await closeDb();
  await container.stop();
}
