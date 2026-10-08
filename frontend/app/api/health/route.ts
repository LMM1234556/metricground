import { ensureTaskRunSchema, taskRunDb } from "../../lib/task-run-persistence.server";

export async function GET() {
  const checkedAt = new Date().toISOString();
  try {
    const db = taskRunDb();
    await ensureTaskRunSchema(db);
    await db.prepare("SELECT 1 AS ok").first();
    return Response.json({ status: "ok", version: "0.2.0", checkedAt, checks: { d1: "ok" } }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json({
      status: "degraded", version: "0.2.0", checkedAt,
      checks: { d1: "failed" },
      error: error instanceof Error ? error.message : "Unknown health check error",
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
