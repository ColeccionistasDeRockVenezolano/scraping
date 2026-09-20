import { DETECTOR_DEFINITIONS } from "../curation/analyze.js";
import type { DetectorDefinition } from "../curation/types.js";

export interface CurationFixPreviewOptions {
  detector: DetectorDefinition;
  signature?: string;
  actionKey?: string;
  limit: number;
}

export type CurationFixPreviewParse =
  | { ok: true; value: CurationFixPreviewOptions }
  | { ok: false; error: string };

const usage = "uso: crv curation fix --preview --detector=<clave> [--signature=<subgrupo>] [--action=<acción>] [--limit=N]";

export function parseCurationFixPreviewArgs(
  args: readonly string[],
  definitions: readonly DetectorDefinition[] = DETECTOR_DEFINITIONS,
): CurationFixPreviewParse {
  if (!args.includes("--preview")) {
    return { ok: false, error: "curation fix solo admite --preview: aplicar requiere revisar el lote y usar la API/web" };
  }
  const flag = (name: string): string | undefined =>
    args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const detectorKey = flag("detector");
  if (!detectorKey) return { ok: false, error: usage };
  const detector = definitions.find((item) => item.key === detectorKey);
  if (!detector) return { ok: false, error: `detector desconocido: ${detectorKey}` };

  const rawLimit = flag("limit");
  const limit = rawLimit === undefined ? 50 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50_000) {
    return { ok: false, error: "--limit debe ser un entero entre 1 y 50000" };
  }
  const signature = flag("signature");
  const actionKey = flag("action");
  return {
    ok: true,
    value: {
      detector,
      limit,
      ...(signature ? { signature } : {}),
      ...(actionKey ? { actionKey } : {}),
    },
  };
}
