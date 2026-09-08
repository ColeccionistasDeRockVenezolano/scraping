import { describe, expect, it } from "vitest";
import { z } from "zod";
import { aiResolutionProposalSchema, aiSemanticNormalizationSchema } from "../../src/ai/contracts.js";
import { DeepSeekGateway, DeepSeekValidationError, MemoryDeepSeekRunStore, MockDeepSeekTransport, type DeepSeekGatewayConfig } from "../../src/ai/gateway.js";
import { resolveEntity } from "../../src/er/resolver.js";
import { DEFAULT_RESOLUTION_THRESHOLDS, type ResolutionCandidate } from "../../src/er/types.js";

const config: DeepSeekGatewayConfig = {
  baseUrl: "https://mock.deepseek.invalid",
  models: { fast: "configured-fast", reasoning: "configured-pro", vision: "configured-vision" },
  maxTokens: 1_000,
  timeoutMs: 5_000,
};

const validResolution = {
  same_entity_probability: 0.63,
  recommended_action: "REVIEW" as const,
  evidence_for: ["mismo nombre"],
  evidence_against: ["faltan creditos compartidos"],
  uncertainties: ["homonimo posible"],
};

describe("DeepSeek gateway aislado", () => {
  it("usa Pro solo cuando el resultado determinista es ambiguo y nunca lo convierte en merge", async () => {
    const transport = new MockDeepSeekTransport(validResolution);
    const gateway = new DeepSeekGateway(config, transport, new MemoryDeepSeekRunStore());
    const candidates: ResolutionCandidate[] = [
      { kind: "PERSON", id: 1, name: "Juan Pérez", canonicalName: "Juan Pérez" },
      { kind: "PERSON", id: 2, name: "Juan Pérez", canonicalName: "Juan Pérez" },
    ];
    const decision = await resolveEntity({ kind: "PERSON", name: "Juan Pérez" }, candidates, { gateway, thresholds: DEFAULT_RESOLUTION_THRESHOLDS });
    expect(decision.action).toBe("REVIEW");
    expect(decision.aiProposal).toEqual(validResolution);
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]).toMatchObject({ model: "configured-pro", modelClass: "reasoning" });
    expect(transport.requests[0]?.system).toContain("No ejecutes ni propongas SQL");
  });

  it("no llama IA cuando las reglas deterministas bastan", async () => {
    const transport = new MockDeepSeekTransport(validResolution);
    const gateway = new DeepSeekGateway(config, transport, new MemoryDeepSeekRunStore());
    const decision = await resolveEntity({ kind: "ARTIST", name: "Zapato 3" }, [{ kind: "ARTIST", id: 3, name: "Zapato 3", canonicalName: "Zapato 3" }], { gateway, thresholds: DEFAULT_RESOLUTION_THRESHOLDS });
    expect(decision.action).toBe("AUTO_MATCH");
    expect(transport.requests).toHaveLength(0);
  });

  it("valida con Zod strict y rechaza JSON con forma inesperada", async () => {
    const transport = new MockDeepSeekTransport({ ...validResolution, sql: "UPDATE artists" });
    const store = new MemoryDeepSeekRunStore();
    const gateway = new DeepSeekGateway(config, transport, store);
    await expect(gateway.propose({
      taskKind: "hard_entity_resolution", schemaVersion: "test.v1", input: {},
      instructions: "JSON", responseSchema: aiResolutionProposalSchema,
    })).rejects.toBeInstanceOf(DeepSeekValidationError);
    expect([...store.runs.values()][0]?.status).toBe("rejected");
  });

  it("cachea por prompt hash y una misma propuesta cuesta una sola llamada", async () => {
    const transport = new MockDeepSeekTransport(validResolution);
    const store = new MemoryDeepSeekRunStore();
    const gateway = new DeepSeekGateway(config, transport, store);
    const request = { taskKind: "hard_entity_resolution" as const, schemaVersion: "cache.v1", input: { a: 1 }, instructions: "JSON", responseSchema: aiResolutionProposalSchema };
    const first = await gateway.propose(request); const second = await gateway.propose(request);
    expect(first.cached).toBe(false); expect(second.cached).toBe(true);
    expect(first.promptHash).toBe(second.promptHash);
    expect(transport.requests).toHaveLength(1);
  });

  it("enruta clasificacion/normalizacion semantica a Flash por rol configurable", async () => {
    const transport = new MockDeepSeekTransport({ normalized_value: "post punk", rationale: "variante editorial", uncertainties: [] });
    const gateway = new DeepSeekGateway(config, transport, new MemoryDeepSeekRunStore());
    await gateway.propose({ taskKind: "semantic_normalization", schemaVersion: "semantic.v1", input: "post-punk", instructions: "JSON", responseSchema: aiSemanticNormalizationSchema });
    expect(transport.requests[0]).toMatchObject({ model: "configured-fast", modelClass: "fast" });
  });

  it("tambien rechaza contenido que ni siquiera sea JSON", async () => {
    const gateway = new DeepSeekGateway(config, new MockDeepSeekTransport("no-json"), new MemoryDeepSeekRunStore());
    await expect(gateway.propose({ taskKind: "cheap_classification", schemaVersion: "bad.v1", input: {}, instructions: "JSON", responseSchema: z.object({ ok: z.boolean() }).strict() })).rejects.toBeInstanceOf(DeepSeekValidationError);
  });

  it("un arbitraje invalido degrada a review determinista sin merge", async () => {
    const transport = new MockDeepSeekTransport({ ...validResolution, forbidden_extra: true });
    const gateway = new DeepSeekGateway(config, transport, new MemoryDeepSeekRunStore());
    const decision = await resolveEntity({ kind: "PERSON", name: "Juan Pérez" }, [
      { kind: "PERSON", id: 1, name: "Juan Pérez", canonicalName: "Juan Pérez" },
      { kind: "PERSON", id: 2, name: "Juan Pérez", canonicalName: "Juan Pérez" },
    ], { gateway, thresholds: DEFAULT_RESOLUTION_THRESHOLDS });
    expect(decision.action).toBe("REVIEW");
    expect(decision.aiProposal).toBeUndefined();
    expect(decision.aiFailure).toContain("rechazada");
  });
});
