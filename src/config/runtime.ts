// CRV · guardia de runtime — Node mínimo soportado (PHASES F0).
//
// `engines` en package.json es declarativo: npm solo lo aplica en `install`
// (con engine-strict), nunca en `npm run`. Este módulo lo convierte en un
// fallo ruidoso y accionable en vez de una ejecución silenciosa con la
// versión equivocada, que es como se coló Node 20 en las corridas no
// interactivas de esta máquina.
export const MIN_NODE_MAJOR = 22;

export function nodeMajor(version: string = process.version): number {
  const match = /^v?(\d+)\./.exec(version);
  return match ? Number(match[1]) : Number.NaN;
}

export function isSupportedNode(version: string = process.version): boolean {
  const major = nodeMajor(version);
  return Number.isFinite(major) && major >= MIN_NODE_MAJOR;
}

/** Lanza si el runtime actual no cumple `engines.node`. */
export function assertSupportedNode(version: string = process.version): void {
  if (isSupportedNode(version)) return;
  throw new Error(
    `CRV requiere Node >= ${MIN_NODE_MAJOR} (package.json engines.node) y está corriendo ${version}. ` +
      "Usa `nvm use` (.nvmrc) o invoca los scripts npm, que pasan por scripts/with-node22.sh.",
  );
}
