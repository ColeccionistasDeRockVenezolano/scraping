import { describe, expect, it } from "vitest";
import { parseCurationFixPreviewArgs } from "../../src/cli/curation-fix.js";

const defs = [{
  key: "mayusculas_sostenidas",
  category: "nombres_sucios",
  label: "Mayúsculas sostenidas",
  description: "prueba",
}] as const;

describe("CLI curation fix --preview", () => {
  it("rechaza cualquier intento de usar fix sin la llave --preview", () => {
    expect(parseCurationFixPreviewArgs(["--detector=mayusculas_sostenidas"], defs)).toMatchObject({
      ok: false,
      error: expect.stringContaining("solo admite --preview"),
    });
  });

  it("exige un detector conocido y un límite seguro", () => {
    expect(parseCurationFixPreviewArgs(["--preview"], defs)).toMatchObject({ ok: false, error: expect.stringContaining("uso:") });
    expect(parseCurationFixPreviewArgs(["--preview", "--detector=otro"], defs)).toEqual({
      ok: false, error: "detector desconocido: otro",
    });
    for (const limit of ["0", "50001", "1.5", "NaN"]) {
      expect(parseCurationFixPreviewArgs(["--preview", "--detector=mayusculas_sostenidas", `--limit=${limit}`], defs))
        .toEqual({ ok: false, error: "--limit debe ser un entero entre 1 y 50000" });
    }
  });

  it("conserva detector, subgrupo, acción y límite de una vista previa válida", () => {
    expect(parseCurationFixPreviewArgs([
      "--preview", "--detector=mayusculas_sostenidas", "--signature=mayusculas_sostenidas",
      "--action=capitalizar", "--limit=12",
    ], defs)).toEqual({
      ok: true,
      value: {
        detector: defs[0],
        signature: "mayusculas_sostenidas",
        actionKey: "capitalizar",
        limit: 12,
      },
    });
  });
});
