import { parseTaskRun, persistTaskRun, readTaskRun } from "../../lib/task-run-persistence.server";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function traceIdOf(request: Request) {
  return request.headers.get("X-Trace-Id")?.trim() ?? "";
}

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id")?.trim() ?? "";
  const traceId = traceIdOf(request);
  if (!id || !traceId) return Response.json({ error: "缺少任务 id 或 traceId。" }, { status: 400 });
  const run = await readTaskRun(id, traceId);
  return run
    ? Response.json({ run }, { headers: { "Cache-Control": "no-store" } })
    : Response.json({ error: "任务不存在或 traceId 不匹配。" }, { status: 404 });
}

export async function PUT(request: Request) {
  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim() ?? "";
  const traceId = traceIdOf(request);
  if (idempotencyKey.length < 8 || idempotencyKey.length > 240 || !traceId) {
    return Response.json({ error: "缺少有效的 Idempotency-Key 或 X-Trace-Id。" }, { status: 400 });
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return Response.json({ error: "TaskRun 载荷超过 2 MiB 限制。" }, { status: 413 });
  }
  let body: unknown;
  try { body = JSON.parse(raw); } catch {
    return Response.json({ error: "请求内容不是有效 JSON。" }, { status: 400 });
  }
  const run = parseTaskRun(body);
  if (!run || run.traceId !== traceId) return Response.json({ error: "TaskRun 结构无效或 traceId 不一致。" }, { status: 400 });
  const result = await persistTaskRun(run, idempotencyKey);
  if (result.kind === "conflict") {
    return Response.json({ error: "持久化版本冲突。", current: result.current }, { status: 409 });
  }
  return Response.json({ run: result.run, replayed: result.kind === "replayed" }, {
    status: result.kind === "replayed" ? 200 : run.persistenceRevision === 0 ? 201 : 200,
    headers: { "Cache-Control": "no-store" },
  });
}
