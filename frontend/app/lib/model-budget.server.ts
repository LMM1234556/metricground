import { taskRunDb } from "./task-run-persistence.server";
import { MODEL_BUDGET_SCHEMA, MODEL_RESERVE_SQL, MODEL_TRIAL_LIMITS, ModelCostPolicyError, type ModelCallReceipt } from "./model-cost-policy.ts";
import type { AgentModelProvider } from "./model-provider.ts";

let ready: Promise<void> | null = null;
export function createModelBudgetStore(requestId: string, provider: AgentModelProvider) {
  const db = taskRunDb();
  async function ensureSchema() {
    ready ??= db.batch(MODEL_BUDGET_SCHEMA.map((sql) => db.prepare(sql))).then(() => undefined).catch(() => {
      ready = null;
      throw new ModelCostPolicyError("MODEL_BUDGET_UNAVAILABLE");
    });
    await ready;
  }
  return {
    reserve: async () => {
      try {
        await ensureSchema();
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
