import { describe, expect, it } from "vitest";
import { aiResolutionProposalSchema } from "../../src/ai/contracts.js";
import { DeepSeekGateway, FetchDeepSeekTransport, MemoryDeepSeekRunStore, type DeepSeekGatewayConfig } from "../../src/ai/gateway.js";

const apiKey = process.env["DEEPSEEK_API_KEY"];
const enabled = process.env["RUN_DEEPSEEK_INTEGRATION"] === "1" && Boolean(apiKey);

describe.runIf(enabled)("DeepSeek real (opt-in)", () => {
  it("acepta una respuesta estructurada del endpoint real", async () => {
    const config: DeepSeekGatewayConfig = {
      ...(apiKey === undefined ? {} : { apiKey }),
      baseUrl: process.env["DEEPSEEK_BASE_URL"] ?? "https://api.deepseek.com",
      models: {
        fast: process.env["DEEPSEEK_MODEL_FAST"] ?? "deepseek-v4-flash-0731",
        reasoning: process.env["DEEPSEEK_MODEL_REASONING"] ?? "deepseek-v4-pro-0813",
        vision: process.env["DEEPSEEK_MODEL_VISION"] ?? "deepseek-v4-flash-vision-exp",
      },
      maxTokens: 500, timeoutMs: 60_000,
    };
    const gateway = new DeepSeekGateway(config, new FetchDeepSeekTransport(), new MemoryDeepSeekRunStore());
    const result = await gateway.propose({
      taskKind: "hard_entity_resolution", schemaVersion: "real-smoke.v1",
      input: { a: { name: "Pacifica" }, b: { name: "Pacífica" }, context: "sin mas evidencia" },
      instructions: "La tilde sola no basta. Entrega las cinco claves requeridas y recomienda REVIEW.",
      responseSchema: aiResolutionProposalSchema,
    });
    expect(result.proposal.same_entity_probability).toBeGreaterThanOrEqual(0);
    expect(result.proposal.same_entity_probability).toBeLessThanOrEqual(1);
  }, 90_000);
});

