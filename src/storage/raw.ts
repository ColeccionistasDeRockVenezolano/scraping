// CRV · Almacenamiento crudo en disco (ARCHITECTURE.md §4.3).
// data/raw/<source-slug>/<sha256>.html (+ <sha256>.headers.json adyacente).
// El crudo nunca se modifica ni se re-procesa destructivamente: si un
// parser cambia, se re-ejecuta sobre el crudo ya guardado.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEnv } from "../config/env.js";

function extensionFor(contentType: string | null): string {
  if (!contentType) return "bin";
  if (contentType.includes("html")) return "html";
  if (contentType.includes("json")) return "json";
  if (contentType.includes("xml")) return "xml";
  return "bin";
}

export interface StoredRawPage {
  storedPath: string; // relativa a DATA_DIR, para guardar en ingest.raw_pages.stored_path
  absolutePath: string;
}

/** Escribe el crudo (si no existía ya ese hash para esa fuente) y sus cabeceras. */
export async function storeRawPage(
  sourceSlug: string,
  sha256: string,
  body: Buffer,
  headers: Record<string, string>,
  contentType: string | null,
): Promise<StoredRawPage> {
  const dataDir = getEnv().DATA_DIR;
  const dir = path.join(dataDir, "raw", sourceSlug);
  await mkdir(dir, { recursive: true });

  const ext = extensionFor(contentType);
  const relPath = path.join("raw", sourceSlug, `${sha256}.${ext}`);
  const absPath = path.join(dataDir, relPath);
  const headersPath = `${absPath}.headers.json`;

  // Idempotente por contenido: si ya existe, no se reescribe (mismo hash =
  // mismos bytes). Solo se registran las cabeceras de este fetch más reciente
  // si aún no había ninguna.
  try {
    await readFile(absPath);
  } catch {
    await writeFile(absPath, body);
    await writeFile(headersPath, JSON.stringify(headers, null, 2));
  }

  return { storedPath: relPath, absolutePath: absPath };
}
