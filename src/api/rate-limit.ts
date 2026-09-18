// CRV · Límite de ráfaga por clave y ventana fija (auditoría 2026-09-17,
// hallazgo de seguridad #10: el login ya limitaba intentos, pero las
// escrituras autenticadas no — una cuenta comprometida o un bucle de cliente
// podía golpear la API sin freno, y cada escritura es un run + auditoría +
// posible análisis de Curaduría).
//
// En memoria y por proceso: esta API vive en una sola máquina y un solo
// proceso (igual que las sesiones de auth.ts). Un mapa acotado evita que un
// atacante haga crecer el estado con claves nuevas.
export interface WindowLimiter {
  /** Consume cupo de la clave; `false` si la ventana ya está llena. */
  take(key: string): boolean;
  /** Cupo restante en la ventana actual (diagnóstico y pruebas). */
  remaining(key: string): number;
}

export function createWindowLimiter(options: { max: number; windowMs: number; maxKeys?: number }): WindowLimiter {
  const entries = new Map<string, { count: number; resetAt: number }>();
  const maxKeys = Math.max(1, options.maxKeys ?? 500);
  // max <= 0 apaga el límite (configuración explícita del operador).
  const max = options.max > 0 ? options.max : Number.POSITIVE_INFINITY;

  return {
    take(key: string): boolean {
      const now = Date.now();
      const entry = entries.get(key);
      if (!entry || entry.resetAt <= now) {
        if (!entry && entries.size >= maxKeys) {
          const oldest = entries.keys().next().value;
          if (oldest !== undefined) entries.delete(oldest);
        }
        entries.set(key, { count: 1, resetAt: now + options.windowMs });
        return true;
      }
      if (entry.count >= max) return false;
      entry.count += 1;
      return true;
    },
    remaining(key: string): number {
      const entry = entries.get(key);
      if (!entry || entry.resetAt <= Date.now()) return max;
      return Math.max(0, max - entry.count);
    },
  };
}
