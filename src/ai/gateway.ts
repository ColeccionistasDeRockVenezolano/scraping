/**
 * Unico punto de red hacia DeepSeek. El gateway no conoce tablas core ni
 * ofrece tools: la IA solo devuelve propuestas JSON que el codigo valida.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { getEnv } from "../config/env.js";
import { getPool } from "../db/client.js";

export type DeepSeekTaskKind =
  | "cheap_classification"
  | "narrative_extraction"
  | "semantic_normalization"
  | "hard_entity_resolution"
  | "conflict_arbitration"
  | "historical_interpretation"
  | "biography"
  | "vision_analysis";

export type DeepSeekModelClass = "fast" | "reasoning" | "vision";

const MODEL_CLASS: Record<DeepSeekTaskKind, DeepSeekModelClass> = {
  cheap_classification: "fast",
  narrative_extraction: "fast",
  semantic_normalization: "fast",
  biography: "fast",
  hard_entity_resolution: "reasoning",
  conflict_arbitration: "reasoning",
  historical_interpretation: "reasoning",
  vision_analysis: "vision",
};

export interface DeepSeekGatewayConfig {
  apiKey?: string;
  baseUrl: string;
  models: Record<DeepSeekModelClass, string>;
  maxTokens: number;
  timeoutMs: number;
}

export interface DeepSeekTransportRequest {
  apiKey?: string;
  baseUrl: string;
  model: string;
  modelClass: DeepSeekModelClass;
  maxTokens: number;
  timeoutMs: number;
  system: string;
  user: string;
}

export interface DeepSeekTransportResponse {
  content: string;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  payload?: unknown;
}

export interface DeepSeekTransport {
  complete(request: DeepSeekTransportRequest): Promise<DeepSeekTransportResponse>;
}

export interface StoredAiRun {
  id: number;
  model: string;
  output: unknown;
}

export interface SaveAiRun {
  promptHash: string;
  taskKind: DeepSeekTaskKind;
  model: string;
  schemaVersion: string;
  status: "validated" | "rejected" | "failed";
  inputSummary: unknown;
  outputSummary?: unknown;
  requestPayload: unknown;
  responsePayload?: unknown;
  rawResponse?: string;
  tokensIn?: number;
  tokensOut?: number;
  errorMessage?: string;
}

export interface DeepSeekRunStore {
  findValidated(promptHash: string): Promise<StoredAiRun | undefined>;
  save(run: SaveAiRun): Promise<number | undefined>;
}

export class DeepSeekValidationError extends Error {
  constructor(message: string, readonly causeValue?: unknown) {
    super(message); this.name = "DeepSeekValidationError";
  }
}

const apiResponseSchema = z.object({
  model: z.string().optional(),
  choices: z.array(z.object({
    finish_reason: z.string().nullable().optional(),
    message: z.object({ content: z.string().nullable() }).passthrough(),
  }).passthrough()).min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
  }).passthrough().optional(),
}).passthrough();

export class FetchDeepSeekTransport implements DeepSeekTransport {
  async complete(request: DeepSeekTransportRequest): Promise<DeepSeekTransportResponse> {
    if (!request.apiKey) throw new Error("DEEPSEEK_API_KEY no configurada; use un transport mock o revision determinista");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const response = await fetch(`${request.baseUrl.replace(/\/$/u, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${request.apiKey}` },
        body: JSON.stringify({
          model: request.model,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user },
          ],
          response_format: { type: "json_object" },
          max_tokens: request.maxTokens,
          thinking: { type: request.modelClass === "reasoning" ? "enabled" : "disabled" },
          stream: false,
        }),
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}: ${raw.slice(0, 500)}`);
      let decoded: unknown;
      try { decoded = JSON.parse(raw); } catch (error) { throw new DeepSeekValidationError("respuesta HTTP de DeepSeek no es JSON", error); }
      const envelope = apiResponseSchema.parse(decoded);
      const choice = envelope.choices[0];
      if (choice?.finish_reason && choice.finish_reason !== "stop") throw new DeepSeekValidationError(`respuesta DeepSeek incompleta: ${choice.finish_reason}`);
      const content = choice?.message.content;
      if (!content?.trim()) throw new DeepSeekValidationError("DeepSeek devolvio content vacio");
      return {
        content,
        model: envelope.model ?? request.model,
        ...(envelope.usage?.prompt_tokens === undefined ? {} : { tokensIn: envelope.usage.prompt_tokens }),
        ...(envelope.usage?.completion_tokens === undefined ? {} : { tokensOut: envelope.usage.completion_tokens }),
        payload: decoded,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export class MockDeepSeekTransport implements DeepSeekTransport {
  readonly requests: DeepSeekTransportRequest[] = [];
  private readonly responses: Array<unknown | DeepSeekTransportResponse>;
  constructor(...responses: Array<unknown | DeepSeekTransportResponse>) { this.responses = [...responses]; }
  async complete(request: DeepSeekTransportRequest): Promise<DeepSeekTransportResponse> {
    this.requests.push(request);
    if (!this.responses.length) throw new Error("MockDeepSeekTransport sin respuesta programada");
    const response = this.responses.shift();
    if (response && typeof response === "object" && "content" in response && "model" in response) return response as DeepSeekTransportResponse;
    return { content: typeof response === "string" ? response : JSON.stringify(response), model: request.model, tokensIn: 1, tokensOut: 1 };
  }
}

export class MemoryDeepSeekRunStore implements DeepSeekRunStore {
  private nextId = 1;
  readonly runs = new Map<string, SaveAiRun & { id: number }>();
  async findValidated(promptHash: string): Promise<StoredAiRun | undefined> {
    const run = this.runs.get(promptHash);
    return run?.status === "validated" && run.outputSummary !== undefined
      ? { id: run.id, model: run.model, output: run.outputSummary }
      : undefined;
  }
  async save(run: SaveAiRun): Promise<number> {
    const existing = this.runs.get(run.promptHash);
    const id = existing?.id ?? this.nextId++;
    this.runs.set(run.promptHash, { ...run, id });
    return id;
  }
}

export class PostgresDeepSeekRunStore implements DeepSeekRunStore {
  async findValidated(promptHash: string): Promise<StoredAiRun | undefined> {
    const result = await getPool().query<{ id: string; model: string; output_summary: unknown }>(
      "SELECT id,model,output_summary FROM ingest.ai_runs WHERE prompt_hash=$1 AND status='validated'",
      [promptHash],
    );
    const row = result.rows[0];
    return row ? { id: Number(row.id), model: row.model, output: row.output_summary } : undefined;
  }
  async save(run: SaveAiRun): Promise<number | undefined> {
    const result = await getPool().query<{ id: string }>(`
      INSERT INTO ingest.ai_runs(
        prompt_hash,task_kind,model,schema_version,status,input_summary,output_summary,
        request_payload,response_payload,raw_response,tokens_in,tokens_out,error_message
      ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12,$13)
      ON CONFLICT(prompt_hash) DO UPDATE SET
        status=EXCLUDED.status, output_summary=EXCLUDED.output_summary,
        response_payload=EXCLUDED.response_payload, raw_response=EXCLUDED.raw_response,
        tokens_in=EXCLUDED.tokens_in, tokens_out=EXCLUDED.tokens_out,
        error_message=EXCLUDED.error_message
      RETURNING id`, [
      run.promptHash, run.taskKind, run.model, run.schemaVersion, run.status,
      JSON.stringify(run.inputSummary), run.outputSummary === undefined ? null : JSON.stringify(run.outputSummary),
      JSON.stringify(run.requestPayload), run.responsePayload === undefined ? null : JSON.stringify(run.responsePayload),
      run.rawResponse ?? null, run.tokensIn ?? null, run.tokensOut ?? null, run.errorMessage ?? null,
    ]);
    const id = result.rows[0]?.id;
    return id ? Number(id) : undefined;
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

export interface DeepSeekProposalRequest<TSchema extends z.ZodTypeAny> {
  taskKind: DeepSeekTaskKind;
  schemaVersion: string;
  input: unknown;
  instructions: string;
  responseSchema: TSchema;
}

export interface DeepSeekProposalResult<T> {
  proposal: T;
  model: string;
  modelClass: DeepSeekModelClass;
  cached: boolean;
  promptHash: string;
  runId?: number;
}

export class DeepSeekGateway {
  constructor(
    private readonly config: DeepSeekGatewayConfig,
    private readonly transport: DeepSeekTransport = new FetchDeepSeekTransport(),
    private readonly store?: DeepSeekRunStore,
  ) {}

  async propose<TSchema extends z.ZodTypeAny>(request: DeepSeekProposalRequest<TSchema>): Promise<DeepSeekProposalResult<z.output<TSchema>>> {
    const modelClass = MODEL_CLASS[request.taskKind];
    const model = this.config.models[modelClass];
    const system = [
      "Actuas como arbitro de datos. Devuelve exclusivamente un objeto JSON.",
      "No ejecutes ni propongas SQL, escrituras, merges o comandos.",
      "Tu salida es una propuesta no vinculante; el codigo aplica la politica.",
      request.instructions,
    ].join("\n");
    const user = `INPUT JSON:\n${stableJson(request.input)}`;
    const requestPayload = { taskKind: request.taskKind, modelClass, model, schemaVersion: request.schemaVersion, system, user };
    const promptHash = createHash("sha256").update(stableJson(requestPayload)).digest("hex");
    const cached = await this.store?.findValidated(promptHash);
    if (cached) {
      const proposal = request.responseSchema.parse(cached.output);
      return { proposal, model: cached.model, modelClass, cached: true, promptHash, runId: cached.id };
    }
    let completion: DeepSeekTransportResponse;
    try {
      completion = await this.transport.complete({
        ...(this.config.apiKey === undefined ? {} : { apiKey: this.config.apiKey }),
        baseUrl: this.config.baseUrl, model, modelClass,
        maxTokens: this.config.maxTokens, timeoutMs: this.config.timeoutMs,
        system, user,
      });
    } catch (error) {
      await this.store?.save({
        promptHash, taskKind: request.taskKind, model, schemaVersion: request.schemaVersion,
        status: "failed", inputSummary: request.input, requestPayload,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(completion.content);
      const proposal = request.responseSchema.parse(decoded);
      const runId = await this.store?.save({
        promptHash, taskKind: request.taskKind, model: completion.model,
        schemaVersion: request.schemaVersion, status: "validated",
        inputSummary: request.input, outputSummary: proposal, requestPayload,
        ...(completion.payload === undefined ? {} : { responsePayload: completion.payload }),
        rawResponse: completion.content,
        ...(completion.tokensIn === undefined ? {} : { tokensIn: completion.tokensIn }),
        ...(completion.tokensOut === undefined ? {} : { tokensOut: completion.tokensOut }),
      });
      return { proposal, model: completion.model, modelClass, cached: false, promptHash, ...(runId === undefined ? {} : { runId }) };
    } catch (error) {
      await this.store?.save({
        promptHash, taskKind: request.taskKind, model: completion.model,
        schemaVersion: request.schemaVersion, status: "rejected", inputSummary: request.input,
        requestPayload, ...(decoded === undefined ? {} : { outputSummary: decoded }),
        ...(completion.payload === undefined ? {} : { responsePayload: completion.payload }),
        rawResponse: completion.content,
        ...(completion.tokensIn === undefined ? {} : { tokensIn: completion.tokensIn }),
        ...(completion.tokensOut === undefined ? {} : { tokensOut: completion.tokensOut }),
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw new DeepSeekValidationError("propuesta DeepSeek rechazada por el contrato Zod", error);
    }
  }
}

export function deepSeekConfigFromEnv(): DeepSeekGatewayConfig {
  const env = getEnv();
  return {
    ...(env.DEEPSEEK_API_KEY === undefined ? {} : { apiKey: env.DEEPSEEK_API_KEY }),
    baseUrl: env.DEEPSEEK_BASE_URL,
    models: { fast: env.DEEPSEEK_MODEL_FAST, reasoning: env.DEEPSEEK_MODEL_REASONING, vision: env.DEEPSEEK_MODEL_VISION },
    maxTokens: env.DEEPSEEK_MAX_TOKENS_PER_RUN,
    timeoutMs: env.DEEPSEEK_TIMEOUT_MS,
  };
}

export function createDeepSeekGateway(transport?: DeepSeekTransport, store: DeepSeekRunStore = new PostgresDeepSeekRunStore()): DeepSeekGateway {
  return new DeepSeekGateway(deepSeekConfigFromEnv(), transport ?? new FetchDeepSeekTransport(), store);
}
