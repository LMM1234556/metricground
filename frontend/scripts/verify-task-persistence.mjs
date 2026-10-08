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

async function put(body, key, extraHeaders = {}) {
  return requestJson(`${baseUrl}/api/task-runs`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key, "X-Trace-Id": body.traceId, ...extraHeaders },
    body: JSON.stringify(body),
  });
}

async function requestJson(url, init = {}, maximumAttempts = 3) {
  let latest;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    let response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      latest = { raw: error instanceof Error ? error.message : String(error) };
      if (attempt < maximumAttempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 100));
        continue;
      }
      throw error;
    }
    const raw = await response.text();
    latest = { status: response.status, headers: response.headers, raw };
    if (response.status === 503 && /worker restarted mid-request/i.test(raw) && attempt < maximumAttempts) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 100));
      continue;
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new Error(`Expected JSON from ${url}, received HTTP ${response.status}: ${raw.slice(0, 240)}`);
    }
    return { ...latest, body };
  }
  throw new Error(`Transient request failed after ${maximumAttempts} attempts: ${latest?.raw ?? "unknown error"}`);
}

const healthResponse = await requestJson(`${baseUrl}/api/health`);
const health = healthResponse.body;
assert.equal(healthResponse.status, 200);
assert.equal(health.status, "ok");
assert.equal(health.version, "0.3.0");
assert.equal(health.checks.d1.status, "ok");
assert.ok(["ok", "unavailable"].includes(health.checks.model.status));

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

const denied = await requestJson(`${baseUrl}/api/task-runs?id=${encodeURIComponent(run.id)}`, {
  headers: { "X-Trace-Id": `wrong_${suffix}` },
});
assert.equal(denied.status, 404);

const read = await requestJson(`${baseUrl}/api/task-runs?id=${encodeURIComponent(run.id)}`, {
  headers: { "X-Trace-Id": run.traceId },
});
const readBody = read.body;
assert.equal(read.status, 200);
assert.equal(readBody.run.state, "PLANNING");
assert.equal(readBody.run.persistenceRevision, 2);

const crossOrigin = await put({ ...run, id: `task_cross_origin_${suffix}`, persistenceRevision: 0 }, `cross_${suffix}`, {
  Origin: "https://attacker.invalid",
});
assert.equal(crossOrigin.status, 403);
const crossSite = await put({ ...run, id: `task_cross_site_${suffix}`, persistenceRevision: 0 }, `cross_site_${suffix}`, {
  "Sec-Fetch-Site": "cross-site",
});
assert.equal(crossSite.status, 403);

const ownedRun = { ...run, id: `task_owned_${suffix}`, traceId: `trace_owned_${suffix}`, persistenceRevision: 0 };
const owned = await put(ownedRun, `owned_${suffix}`, { "oai-authenticated-user-id": "test-user-a" });
assert.equal(owned.status, 201);
const otherUserRead = await requestJson(`${baseUrl}/api/task-runs?id=${encodeURIComponent(ownedRun.id)}`, {
  headers: { "X-Trace-Id": ownedRun.traceId, "oai-authenticated-user-id": "test-user-b" },
});
assert.equal(otherUserRead.status, 404);

const oversizedPayload = { ...run, id: `task_oversized_${suffix}`, traceId: `trace_oversized_${suffix}`, question: "x".repeat(2_100_000) };
const oversized = await put(oversizedPayload, `oversized_${suffix}`);
assert.equal(oversized.status, 413);

const oversizedPlan = await requestJson(`${baseUrl}/api/agent/plan`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ question: "x", padding: "x".repeat(270_000) }),
});
assert.equal(oversizedPlan.status, 413);

const rateAddress = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
let rateLimitedResponse = null;
for (let index = 0; index < 61; index += 1) {
  rateLimitedResponse = await requestJson(`${baseUrl}/api/agent/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": rateAddress },
    body: "{}",
  });
}
assert.equal(rateLimitedResponse.status, 429);
assert.ok(rateLimitedResponse.headers.get("X-Request-Id"));
assert.equal(rateLimitedResponse.headers.get("X-RateLimit-Remaining"), "0");
assert.ok(rateLimitedResponse.headers.get("Retry-After"));

console.log(JSON.stringify({
  checksPassed: true,
  health: health.status,
  createRevision: created.body.run.persistenceRevision,
  replayRevision: replayed.body.run.persistenceRevision,
  updateRevision: updated.body.run.persistenceRevision,
  staleWriteStatus: stale.status,
  wrongTraceStatus: denied.status,
  crossOriginStatus: crossOrigin.status,
  crossSiteStatus: crossSite.status,
  ownerIsolationStatus: otherUserRead.status,
  oversizedTaskStatus: oversized.status,
  oversizedPlanStatus: oversizedPlan.status,
  rateLimitStatus: rateLimitedResponse.status,
}, null, 2));
