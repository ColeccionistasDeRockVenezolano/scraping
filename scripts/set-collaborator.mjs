#!/usr/bin/env node
import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseDotenv } from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, ".env");
const [usernameRaw, nameRaw, ...flags] = process.argv.slice(2);
const username = usernameRaw?.trim().toLowerCase() ?? "";
const name = nameRaw?.trim() ?? "";
const generatedFlag = flags.find((value) => value.startsWith("--generate="));
const generatedPath = generatedFlag?.slice("--generate=".length);
const disableLegacyToken = flags.includes("--disable-legacy-token");
// admin (por defecto) edita, fusiona y revisa; reader solo inicia sesión y lee.
const role = flags.find((value) => value.startsWith("--role="))?.slice("--role=".length) ?? "admin";

if (!/^[a-z0-9][a-z0-9._-]{2,39}$/u.test(username) || !/^[\p{L}\p{N} ._'-]{1,80}$/u.test(name) || !["admin", "reader"].includes(role)) {
  console.error('Uso: npm run auth:set-collaborator -- usuario "Nombre visible" [--role=admin|reader] [--generate=/ruta/credencial.txt] [--disable-legacy-token]');
  process.exit(1);
}

async function readHiddenPassword() {
  if (!process.stdin.isTTY) {
    let value = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) value += chunk;
    return value.replace(/[\r\n]+$/u, "");
  }
  process.stderr.write("Contraseña (no se mostrará): ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write("\n");
    };
    process.stdin.on("data", (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") { finish(); reject(new Error("cancelado")); return; }
        if (character === "\r" || character === "\n") { finish(); resolve(value); return; }
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else value += character;
      }
    });
  });
}

const password = generatedPath ? randomBytes(24).toString("base64url") : await readHiddenPassword();
if (password.length < 12 || password.length > 200) {
  console.error("La contraseña debe tener entre 12 y 200 caracteres.");
  process.exit(1);
}

const salt = randomBytes(16);
const derived = await new Promise((resolve, reject) => {
  scryptCallback(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, result) => {
    if (error) reject(error); else resolve(result);
  });
});
const passwordHash = `scrypt$16384$8$1$${salt.toString("base64url")}$${derived.toString("base64url")}`;

const source = await readFile(envPath, "utf8");
const configured = parseDotenv(source)["CRV_COLLABORATORS_JSON"];
const accounts = configured ? JSON.parse(configured) : [];
if (!Array.isArray(accounts)) throw new Error("CRV_COLLABORATORS_JSON debe ser un arreglo");
const next = accounts.filter((account) => account?.username !== username);
next.push({ username, name, passwordHash, role });
function setEnvLine(input, key, value) {
  const pattern = new RegExp(`^${key}=.*$`, "mu");
  const line = `${key}=${value}`;
  return pattern.test(input) ? input.replace(pattern, line) : `${input.trimEnd()}\n${line}\n`;
}

let updated = setEnvLine(source, "CRV_COLLABORATORS_JSON", JSON.stringify(next));
updated = setEnvLine(updated, "CRV_SESSION_COOKIE_PATH", "/crv");
updated = setEnvLine(updated, "CRV_SESSION_TTL_HOURS", "12");
if (disableLegacyToken) updated = setEnvLine(updated, "CRV_OPERATOR_TOKEN", "");
const temporary = `${envPath}.auth-${process.pid}`;
await writeFile(temporary, updated, { mode: 0o600 });
await rename(temporary, envPath);

if (generatedPath) {
  const absolute = path.resolve(generatedPath);
  await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
  await writeFile(absolute, `CRV\nUsuario: ${username}\nContraseña temporal: ${password}\n`, { mode: 0o600, flag: "wx" });
  console.log(`Cuenta ${username} actualizada. Credencial temporal guardada con modo 0600 en ${absolute}`);
} else {
  console.log(`Cuenta ${username} actualizada. Reinicia crv-api para invalidar sesiones anteriores y cargarla.`);
}
