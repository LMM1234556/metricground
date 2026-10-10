import assert from "node:assert/strict";

const baseUrl = process.env.METRICGROUND_BASE_URL ?? "http://127.0.0.1:5173";
const suffix = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
const requireAnonymousMode = process.argv.includes("--require-anonymous");
console.log(JSON.stringify({ event: "anonymous_probe_started", origin: new URL(baseUrl).origin, requireAnonymousMode }));

async function requestJson(path, init = {}) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const startedAt = Date.now();
    let response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: new Headers(init.headers),
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      throw new Error(`Anonymous probe ${init.method ?? "GET"} ${path.split("?")[0]} failed after ${Date.now() - startedAt}ms`, { cause: error });
    }
    const raw = await response.text();
    if (response.status === 503 && /worker restarted mid-request/i.test(raw) && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 200));
      continue;
    }
    let body;
    try { body = JSON.parse(raw); } catch { body = { raw: raw.slice(0, 240) }; }
    console.log(JSON.stringify({ event: "anonymous_probe_response", method: init.method ?? "GET", path: path.split("?")[0], status: response.status }));
    return { status: response.status, body, headers: response.headers };
  }
  throw new Error("Local preview did not settle after its restart");
}

function taskRun(label) {
  const now = new Date().toISOString();
  return {
    id: `task_anonymous_${label}_${suffix}`,
    traceId: `trace_anonymous_${label}_${suffix}`,
    persistenceRevision: 0,
    question: `匿名会话隔离测试 ${label}`,
    state: "IDLE",
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
}

async function create(run, cookie, key) {
  return requestJson("/api/task-runs", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": key,
      "X-Trace-Id": run.traceId,
      Cookie: `metricground_anon_session=${cookie}`,
    },
    body: JSON.stringify(run),
  });
}

async function read(run, cookie) {
  return requestJson(`/api/task-runs?id=${encodeURIComponent(run.id)}`, {
    headers: {
      "X-Trace-Id": run.traceId,
      Cookie: `metricground_anon_session=${cookie}`,
    },
  });
}

async function initializeSession() {
  const session = await requestJson("/api/session");
  assert.equal(session.status, 200);
  assert.equal(session.body.authenticated, false);
  if (requireAnonymousMode) {
    assert.equal(session.body.required, false, "测试环境必须允许未登录访问");
    assert.equal(session.body.anonymous, true, "必须启用安全匿名会话");
  }
  const cookie = session.headers.get("Set-Cookie") ?? "";
  const token = cookie.match(/^metricground_anon_session=([^;]+)/)?.[1];
  if (session.body.anonymous) {
    assert.ok(token, "新的未登录客户端必须收到匿名会话 Cookie");
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    if (new URL(baseUrl).protocol === "https:") assert.match(cookie, /Secure/);
    const reused = await requestJson("/api/session", { headers: { Cookie: `metricground_anon_session=${token}` } });
    assert.equal(reused.body.anonymous, true);
    assert.equal(reused.headers.get("Set-Cookie"), null, "刷新会话不能意外换掉记录所有者");
  }
  return { token: token ?? crypto.randomUUID(), anonymous: session.body.anonymous === true };
}

const initializedA = await initializeSession();
const initializedB = await initializeSession();
const sessionA = initializedA.token;
const sessionB = initializedB.token;
assert.notEqual(sessionA, sessionB, "两个客户端不能分配到同一匿名身份");
if (initializedA.anonymous) {
  const missingSession = await requestJson("/api/agent/plan", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(missingSession.status, 401, "缺少 Cookie 的核心 API 必须拒绝执行");
  assert.equal(missingSession.body.code, "ANONYMOUS_SESSION_REQUIRED");
}
const runA = taskRun("a");
const runB = taskRun("b");

const createdA = await create(runA, sessionA, `anonymous_a_${suffix}`);
assert.equal(createdA.status, 201, JSON.stringify(createdA.body));
assert.equal((await read(runA, sessionA)).status, 200, "匿名会话 A 必须能读取自己的 TaskRun");
assert.equal((await read(runA, sessionB)).status, 404, "匿名会话 B 不得读取会话 A 的 TaskRun");
const createdB = await create(runB, sessionB, `anonymous_b_${suffix}`);
assert.equal(createdB.status, 201, JSON.stringify(createdB.body));
assert.equal((await read(runB, sessionB)).status, 200, "匿名会话 B 必须能读取自己的 TaskRun");
assert.equal((await read(runB, sessionA)).status, 404, "匿名会话 A 不得读取会话 B 的 TaskRun");
const crossWrite = await create(runA, sessionB, `anonymous_cross_${suffix}`);
assert.equal(crossWrite.status, 409, "匿名会话 B 不得覆盖会话 A 的 TaskRun");
assert.equal(crossWrite.body.current, null, "写入冲突不得返回其他会话的记录");

console.log(JSON.stringify({
  passed: true,
  sessionASelfRead: 200,
  sessionBCannotReadA: 404,
  sessionBSelfRead: 200,
  sessionACannotReadB: 404,
  sessionBCannotOverwriteA: 409,
  serverIssuedAnonymousSessions: initializedA.anonymous && initializedB.anonymous,
}, null, 2));
