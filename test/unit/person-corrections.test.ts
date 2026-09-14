import { describe, expect, it } from "vitest";
import { creditEquivalenceKey, creditTypeForRole } from "../../src/merge/relations.js";
import { loadPersonCorrectionPlan, personCorrectionPlanSchema } from "../../src/review/person-corrections.js";

describe("equivalencia de créditos", () => {
  it("en foto y arte el texto del rol no distingue", () => {
    expect(creditEquivalenceKey("photography", "Photos")).toBe(creditEquivalenceKey("photography", "photography"));
    expect(creditEquivalenceKey("artwork", "Graphic Design & Illustrations")).toBe(creditEquivalenceKey("artwork", "artwork & illustration"));
  });

  it("en los demás tipos solo se ignoran preposición, tildes y signos", () => {
    expect(creditEquivalenceKey("producer", "Produced by")).toBe(creditEquivalenceKey("producer", "produced"));
    expect(creditEquivalenceKey("producer", "Executive Production")).not.toBe(creditEquivalenceKey("producer", "Produced by"));
    expect(creditEquivalenceKey("musician", "Guitar")).not.toBe(creditEquivalenceKey("musician", "Bass"));
    expect(creditEquivalenceKey("musician", "Guitar & Backing Vocals")).toBe(creditEquivalenceKey("musician", "guitar, backing vocals"));
  });

  it("los verbos nuevos del canal se clasifican en su tipo", () => {
    expect(["artwork", "illustration", "graphic design"].map(creditTypeForRole)).toEqual(["artwork", "artwork", "artwork"]);
    expect(["photography", "photos"].map(creditTypeForRole)).toEqual(["photography", "photography"]);
  });
});

describe("plan de correcciones de personas", () => {
  it("el plan versionado del caso Caramelos es válido", async () => {
    const plan = await loadPersonCorrectionPlan("docs/decisions/2026-09-14-personas-caramelos.json");
    expect(plan.corrections.map((item) => item.op)).toEqual(["rename", "rename", "merge", "drop_aliases", "merge", "to_artist"]);
  });

  it("rechaza una operación sin motivo o sin el nombre esperado", () => {
    expect(() => personCorrectionPlanSchema.parse({ decidedAt: "2026-09-14", evidence: "x", corrections: [{ op: "rename", person: { id: 1, name: "A" }, to: "B", keepOldNameAsAlias: true }] })).toThrow();
    expect(() => personCorrectionPlanSchema.parse({ decidedAt: "2026-09-14", evidence: "x", corrections: [{ op: "merge", keep: { id: 1 }, drop: { id: 2, name: "B" }, keepDropNameAsAlias: true, why: "y" }] })).toThrow();
  });
});
