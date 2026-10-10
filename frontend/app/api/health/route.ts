import { ensureTaskRunSchema, taskRunDb } from "../../lib/task-run-persistence.server";
import packageJson from "../../../package.json";
import { readModelBudgetStatus } from "../../lib/model-budget.server";

const APP_VERSION = packageJson.version;

export async function GET(request: Request) {
  const checkedAt = new Date().toISOString();
  const requestId = request.headers.get("X-Request-Id")?.trim() || crypto.randomUUID();
  const d1StartedAt = Date.now();
  try {
    const db = taskRunDb();
    await ensureTaskRunSchema(db);
    await db.prepare("SELECT 1 AS ok").first();
    await db.prepare("DELETE FROM api_rate_limits WHERE expires_at < ?").bind(Date.now() - 86_400_000).run();
    const d1LatencyMs = Date.now() - d1StartedAt;
    const modelStartedAt = Date.now();
    const cloudConfigured = Boolean(process.env.DASHSCOPE_API_KEY && process.env.DASHSCOPE_MODEL === "qwen-plus");
    const cloudEnabled = process.env.AGENT_CLOUD_FALLBACK === "true";
    const cloudBudget = cloudConfigured ? { enabled: cloudEnabled, ...(await readModelBudgetStatus(db)) } : null;
    let model: { status: "ok" | "unavailable" | "configured" | "disabled"; required: false; latencyMs: number };
    if (cloudConfigured && cloudEnabled) {
      // Configuration health is not a paid inference or a claim that model answers are correct.
      model = { status: "configured", required: false, latencyMs: Date.now() - modelStartedAt };
    } else if (process.env.AGENT_PROVIDER_MODE === "cloud-only") {
      model = { status: "disabled", required: false, latencyMs: Date.now() - modelStartedAt };
    } else try {
      const base = (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/v1\/?$/, "").replace(/\/$/, "");
      const response = await fetch(process.env.OLLAMA_HEALTH_URL ?? `${base}/api/tags`, { signal: AbortSignal.timeout(1_500) });
      model = { status: response.ok ? "ok" : "unavailable", required: false, latencyMs: Date.now() - modelStartedAt };
    } catch {
      model = { status: "unavailable", required: false, latencyMs: Date.now() - modelStartedAt };
    }
    const body = {
      status: "ok", version: APP_VERSION, checkedAt,
      checks: { web: { status: "ok" }, d1: { status: "ok", latencyMs: d1LatencyMs }, model }, cloudBudget,
    };
    console.log(JSON.stringify({ level: "info", event: "health_check", requestId, status: "ok", d1LatencyMs, modelStatus: model.status }));
    return Response.json(body, {
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Request-Id": requestId },
    });
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : "Unknown health check error";
    const body = {
      status: "degraded", version: APP_VERSION, checkedAt,
      checks: { web: { status: "ok" }, d1: { status: "failed", latencyMs: Date.now() - d1StartedAt } },
      error: "数据库健康检查失败。",
    };
    console.error(JSON.stringify({ level: "error", event: "health_check", requestId, status: "degraded", error: diagnostic }));
    return Response.json(body, {
      status: 503,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Request-Id": requestId },
    });
  }
}
