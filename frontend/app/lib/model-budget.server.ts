import { taskRunDb } from "./task-run-persistence.server";
import { MODEL_BUDGET_SCHEMA, MODEL_RESERVE_SQL, MODEL_TRIAL_LIMITS, ModelCostPolicyError, type ModelCallReceipt } from "./model-cost-policy.ts";
import type { AgentModelProvider } from "./model-provider.ts";

let ready: Promise<void> | null = null;
async function ensureSchema(db: D1Database) {
    ready ??= db.batch(MODEL_BUDGET_SCHEMA.map((sql) => db.prepare(sql))).then(() => undefined).catch(() => {
      ready = null;
      throw new ModelCostPolicyError("MODEL_BUDGET_UNAVAILABLE");
    });
    await ready;
}
export async function readModelBudgetStatus(db = taskRunDb()) {
  await ensureSchema(db);
  const budget = await db.prepare("SELECT request_count FROM cloud_model_budget WHERE budget_key = 'cloud-trial-v1'").first<{ request_count: number }>();
  const usage = await db.prepare(`SELECT COUNT(*) AS receipts,
    COALESCE(SUM(input_tokens),0) AS known_input_tokens, COALESCE(SUM(output_tokens),0) AS known_output_tokens,
    COALESCE(SUM(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL THEN 1 ELSE 0 END),0) AS unknown_usage_calls
    FROM cloud_model_calls`).first<{ receipts: number; known_input_tokens: number; known_output_tokens: number; unknown_usage_calls: number }>();
  const reservedRequests = Number(budget?.request_count ?? 0);
  return {
    totalRequestLimit: MODEL_TRIAL_LIMITS.totalRequests, reservedRequests,
    remainingRequests: Math.max(0, MODEL_TRIAL_LIMITS.totalRequests - reservedRequests),
    recordedCalls: Number(usage?.receipts ?? 0), knownInputTokens: Number(usage?.known_input_tokens ?? 0),
    knownOutputTokens: Number(usage?.known_output_tokens ?? 0), unknownUsageCalls: Number(usage?.unknown_usage_calls ?? 0),
  };
}
export function createModelBudgetStore(requestId: string, provider: AgentModelProvider) {
  const db = taskRunDb();
  return {
    reserve: async () => {
      try {
        await ensureSchema(db);
        const now = new Date().toISOString();
        const result = await db.prepare(MODEL_RESERVE_SQL).bind(now, MODEL_TRIAL_LIMITS.totalRequests)
          .first<{ request_count: number }>();
        if (!result) throw new ModelCostPolicyError("MODEL_GLOBAL_LIMIT");
        const id = crypto.randomUUID();
        await db.prepare(`INSERT INTO cloud_model_calls
          (id, request_id, provider, model, status, created_at) VALUES (?, ?, ?, ?, 'reserved', ?)`)
          .bind(id, requestId, provider.id, provider.model, now).run();
        return id;
      } catch (error) {
        if (error instanceof ModelCostPolicyError) throw error;
        throw new ModelCostPolicyError("MODEL_BUDGET_UNAVAILABLE");
      }
    },
    record: async (receipt: ModelCallReceipt) => {
      try {
        await db.prepare(`UPDATE cloud_model_calls SET status = ?, input_tokens = ?, output_tokens = ?, duration_ms = ? WHERE id = ?`)
          .bind(receipt.status, receipt.inputTokens, receipt.outputTokens, receipt.durationMs, receipt.id).run();
      } catch { throw new ModelCostPolicyError("MODEL_RECEIPT_UNAVAILABLE"); }
    },
  };
}
