import { randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerOperatorAuth, resetAuthStateForTests } from "../../src/api/auth.js";
import { toApiError } from "../../src/api/http-errors.js";
import { resetEnvCache } from "../../src/config/env.js";

const PASSWORD = "clave-compartida-herra";

function herraHash(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16_384, r: 8, p: 5, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$5$${salt.toString("hex")}$${hash.toString("hex")}`;
}

describe("sesiones con cuentas de herra", () => {
  let app: FastifyInstance;
  let dir: string;
  let db: DatabaseSync;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "crv-herra-"));
    const file = path.join(dir, "roadmap.db");
    db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE projects (id INTEGER PRIMARY KEY, slug TEXT NOT NULL);
      CREATE TABLE users (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, name TEXT NOT NULL COLLATE NOCASE,
        first_name TEXT, last_name TEXT, access_code_hash TEXT, session_version INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'approved');
      CREATE TABLE admins (id INTEGER PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE, password_hash TEXT NOT NULL,
        role TEXT NOT NULL, project_id INTEGER, session_version INTEGER NOT NULL DEFAULT 0);
      INSERT INTO projects VALUES (1, 'coleccionistas-rock-venezolano'), (2, 'otro');
    `);
    const hash = herraHash(PASSWORD);
    db.prepare("INSERT INTO users (id, project_id, name, first_name, last_name, access_code_hash) VALUES (1, 1, 'Pedro', 'Pedro', 'Pérez', ?)").run(hash);
    db.prepare("INSERT INTO users (id, project_id, name, access_code_hash, status) VALUES (2, 1, 'Pendiente', ?, 'pending')").run(hash);
    db.prepare("INSERT INTO users (id, project_id, name, access_code_hash) VALUES (3, 2, 'Ajeno', ?)").run(hash);
    db.prepare("INSERT INTO admins (id, username, password_hash, role, project_id) VALUES (1, 'jefe', ?, 'superadmin', NULL)").run(hash);

    delete process.env["CRV_COLLABORATORS_JSON"];
    delete process.env["CRV_OPERATOR_TOKEN"];
    process.env["CRV_HERRA_DB_PATH"] = file;
    resetEnvCache();
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.setErrorHandler((error, _request, reply) => {
      const expected = toApiError(error);
      if (expected) return reply.status(expected.statusCode).send({ error: { code: expected.code, message: expected.message } });
      return reply.send(error);
    });
    await registerOperatorAuth(app);
    app.post("/protected", async (request) => ({ operator: request.operator }));
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env["CRV_HERRA_DB_PATH"];
    resetEnvCache();
    resetAuthStateForTests();
  });

  const login = (username: string, password = PASSWORD) =>
    app.inject({ method: "POST", url: "/auth/login", payload: { username, password } });

  it("acepta usuarios aprobados y superadmins, y firma con su nombre", async () => {
    const user = await login("pedro");
    expect(user.statusCode).toBe(200);
    expect(user.json()).toMatchObject({ user: { username: "pedro", name: "Pedro Pérez" } });
    const cookie = (user.headers["set-cookie"] as string).split(";", 1)[0]!;
    const written = await app.inject({ method: "POST", url: "/protected", headers: { cookie, "x-crv-csrf": user.json().csrf } });
    expect(written.json()).toEqual({ operator: "Pedro Pérez" });

    expect((await login("JEFE")).statusCode).toBe(200);
  });

  it("rechaza contraseñas malas, cuentas pendientes y cuentas de otro proyecto", async () => {
    for (const [username, password] of [["pedro", "incorrecta"], ["pendiente", PASSWORD], ["ajeno", PASSWORD], ["nadie", PASSWORD]] as const) {
      const rejected = await login(username, password);
      expect(rejected.statusCode).toBe(401);
      expect(rejected.json()).toMatchObject({ error: { code: "invalid_credentials" } });
    }
  });

  it("invalida la sesión cuando herra cambia la contraseña o rechaza la cuenta", async () => {
    const user = await login("pedro");
    const cookie = (user.headers["set-cookie"] as string).split(";", 1)[0]!;
    expect((await app.inject({ method: "GET", url: "/auth/me", headers: { cookie } })).statusCode).toBe(200);

    db.prepare("UPDATE users SET session_version = session_version + 1 WHERE id = 1").run();
    expect((await app.inject({ method: "GET", url: "/auth/me", headers: { cookie } })).statusCode).toBe(401);
    const write = await app.inject({ method: "POST", url: "/protected", headers: { cookie, "x-crv-csrf": user.json().csrf } });
    expect(write.statusCode).toBe(401);
  });
});
