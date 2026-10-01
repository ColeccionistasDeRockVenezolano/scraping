import { describe, expect, it } from "vitest";
import { loadResolutionCandidates, persistResolutionDecision, withCandidateSnapshot } from "../../src/er/repository.js";
import { resolveEntityDeterministically } from "../../src/er/scoring.js";
import type { ResolutionInput } from "../../src/er/types.js";

// Un cliente falso que cuenta las lecturas: lo que importa es cuántas veces se
// recorre el catálogo, no lo que devuelve.
function fakeClient() {
  const calls: string[] = [];
  return {
    calls,
    client: {
      async query(sql: string) {
        calls.push(sql.includes("FROM public.persons") ? "PERSON" : "ARTIST");
        return { rows: [{ id: "1", name: "Eric Chacón", aliases: [], members: [], discography: [], bands: [], roles: [], album_credits: [] }] };
      },
    } as never,
  };
}

describe("instantánea de candidatos", () => {
  it("sin instantánea, cada claim vuelve a leer el catálogo", async () => {
    const { calls, client } = fakeClient();
    await loadResolutionCandidates({ kind: "PERSON", name: "a" }, client);
    await loadResolutionCandidates({ kind: "PERSON", name: "b" }, client);
    expect(calls).toEqual(["PERSON", "PERSON"]);
  });

  it("dentro de la instantánea se lee una vez por tipo, incluso en paralelo", async () => {
    const { calls, client } = fakeClient();
    await withCandidateSnapshot(async () => {
      await Promise.all([
        loadResolutionCandidates({ kind: "PERSON", name: "a" }, client),
        loadResolutionCandidates({ kind: "PERSON", name: "b" }, client),
      ]);
      await loadResolutionCandidates({ kind: "ARTIST", name: "c" }, client);
      await loadResolutionCandidates({ kind: "ARTIST", name: "d" }, client);
    });
    expect(calls).toEqual(["PERSON", "ARTIST"]);
  });

  it("la instantánea termina con su alcance: la siguiente tanda ve el catálogo nuevo", async () => {
    const { calls, client } = fakeClient();
    await withCandidateSnapshot(() => loadResolutionCandidates({ kind: "PERSON", name: "a" }, client));
    await withCandidateSnapshot(() => loadResolutionCandidates({ kind: "PERSON", name: "a" }, client));
    expect(calls).toEqual(["PERSON", "PERSON"]);
  });

  it("una lectura fallida no se queda guardada", async () => {
    let attempt = 0;
    const client = { async query() { attempt += 1; if (attempt === 1) throw new Error("caída"); return { rows: [] }; } } as never;
    await withCandidateSnapshot(async () => {
      await expect(loadResolutionCandidates({ kind: "PERSON", name: "a" }, client)).rejects.toThrow("caída");
      await expect(loadResolutionCandidates({ kind: "PERSON", name: "a" }, client)).resolves.toEqual([]);
    });
    expect(attempt).toBe(2);
  });

  it("el filtro de pistas da la misma decisión que puntuar todo el catálogo", async () => {
    const rows = [
      { id: "1", name: "Despertar", disc_number: 1, track_number: 1, album_id: 10, album_name: "Fusión IV", artist_name: "Fusión IV", aliases: [] },
      { id: "2", name: "A Un Paisano", disc_number: 1, track_number: 2, album_id: 10, album_name: "Fusión IV", artist_name: "Fusión IV", aliases: [] },
      { id: "3", name: "Intro", disc_number: 1, track_number: 1, album_id: 11, album_name: "Otro Disco", artist_name: "Otros", aliases: [] },
      { id: "4", name: "Intro", disc_number: 1, track_number: 1, album_id: 12, album_name: "Más Discos", artist_name: "Más", aliases: [] },
      { id: "5", name: "La Canción", disc_number: 1, track_number: 3, album_id: 11, album_name: "Otro Disco", artist_name: "Otros", aliases: [{ value: "Nuestra Canción", type: "other", confidence: "high" }] },
      { id: "6", name: "Nostalgias", disc_number: 2, track_number: 1, album_id: 13, album_name: "Mestizo", artist_name: "Eric Chacón", aliases: [] },
    ];
    const client = { async query() { return { rows }; } } as never;
    const inputs: ResolutionInput[] = [
      { kind: "TRACK", name: "Despertar", album: { name: "Fusión IV", artistName: "Fusión IV" }, disc: 1, trackNumber: 1 },
      { kind: "TRACK", name: "despertar", album: { name: "Fusion IV", artistName: "Fusión IV" }, disc: 1, trackNumber: 1 },
      { kind: "TRACK", name: "Intro", album: { name: "Disco Nuevo", artistName: "Nadie" }, disc: 1, trackNumber: 1 },
      { kind: "TRACK", name: "Nuestra Canción", album: { name: "Otro Disco", artistName: "Otros" }, disc: 1, trackNumber: 3 },
      { kind: "TRACK", name: "Pista Nueva", album: { name: "Mestizo", artistName: "Eric Chacón" }, disc: 2, trackNumber: 1 },
      { kind: "TRACK", name: "Nada Que Ver", album: { name: "Disco Desconocido", artistName: "X" }, disc: 1, trackNumber: 9 },
      { kind: "TRACK", name: "Despertar" },
    ];
    for (const input of inputs) {
      const everything = await loadResolutionCandidates(input, client);
      const blocked = await withCandidateSnapshot(() => loadResolutionCandidates(input, client));
      expect(blocked.length).toBeLessThanOrEqual(everything.length);
      const a = resolveEntityDeterministically(input, everything);
      const b = resolveEntityDeterministically(input, blocked);
      expect([b.action, b.candidateId], input.name).toEqual([a.action, a.candidateId]);
    }
    // Y de verdad acota: una pista de un disco desconocido solo ve las del mismo título.
    const narrowed = await withCandidateSnapshot(() => loadResolutionCandidates(inputs[5]!, client));
    expect(narrowed).toHaveLength(0);
  });

  it("dentro de la instantánea la decisión se guarda compactada, como la dejaría la retención", async () => {
    const candidates = Array.from({ length: 50 }, (_, index) => ({ id: index + 1, kind: "PERSON" as const, name: `Persona ${index}`, canonicalName: `Persona ${index}`, aliases: [] }));
    const input: ResolutionInput = { kind: "PERSON", name: "Persona 3" };
    const decision = resolveEntityDeterministically(input, candidates);
    expect(decision.candidates).toHaveLength(50);
    const saved: unknown[][] = [];
    const queryable = { async query(_sql: string, params: unknown[]) { saved.push(params); return { rows: [{ id: "7" }] }; } } as never;

    await persistResolutionDecision(decision, input, { queryable });
    expect(JSON.parse(saved[0]![16] as string)).toHaveLength(50);
    expect(saved[0]![20]).toBeNull();

    await withCandidateSnapshot(() => persistResolutionDecision(decision, input, { queryable }));
    const kept = JSON.parse(saved[1]![16] as string) as Array<Record<string, unknown>>;
    expect(kept).toHaveLength(20);
    expect(Object.keys(kept[0]!).sort()).toEqual(["action", "candidateId", "canonicalName", "score"]);
    expect(saved[1]![20]).toBe(50);
  });
});
