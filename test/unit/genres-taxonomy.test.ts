// PLAN_GENEROS etapa 2: normalización, resolución de valores de fuente,
// reglas 1–7 del principal y prioridad humana, con la taxonomía aprobada real.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { desiredFromFile, DEFAULT_TAXONOMY_FILE } from "../../src/genres/admin.js";
import { normalizeGenreText, splitStrong, splitWeak } from "../../src/genres/normalize.js";
import { computeRuleAssignments, reconcileWithHuman, type GenreClaimEvidence } from "../../src/genres/rules.js";
import { buildTaxonomy, candidateAliasKeys, resolveGenreValue, type AliasTarget, type GenreNode, type Taxonomy } from "../../src/genres/taxonomy.js";

function realTaxonomy(): Taxonomy {
  const desired = desiredFromFile(JSON.parse(readFileSync(DEFAULT_TAXONOMY_FILE, "utf8")));
  const ids = new Map(desired.genres.map((genre, index) => [genre.slug, index + 1]));
  const nodes: GenreNode[] = desired.genres.map((genre) => ({
    id: ids.get(genre.slug)!, slug: genre.slug, name: genre.name, level: genre.level,
    parentId: genre.parentSlug ? ids.get(genre.parentSlug)! : null, active: true, replacedById: null,
  }));
  const aliases: Array<[string, AliasTarget]> = [...desired.aliases].map(([key, value]) => [
    key, value.target === "not_a_genre" ? { kind: "not_a_genre" } : { kind: "genre", genreId: ids.get(value.target)! },
  ]);
  return buildTaxonomy(nodes, aliases);
}

const taxonomy = realTaxonomy();
const id = (slug: string) => taxonomy.bySlug.get(slug)!.id;
const genresOf = (raw: string) => resolveGenreValue(taxonomy, raw).items.map((item) => (item.kind === "genre" ? taxonomy.genres.get(item.genreId)!.slug : `?${item.fragment}`));

let nextClaim = 1;
const claim = (sourceId: number, rawValue: string, sourceSlug = `fuente-${sourceId}`): GenreClaimEvidence => ({
  claimId: nextClaim++, sourceId, sourceSlug, sourceKind: "catalog_source", rawValue,
});

describe("normalización de géneros", () => {
  it("quita tildes con NFD, baja a minúsculas y trata el guion como espacio", () => {
    expect(normalizeGenreText("  Fusión   Latina ")).toBe("fusion latina");
    expect(normalizeGenreText("Hard-Rock")).toBe("hard rock");
    expect(normalizeGenreText("Rock’n’Roll")).toBe(normalizeGenreText("Rock'n'Roll"));
  });

  it("separa listas solo por separadores; el guion no es separador", () => {
    expect(splitStrong("Thrash / Death Metal")).toEqual(["Thrash", "Death Metal"]);
    expect(splitStrong("Heavy Metal, Hard Rock; Punk | Ska")).toEqual(["Heavy Metal", "Hard Rock", "Punk", "Ska"]);
    expect(splitStrong("Pop-Rock")).toEqual(["Pop-Rock"]);
    expect(splitWeak("Rock y Blues")).toEqual(["Rock", "Blues"]);
  });
});

describe("resolución con la taxonomía aprobada", () => {
  it("Hard Rock, hard-rock y Rock duro son el mismo género", () => {
    expect(genresOf("Hard Rock")).toEqual(["hard-rock"]);
    expect(genresOf("hard-rock")).toEqual(["hard-rock"]);
    expect(genresOf("Rock duro")).toEqual(["hard-rock"]);
  });

  it("Pop-Rock y Rock-Pop son un solo género, no dos", () => {
    expect(genresOf("Pop-Rock")).toEqual(["pop-rock"]);
    expect(genresOf("Rock-Pop")).toEqual(["pop-rock"]);
    expect(genresOf("Pop Rock")).toEqual(["pop-rock"]);
  });

  it("Melodic Death Metal conserva su propio género", () => {
    expect(genresOf("Melodic Death Metal")).toEqual(["death-metal-melodico"]);
    expect(id("death-metal-melodico")).not.toBe(id("death-metal"));
  });

  it("una familia sola resuelve a la familia", () => {
    expect(genresOf("Rock")).toEqual(["rock"]);
    expect(genresOf("METAL")).toEqual(["metal"]);
    expect(taxonomy.bySlug.get("rock")!.level).toBe("family");
  });

  it("las listas conservan el orden y el sufijo compartido completa los tramos", () => {
    expect(genresOf("Thrash / Death Metal")).toEqual(["thrash-metal", "death-metal"]);
    expect(genresOf("Hard Rock, Heavy Metal")).toEqual(["hard-rock", "heavy-metal"]);
  });

  it("los no-géneros no crean géneros", () => {
    const resolution = resolveGenreValue(taxonomy, "Independiente");
    expect(resolution.items).toEqual([]);
    expect(resolution.notAGenre).toEqual(["independiente"]);
    expect(genresOf("Heavy Metal / Independiente")).toEqual(["heavy-metal"]);
  });

  it("un compuesto con guion desconocido queda sin resolver y marcado", () => {
    const resolution = resolveGenreValue(taxonomy, "Zorro-Gaita");
    expect(resolution.items).toEqual([{ kind: "unresolved", fragment: "Zorro-Gaita" }]);
    expect(resolution.hyphenCompound).toBe(true);
  });

  it("las claves candidatas cubren el valor entero y cada tramo", () => {
    const keys = candidateAliasKeys("Thrash / Death Metal");
    expect(keys).toContain(normalizeGenreText("Thrash / Death Metal"));
    expect(keys).toContain("thrash");
    expect(keys).toContain("thrash metal");
    expect(keys).toContain("death metal");
  });

  it("el archivo aprobado rechaza alias ambiguos y familias inexistentes", () => {
    const raw = JSON.parse(readFileSync(DEFAULT_TAXONOMY_FILE, "utf8")) as { genres: Array<{ slug: string; family: string; aliases: string[] }> };
    const broken = structuredClone(raw);
    broken.genres.find((genre) => genre.slug === "pop-rock")!.aliases.push("rock duro");
    broken.genres.find((genre) => genre.slug === "heavy-metal")!.family = "no-existe";
    expect(() => desiredFromFile(broken)).toThrow(/rock duro[\s\S]*no-existe|no-existe[\s\S]*rock duro/);
    expect(path.basename(DEFAULT_TAXONOMY_FILE)).toBe("taxonomy.json");
  });
});

describe("reglas del principal (§4)", () => {
  it("regla 1: una fuente con un género → principal confirmado", () => {
    const outcome = computeRuleAssignments(taxonomy, [claim(1, "Hard Rock")]);
    expect(outcome.assignments).toEqual([expect.objectContaining({
      genreId: id("hard-rock"), role: "primary", status: "confirmed", decisionRule: "explicit_source_alias",
    })]);
    expect(outcome.cases).toEqual([]);
  });

  it("regla 2: en una lista, el primero es el principal y el resto secundario", () => {
    const outcome = computeRuleAssignments(taxonomy, [claim(1, "Thrash Metal / Hard Rock")]);
    const bySlug = new Map(outcome.assignments.map((row) => [taxonomy.genres.get(row.genreId)!.slug, row]));
    expect(bySlug.get("thrash-metal")).toMatchObject({ role: "primary", status: "confirmed", decisionRule: "source_list_order" });
    expect(bySlug.get("hard-rock")).toMatchObject({ role: "secondary", status: "confirmed" });
  });

  it("varias capturas del mismo valor en una fuente cuentan una vez", () => {
    const outcome = computeRuleAssignments(taxonomy, [claim(1, "Hard Rock"), claim(1, "hard-rock"), claim(1, "HARD ROCK")]);
    expect(outcome.assignments).toHaveLength(1);
    expect(outcome.assignments[0]!.claimIds).toHaveLength(3);
  });

  it("la familia de una fuente queda superseded por el hijo de otra", () => {
    const outcome = computeRuleAssignments(taxonomy, [claim(1, "Rock"), claim(2, "Hard Rock")]);
    const family = outcome.assignments.find((row) => row.genreId === id("rock"))!;
    const child = outcome.assignments.find((row) => row.genreId === id("hard-rock"))!;
    expect(family).toMatchObject({ status: "superseded", supersededByGenreId: id("hard-rock"), role: "secondary" });
    expect(child).toMatchObject({ status: "confirmed", role: "primary" });
  });

  it("fuentes sin ningún género en común → todo sugerido y a revisión", () => {
    const outcome = computeRuleAssignments(taxonomy, [claim(1, "Jazz"), claim(2, "Thrash Metal")]);
    expect(outcome.assignments.every((row) => row.status === "suggested" && row.role === "secondary" && row.confidence === "low")).toBe(true);
    expect(outcome.cases.map((item) => item.genreCase)).toEqual(["source_disagreement"]);
  });

  it("valor desconocido → caso unknown_value; en una lista, compound_value y principal pendiente", () => {
    expect(computeRuleAssignments(taxonomy, [claim(1, "Zorro Gaita")]).cases.map((item) => item.genreCase)).toEqual(["unknown_value"]);
    const outcome = computeRuleAssignments(taxonomy, [claim(1, "Zorro Gaita / Hard Rock")]);
    expect(outcome.cases.map((item) => item.genreCase)).toEqual(["compound_value"]);
    expect(outcome.assignments.some((row) => row.role === "primary")).toBe(false);
    expect(outcome.primaryPending).toBe(true);
  });

  it("es determinista: el orden de los claims no cambia el resultado", () => {
    const claims = [claim(1, "Rock"), claim(2, "Hard Rock / Blues"), claim(3, "Hard Rock")];
    const a = computeRuleAssignments(taxonomy, claims);
    const b = computeRuleAssignments(taxonomy, [...claims].reverse());
    expect(b).toEqual(a);
  });
});

describe("prioridad humana (§4)", () => {
  it("las reglas no tocan una fila humana y la contradicción se vuelve aviso", () => {
    const outcome = computeRuleAssignments(taxonomy, [claim(1, "Thrash Metal")]);
    const reconciled = reconcileWithHuman(taxonomy, outcome, [
      { id: 10, genreId: id("heavy-metal"), role: "primary", status: "confirmed", decidedBy: "brian" },
    ]);
    const thrash = reconciled.assignments.find((row) => row.genreId === id("thrash-metal"))!;
    expect(thrash.role).toBe("secondary");
    expect(reconciled.assignments.some((row) => row.genreId === id("heavy-metal"))).toBe(false);
    expect(reconciled.cases.map((item) => item.genreCase)).toContain("human_contradiction");
  });

  it("un género rechazado por una persona no vuelve; la evidencia nueva avisa", () => {
    const outcome = computeRuleAssignments(taxonomy, [claim(1, "Hard Rock")]);
    const reconciled = reconcileWithHuman(taxonomy, outcome, [
      { id: 11, genreId: id("hard-rock"), role: "secondary", status: "rejected", decidedBy: "brian" },
    ]);
    expect(reconciled.assignments).toEqual([]);
    expect(reconciled.cases.map((item) => item.genreCase)).toContain("human_contradiction");
  });

  it("la evidencia que coincide con una decisión humana se le suma sin aviso", () => {
    const outcome = computeRuleAssignments(taxonomy, [claim(1, "Hard Rock")]);
    const reconciled = reconcileWithHuman(taxonomy, outcome, [
      { id: 12, genreId: id("hard-rock"), role: "primary", status: "confirmed", decidedBy: "brian" },
    ]);
    expect(reconciled.assignments).toEqual([]);
    expect(reconciled.cases).toEqual([]);
    expect(reconciled.evidenceForHuman).toEqual([expect.objectContaining({ humanId: 12 })]);
  });
});
