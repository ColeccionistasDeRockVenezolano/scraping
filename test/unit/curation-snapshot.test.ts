// CRV · La foto del catálogo que analiza Curaduría es una sola transacción
// (PLAN_CURADURIA E1, A3). Con consultas repartidas por el pool, cada una ve
// un instante distinto: durante una ingesta, pistas y discos pueden no
// corresponderse y aparecer hallazgos fantasma.
import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { loadCatalogSnapshot } from "../../src/curation/snapshot.js";

function recordingClient(failOn?: RegExp, distinctTable = false) {
  const statements: string[] = [];
  const client = {
    query: async (sql: string) => {
      const statement = sql.replace(/\s+/gu, " ").trim();
      statements.push(statement);
      if (failOn?.test(statement)) throw new Error("la base se cayó a mitad de la foto");
      if (statement.includes("to_regclass")) return { rows: [{ present: distinctTable }] };
      if (statement.includes("FROM ingest.curation_distinct_pairs")) return { rows: [{ kind: "artist", a_id: "7", b_id: "3" }] };
      return { rows: [] };
    },
    release: () => undefined,
  };
  return { statements, client: client as unknown as PoolClient };
}

describe("foto del catálogo de Curaduría (A3)", () => {
  it("todas las consultas van en una transacción REPEATABLE READ de solo lectura sobre el mismo cliente", async () => {
    const { statements, client } = recordingClient();
    const snapshot = await loadCatalogSnapshot(client);
    expect(statements[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(statements.at(-1)).toBe("COMMIT");
    // 13 lecturas del catálogo y la pregunta de si ya existe la tabla de pares distintos (0020).
    expect(statements.slice(1, -1)).toHaveLength(14);
    expect(statements.slice(1, -1).every((statement) => statement.startsWith("SELECT"))).toBe(true);
    expect(snapshot.artists).toEqual([]);
    expect(snapshot.distinctPairs).toEqual(new Set());
  });

  it("carga los pares declarados distintos (E2) dentro de la misma foto, como pares ya tratados", async () => {
    const { statements, client } = recordingClient(undefined, true);
    const snapshot = await loadCatalogSnapshot(client);
    expect(statements.slice(1, -1)).toHaveLength(15);
    expect(statements.at(-1)).toBe("COMMIT");
    expect(snapshot.distinctPairs).toEqual(new Set(["artist:3-7"]));
    expect(snapshot.handledPairs.has("artist:3-7")).toBe(true);
  });

  it("si una consulta falla, deshace la transacción y propaga el error", async () => {
    const { statements, client } = recordingClient(/FROM ingest\.conflicts/u);
    await expect(loadCatalogSnapshot(client)).rejects.toThrow("la base se cayó a mitad de la foto");
    expect(statements[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
  });
});
