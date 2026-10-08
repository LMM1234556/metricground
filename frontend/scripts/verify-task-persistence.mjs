import assert from "node:assert/strict";

const baseUrl = process.env.METRICGROUND_BASE_URL ?? "http://127.0.0.1:5173";
const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
const now = new Date().toISOString();
const run = {
  id: `task_persistence_${suffix}`,
  traceId: `trace_persistence_${suffix}`,
  persistenceRevision: 0,
  question: "验证 TaskRun 持久化合同",
  state: "DATA_PROFILED",
  createdAt: now,
  updatedAt: now,
  datasetVersions: [],
  analysisSpec: null,
  plan: [],
  toolCalls: [],
  approvals: [],
  validationSummary: null,
  resultSummary: null,
  failure: null,
  events: [],
};

async function put(body, key) {
  const response = await fetch(`${baseUrl}/api/task-runs`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key, "X-Trace-Id": body.traceId },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const healthResponse = await fetch(`${baseUrl}/api/health`);
const health = await healthResponse.json();
assert.equal(healthResponse.status, 200);
assert.equal(health.status, "ok");
assert.equal(health.checks.d1, "ok");

const created = await put(run, `create_${suffix}`);
assert.equal(created.status, 201);
assert.equal(created.body.run.persistenceRevision, 1);

const replayed = await put(run, `create_${suffix}`);
assert.equal(replayed.status, 200);
assert.equal(replayed.body.replayed, true);
assert.equal(replayed.body.run.persistenceRevision, 1);

const updatedRun = {
  ...created.body.run,
  state: "PLANNING",
  updatedAt: new Date(Date.now() + 1000).toISOString(),
};
const updated = await put(updatedRun, `update_${suffix}`);
assert.equal(updated.status, 200);
assert.equal(updated.body.run.persistenceRevision, 2);

const stale = await put(updatedRun, `stale_${suffix}`);
assert.equal(stale.status, 409);
assert.equal(stale.body.current.persistenceRevision, 2);

const denied = await fetch(`${baseUrl}/api/task-runs?id=${encodeURIComponent(run.id)}`, {
  headers: { "X-Trace-Id": `wrong_${suffix}` },
});
assert.equal(denied.status, 404);

const read = await fetch(`${baseUrl}/api/task-runs?id=${encodeURIComponent(run.id)}`, {
  headers: { "X-Trace-Id": run.traceId },
});
const readBody = await read.json();
assert.equal(read.status, 200);
assert.equal(readBody.run.state, "PLANNING");
assert.equal(readBody.run.persistenceRevision, 2);

console.log(JSON.stringify({
  checksPassed: true,
  health: health.status,
  createRevision: created.body.run.persistenceRevision,
  replayRevision: replayed.body.run.persistenceRevision,
  updateRevision: updated.body.run.persistenceRevision,
  staleWriteStatus: stale.status,
  wrongTraceStatus: denied.status,
}, null, 2));
