import type { AgentModelProvider } from "./model-provider.ts";

// A lifetime trial ceiling: restarts, dates and visitor IP changes do not reset it.
export const MODEL_TRIAL_LIMITS = Object.freeze({
  totalRequests: 20, requestsPerQuestion: 2, maxOutputTokens: 512,
  maxInputBytes: 24_000, timeoutMs: 20_000,
});
export const MODEL_BUDGET_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS cloud_model_budget (
    budget_key TEXT PRIMARY KEY, request_count INTEGER NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_model_calls (
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
    status TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
    duration_ms INTEGER, created_at TEXT NOT NULL
  )`,
];
export const MODEL_RESERVE_SQL = `INSERT INTO cloud_model_budget (budget_key, request_count, updated_at)
  VALUES ('cloud-trial-v1', 1, ?)
  ON CONFLICT(budget_key) DO UPDATE SET request_count = request_count + 1, updated_at = excluded.updated_at
  WHERE request_count < ? RETURNING request_count`;

export class ModelCostPolicyError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; this.name = "ModelCostPolicyError"; }
}
export type ModelCallReceipt = {
  id: string; status: string; inputTokens: number | null; outputTokens: number | null; durationMs: number;
};
type Dependencies = {
  provider: AgentModelProvider;
  reserve: () => Promise<string>;
  record: (receipt: ModelCallReceipt) => Promise<void>;
  fetchImpl?: typeof fetch;
};

function tokenCount(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
async function usageFromResponse(response: Response) {
  // Provider errors and prompts must never be copied into logs or user responses.
  const reader = response.clone().body?.getReader();
  if (!reader) return { inputTokens: null, outputTokens: null };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 64 * 1024) return { inputTokens: null, outputTokens: null };
      chunks.push(next.value);
    }
    const all = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
    const value = JSON.parse(new TextDecoder().decode(all));
    return { inputTokens: tokenCount(value?.usage?.prompt_tokens), outputTokens: tokenCount(value?.usage?.completion_tokens) };
  } catch { return { inputTokens: null, outputTokens: null }; }
  finally { void reader.cancel().catch(() => undefined); }
}

export function createBudgetedModelFetch({ provider, reserve, record, fetchImpl = fetch }: Dependencies): typeof fetch {
  let requests = 0;
  return async (input, init) => {
    if (provider.id !== "dashscope" || provider.model !== "qwen-plus") {
      throw new ModelCostPolicyError("CLOUD_MODEL_NOT_APPROVED");
    }
    if (requests >= MODEL_TRIAL_LIMITS.requestsPerQuestion) throw new ModelCostPolicyError("MODEL_QUESTION_LIMIT");
    const base = new URL(provider.baseURL);
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash
      || base.port || !(base.hostname === "dashscope.aliyuncs.com" || /^[\w-]+\.cn-beijing\.maas\.aliyuncs\.com$/.test(base.hostname))
      || base.pathname.replace(/\/$/, "") !== "/compatible-mode/v1"
      || url.href !== `${provider.baseURL.replace(/\/$/, "")}/chat/completions`) {
      throw new ModelCostPolicyError("MODEL_ENDPOINT_NOT_APPROVED");
    }
    if (init?.method !== "POST" || typeof init.body !== "string") throw new ModelCostPolicyError("MODEL_BODY_INVALID");
    let body;
    try { body = JSON.parse(init.body); } catch { throw new ModelCostPolicyError("MODEL_BODY_INVALID"); }
    if (body.model !== "qwen-plus" || body.stream === true) throw new ModelCostPolicyError("MODEL_BODY_INVALID");
    // Enforce at the outgoing boundary even if SDK settings are later changed.
    const boundedBody = JSON.stringify({ ...body, max_tokens: MODEL_TRIAL_LIMITS.maxOutputTokens, enable_thinking: false, stream: false });
    if (new TextEncoder().encode(boundedBody).byteLength > MODEL_TRIAL_LIMITS.maxInputBytes) {
      throw new ModelCostPolicyError("MODEL_INPUT_LIMIT");
    }
    if (init.signal?.aborted) throw new ModelCostPolicyError("MODEL_CANCELLED");
    requests++; // Counts reservations/failed attempts too; never refund uncertain provider billing.
    const id = await reserve(); // D1 must succeed before any provider network request.
    const started = Date.now();
    const timeout = AbortSignal.timeout(MODEL_TRIAL_LIMITS.timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(input, {
        ...init, body: boundedBody, redirect: "manual",
        signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      });
    } catch {
      await record({ id, status: "failed", inputTokens: null, outputTokens: null, durationMs: Date.now() - started });
      throw new ModelCostPolicyError("MODEL_NETWORK_FAILED");
    }
    // Workers can reject redirect:error even where Node supports it. Manual mode
    // prevents forwarding Authorization; reject the response without following Location.
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => undefined);
      await record({ id, status: "redirect_blocked", inputTokens: null, outputTokens: null, durationMs: Date.now() - started });
      throw new ModelCostPolicyError("MODEL_REDIRECT_BLOCKED");
    }
    const usage = await usageFromResponse(response);
    // Storage failures are distinct from network failures, with the reservation retained.
    await record({ id, status: `http_${response.status}`, ...usage, durationMs: Date.now() - started });
    return response;
  };
}
