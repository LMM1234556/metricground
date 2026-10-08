import { parseTaskRun, persistTaskRun, readTaskRun } from "../../lib/task-run-persistence.server";
import { apiJson, guardApiRequest, readJsonBody } from "../../lib/api-guard.server";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function traceIdOf(request: Request) {
  return request.headers.get("X-Trace-Id")?.trim() ?? "";
}

export async function GET(request: Request) {
  const guarded = await guardApiRequest(request, { route: "task-runs:read", limit: 120 });
  if ("response" in guarded) return guarded.response;
  const { context } = guarded;
  const id = new URL(request.url).searchParams.get("id")?.trim() ?? "";
  const traceId = traceIdOf(request);
  if (!id || !traceId) return apiJson(context, { error: "缺少任务 id 或 traceId。" }, { status: 400 });
  const run = await readTaskRun(id, traceId, context.ownerHash);
  return run
    ? apiJson(context, { run })
    : apiJson(context, { error: "任务不存在，或访问凭证不匹配。" }, { status: 404 });
}

export async function PUT(request: Request) {
  const guarded = await guardApiRequest(request, { route: "task-runs:write", limit: 60, mutation: true });
  if ("response" in guarded) return guarded.response;
  const { context } = guarded;
  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim() ?? "";
  const traceId = traceIdOf(request);
  if (idempotencyKey.length < 8 || idempotencyKey.length > 240 || !traceId) {
    return apiJson(context, { error: "缺少有效的 Idempotency-Key 或 X-Trace-Id。" }, { status: 400 });
  }
  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if ("error" in body) return apiJson(context, { error: body.error }, { status: body.status });
  const run = parseTaskRun(body.value);
  if (!run || run.traceId !== traceId) return apiJson(context, { error: "TaskRun 结构无效或 traceId 不一致。" }, { status: 400 });
  const result = await persistTaskRun(run, idempotencyKey, context.ownerHash);
  if (result.kind === "conflict") {
    return apiJson(context, { error: "持久化版本冲突。", current: result.current }, { status: 409 });
  }
  return apiJson(context, { run: result.run, replayed: result.kind === "replayed" }, {
    status: result.kind === "replayed" ? 200 : run.persistenceRevision === 0 ? 201 : 200,
  });
}
