// CRV · Configuración de entorno validada con Zod (ARCHITECTURE.md §6).
// Único punto de lectura de process.env: nada más en el código debe leer
// process.env directamente, para que la validación sea real y centralizada.
import { z } from "zod";
import { config as loadDotenv } from "dotenv";

loadDotenv();

const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL es obligatorio (postgresql://usuario:pass@host:puerto/db)"),

  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default("127.0.0.1"),

  DATA_DIR: z.string().default("./data"),

  CRAWL_USER_AGENT: z.string().default("CRV-bot/0.1"),
  CRAWL_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  CRAWL_DELAY_MS: z.coerce.number().int().nonnegative().default(1000),
  CRAWL_MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),
  CRAWL_CACHE_TTL_DAYS: z.coerce.number().int().positive().default(7),

  // Opcionales: el sistema debe funcionar sin ellas (CONTRACT §6/§12, ARCH §4.11).
  YOUTUBE_API_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_MODEL: z.string().default("deepseek-chat"),
  DEEPSEEK_MAX_TOKENS_PER_RUN: z.coerce.number().int().positive().default(4000),

  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/** Valida y devuelve el entorno (memoizado). Lanza con un mensaje legible si falta algo. */
export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Configuración de entorno inválida:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Solo para tests: permite forzar un entorno distinto entre casos. */
export function resetEnvCache(): void {
  cached = undefined;
}
