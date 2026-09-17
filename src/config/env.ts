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
  // El bearer histórico queda disponible solo para scripts internos. La web
  // usa cuentas scrypt y sesiones HttpOnly configuradas en el JSON siguiente.
  CRV_OPERATOR_TOKEN: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().min(24, "CRV_OPERATOR_TOKEN debe tener al menos 24 caracteres").optional(),
  ),
  // Nombre por defecto con que se firman las decisiones cuando la petición no
  // trae la cabecera X-CRV-Operator.
  CRV_OPERATOR_NAME: z.string().trim().min(1).max(80).default("operador"),
  CRV_COLLABORATORS_JSON: z.string().optional(),
  // Base SQLite de herra (coleccionistasderockvenezolano.com). Si está, sus
  // cuentas también inician sesión en el CRV; se abre en solo lectura.
  CRV_HERRA_DB_PATH: z.preprocess((value) => value === "" ? undefined : value, z.string().optional()),
  CRV_HERRA_PROJECT_SLUG: z.string().min(1).default("coleccionistas-rock-venezolano"),
  CRV_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  CRV_SESSION_COOKIE_PATH: z.string().regex(/^\/[A-Za-z0-9/_-]*$/u).default("/"),
  CRV_ALLOWED_ORIGINS: z.string().default("http://127.0.0.1:5173,http://localhost:5173"),

  // Detector de conflictos de Curaduría (src/curation/). Cada escritura de
  // la API dispara un análisis que verifica si la corrección abrió errores
  // nuevos; el vigilante compara cada tanto los contadores del catálogo para
  // cubrir cambios hechos fuera de la API. 0 apaga el vigilante.
  CRV_CURATION_AUTOSCAN: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  CRV_CURATION_WATCH_MS: z.coerce.number().int().nonnegative().default(60_000),
  // Lotes de correcciones de Curaduría (PLAN_CURADURIA E4): cuántos ítems
  // aplica o deshace una llamada (el resto sigue con otra llamada explícita) y
  // cuántos hallazgos entran como máximo en la vista previa de un lote.
  CRV_CURATION_FIX_BATCH_MAX: z.coerce.number().int().positive().max(5000).default(500),
  CRV_CURATION_FIX_PREVIEW_MAX: z.coerce.number().int().positive().max(50_000).default(5000),

  DATA_DIR: z.string().default("./data"),

  CRAWL_USER_AGENT: z.string().default("CRV-bot/0.1"),
  CRAWL_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  CRAWL_DELAY_MS: z.coerce.number().int().nonnegative().default(1000),
  CRAWL_MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),
  CRAWL_CACHE_TTL_DAYS: z.coerce.number().int().positive().default(7),

  // Opcionales: el sistema debe funcionar sin ellas (CONTRACT §6/§12, ARCH §4.11).
  YOUTUBE_API_KEY: z.string().optional(),
  // Presupuesto diario de la clave (YouTube concede 10.000 unidades). El
  // enriquecimiento dirigido no gasta si lo consumido hoy no deja margen.
  YOUTUBE_DAILY_QUOTA_UNITS: z.coerce.number().int().positive().default(10_000),
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_BASE_URL: z.string().url().default("https://api.deepseek.com"),
  DEEPSEEK_MODEL_FAST: z.string().min(1).default("deepseek-v4-flash-0731"),
  DEEPSEEK_MODEL_REASONING: z.string().min(1).default("deepseek-v4-pro-0813"),
  DEEPSEEK_MODEL_VISION: z.string().min(1).default("deepseek-v4-flash-vision-exp"),
  DEEPSEEK_MAX_TOKENS_PER_RUN: z.coerce.number().int().positive().default(4000),
  DEEPSEEK_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  ER_AUTO_MATCH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.9),
  ER_POSSIBLE_MATCH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.72),
  ER_REVIEW_THRESHOLD: z.coerce.number().min(0).max(1).default(0.5),
  ER_NO_MATCH_THRESHOLD: z.coerce.number().min(0).max(1).default(0),
  ER_MINIMUM_MARGIN: z.coerce.number().min(0).max(1).default(0.08),

  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
}).superRefine((value, ctx) => {
  if (!(value.ER_AUTO_MATCH_THRESHOLD > value.ER_POSSIBLE_MATCH_THRESHOLD
    && value.ER_POSSIBLE_MATCH_THRESHOLD > value.ER_REVIEW_THRESHOLD
    && value.ER_REVIEW_THRESHOLD > value.ER_NO_MATCH_THRESHOLD)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["ER_AUTO_MATCH_THRESHOLD"],
      message: "thresholds ER invalidos: AUTO_MATCH > POSSIBLE_MATCH > REVIEW > NO_MATCH",
    });
  }
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
