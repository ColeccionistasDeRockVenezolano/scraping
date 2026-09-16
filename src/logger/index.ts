// CRV · Logger estructurado (Pino). ARCHITECTURE.md §6: JSON a stdout;
// nunca aborta el proceso; los errores de scraping se registran y el run
// continúa (ver ingest.scrape_errors).
import pino from "pino";
import { getEnv } from "../config/env.js";

function buildLogger() {
  const level = (() => {
    try {
      return getEnv().LOG_LEVEL;
    } catch {
      // Antes de validar el entorno (p. ej. al reportar el propio error de
      // config) seguimos queriendo poder loguear.
      return "info";
    }
  })();

  // Defensa en profundidad: hoy los call sites no registran secretos, pero un
  // objeto de request/config añadido en el futuro tampoco debe exponerlos.
  const redact = {
    paths: [
      "authorization", "Authorization", "headers.authorization", "req.headers.authorization",
      "apiKey", "*.apiKey", "YOUTUBE_API_KEY", "DEEPSEEK_API_KEY", "CRV_OPERATOR_TOKEN",
    ],
    censor: "[REDACTED]",
  };

  const isTTY = process.stdout.isTTY === true;
  return isTTY
    ? pino({
        level,
        redact,
        transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } },
      })
    : pino({ level, redact });
}

export const logger = buildLogger();

/** Logger hijo con un módulo etiquetado, para trazar de dónde viene cada línea. */
export function moduleLogger(mod: string) {
  return logger.child({ mod });
}
