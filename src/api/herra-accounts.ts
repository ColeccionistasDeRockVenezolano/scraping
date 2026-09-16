// CRV · Cuentas compartidas con herra (coleccionistasderockvenezolano.com).
//
// herra es la dueña de las cuentas: el CRV abre su SQLite en solo lectura,
// verifica la contraseña con el mismo scrypt y nunca escribe ni copia hashes.
// Entran los usuarios aprobados del proyecto, sus administradores y el
// superadministrador. Cada sesión recuerda la `session_version` de la cuenta:
// si herra la rechaza, la borra o le cambia la contraseña, la sesión del CRV
// deja de valer en la siguiente petición.
import { randomBytes, scrypt as scryptCallback, scryptSync, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";

export interface HerraAccount {
  kind: "user" | "admin";
  id: number;
  username: string;
  name: string;
  passwordHash: string;
  sessionVersion: number;
}

export interface HerraSessionRef {
  kind: "user" | "admin";
  id: number;
  sessionVersion: number;
}

interface UserRow {
  id: number;
  name: string;
  first_name: string | null;
  last_name: string | null;
  access_code_hash: string;
  session_version: number;
}

interface AdminRow {
  id: number;
  username: string;
  password_hash: string;
  session_version: number;
}

const OPERATOR_NAME_UNSAFE = /[^\p{L}\p{N} ._'-]/gu;

// Hash de relleno con el perfil de herra: una cuenta inexistente cuesta lo
// mismo que una existente.
const DUMMY_SALT = randomBytes(16);
export const HERRA_DUMMY_HASH = `scrypt$16384$8$5$${DUMMY_SALT.toString("hex")}$${
  scryptSync(randomBytes(16), DUMMY_SALT, 64, { N: 16_384, r: 8, p: 5, maxmem: 64 * 1024 * 1024 }).toString("hex")}`;

/** Verifica el formato de herra: scrypt$N$r$p$saltHex$hashHex. */
export async function herraPasswordMatches(password: string, encoded: string): Promise<boolean> {
  const [algorithm, nRaw, rRaw, pRaw, saltHex, expectedHex, extra] = encoded.split("$");
  if (algorithm !== "scrypt" || extra !== undefined || !saltHex || !expectedHex) return false;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || N < 16_384 || N > 1_048_576 || (N & (N - 1)) !== 0) return false;
  if (!Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) return false;
  if (!/^[0-9a-f]+$/iu.test(saltHex) || !/^[0-9a-f]+$/iu.test(expectedHex)) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(expectedHex, "hex");
  if (salt.length < 16 || expected.length < 32 || expected.length > 64) return false;
  const actual = await new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, expected.length, { N, r, p, maxmem: Math.max(64 * 1024 * 1024, 256 * N * r) }, (error, derived) => {
      if (error) reject(error); else resolve(derived);
    });
  });
  return timingSafeEqual(actual, expected);
}

function displayName(value: string): string {
  const clean = value.replace(OPERATOR_NAME_UNSAFE, "").replace(/\s+/gu, " ").trim().slice(0, 80);
  return clean || "colaborador";
}

export class HerraAccounts {
  private db: DatabaseSync | undefined;

  constructor(private readonly path: string, private readonly projectSlug: string) {}

  private open(): DatabaseSync {
    if (!this.db) {
      // import dinámico síncrono: node:sqlite solo se carga si hay herra configurado.
      const { DatabaseSync: Sqlite } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
      this.db = new Sqlite(this.path, { readOnly: true });
    }
    return this.db;
  }

  private projectId(): number | undefined {
    const row = this.open().prepare("SELECT id FROM projects WHERE slug = ?").get(this.projectSlug) as { id: number } | undefined;
    return row?.id;
  }

  /** Busca la cuenta por nombre (sin distinguir mayúsculas). Solo cuentas habilitadas. */
  find(username: string): HerraAccount | undefined {
    const db = this.open();
    const projectId = this.projectId();
    if (projectId !== undefined) {
      const user = db.prepare(
        `SELECT id, name, first_name, last_name, access_code_hash, session_version FROM users
          WHERE project_id = ? AND name = ? COLLATE NOCASE AND status = 'approved' AND access_code_hash IS NOT NULL`,
      ).get(projectId, username) as UserRow | undefined;
      if (user) {
        const full = [user.first_name, user.last_name].filter(Boolean).join(" ");
        return {
          kind: "user",
          id: user.id,
          username: user.name.toLowerCase(),
          name: displayName(full || user.name),
          passwordHash: user.access_code_hash,
          sessionVersion: user.session_version,
        };
      }
    }
    const admin = db.prepare(
      `SELECT id, username, password_hash, session_version FROM admins
        WHERE username = ? COLLATE NOCASE AND (role = 'superadmin' OR project_id = ?)`,
    ).get(username, projectId ?? -1) as AdminRow | undefined;
    if (!admin) return undefined;
    return {
      kind: "admin",
      id: admin.id,
      username: admin.username.toLowerCase(),
      name: displayName(admin.username),
      passwordHash: admin.password_hash,
      sessionVersion: admin.session_version,
    };
  }

  /** ¿Sigue vigente en herra la cuenta con la que se abrió la sesión? */
  stillValid(ref: HerraSessionRef): boolean {
    const db = this.open();
    const row = ref.kind === "user"
      ? db.prepare(
        `SELECT u.session_version FROM users u JOIN projects p ON p.id = u.project_id
          WHERE u.id = ? AND p.slug = ? AND u.status = 'approved' AND u.access_code_hash IS NOT NULL`,
      ).get(ref.id, this.projectSlug)
      : db.prepare(
        `SELECT a.session_version FROM admins a LEFT JOIN projects p ON p.id = a.project_id
          WHERE a.id = ? AND (a.role = 'superadmin' OR p.slug = ?)`,
      ).get(ref.id, this.projectSlug);
    return (row as { session_version: number } | undefined)?.session_version === ref.sessionVersion;
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }
}
