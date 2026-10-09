import assert from "node:assert/strict";
import WebSocket from "ws";

const siteUrl = new URL(process.env.METRICGROUND_SITE_URL ?? "https://metricground.chirpyseed1.chatgpt.site");
const ownerPort = Number(process.env.METRICGROUND_OWNER_CDP_PORT ?? 9224);
const secondPort = Number(process.env.METRICGROUND_SECOND_CDP_PORT ?? 9225);

async function connectBrowser(port, label) {
  let targets;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    targets = await response.json();
  } catch (error) {
    throw new Error(`${label} 浏览器未开放调试端口 ${port}：${error instanceof Error ? error.message : String(error)}`);
  }
  const target = targets.find((item) => {
    try {
      return item.type === "page" && new URL(item.url).origin === siteUrl.origin;
    } catch {
      return false;
    }
  });
  if (!target?.webSocketDebuggerUrl) {
    throw new Error(`${label} 浏览器中未找到已打开的 ${siteUrl.origin} 页面。`);
  }

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let requestId = 0;
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  function command(method, params = {}) {
    const id = ++requestId;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }
  async function evaluate(expression) {
    const response = await command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(`${label} 页面执行失败：${response.exceptionDetails.exception?.description ?? response.exceptionDetails.text}`);
    }
    return response.result.value;
  }

  await command("Runtime.enable");
  return { label, socket, evaluate };
}

async function requestJson(browser, path, init = {}) {
  return browser.evaluate(`(async () => {
    const response = await fetch(${JSON.stringify(path)}, {
      ...${JSON.stringify(init)},
      credentials: "include",
      cache: "no-store"
    });
    const raw = await response.text();
    let body;
    try { body = JSON.parse(raw); } catch { body = { raw: raw.slice(0, 240) }; }
    return { status: response.status, body };
  })()`);
}

function taskRun(label, suffix) {
  const now = new Date().toISOString();
  return {
    id: `task_hosted_isolation_${label}_${suffix}`,
    traceId: `trace_hosted_isolation_${label}_${suffix}`,
    persistenceRevision: 0,
    question: `线上第二身份隔离探针 ${label}`,
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

async function createRun(browser, run, suffix) {
  return requestJson(browser, "/api/task-runs", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `hosted_isolation_${suffix}`,
      "X-Trace-Id": run.traceId,
    },
    body: JSON.stringify(run),
  });
}

async function readRun(browser, run) {
  return requestJson(browser, `/api/task-runs?id=${encodeURIComponent(run.id)}`, {
    headers: { "X-Trace-Id": run.traceId },
  });
}

let owner;
let second;
try {
  owner = await connectBrowser(ownerPort, "所有者");
  second = await connectBrowser(secondPort, "第二身份");
  const [ownerSession, secondSession] = await Promise.all([
    requestJson(owner, "/api/session"),
    requestJson(second, "/api/session"),
  ]);
  assert.equal(ownerSession.status, 200, "所有者会话接口必须可访问");
  assert.equal(secondSession.status, 200, "第二身份会话接口必须可访问");
  assert.equal(ownerSession.body.authenticated, true, "所有者浏览器尚未登录");
  assert.equal(secondSession.body.authenticated, true, "第二身份浏览器尚未登录或尚未接受邀请");
  assert.equal(ownerSession.body.required, true, "线上环境没有强制认证");
  assert.equal(secondSession.body.required, true, "第二身份访问的环境没有强制认证");

  const suffix = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const ownerRun = taskRun("owner", suffix);
  const secondRun = taskRun("second", suffix);
  const ownerCreate = await createRun(owner, ownerRun, `owner_${suffix}`);
  assert.equal(ownerCreate.status, 201, `所有者 TaskRun 创建失败：${JSON.stringify(ownerCreate.body)}`);
  assert.equal((await readRun(owner, ownerRun)).status, 200, "所有者不能读取自己的 TaskRun");
  assert.equal((await readRun(second, ownerRun)).status, 404, "第二身份读到了所有者 TaskRun，隔离失败或两个浏览器登录了同一账号");

  const secondCreate = await createRun(second, secondRun, `second_${suffix}`);
  assert.equal(secondCreate.status, 201, `第二身份 TaskRun 创建失败：${JSON.stringify(secondCreate.body)}`);
  assert.equal((await readRun(second, secondRun)).status, 200, "第二身份不能读取自己的 TaskRun");
  assert.equal((await readRun(owner, secondRun)).status, 404, "所有者读到了第二身份 TaskRun，隔离失败或两个浏览器登录了同一账号");

  console.log(JSON.stringify({
    passed: true,
    siteOrigin: siteUrl.origin,
    authenticationRequired: true,
    ownerSelfRead: 200,
    secondCannotReadOwner: 404,
    secondSelfRead: 200,
    ownerCannotReadSecond: 404,
    ownerTaskRunId: ownerRun.id,
    secondTaskRunId: secondRun.id,
    checkedAt: new Date().toISOString(),
  }, null, 2));
} finally {
  owner?.socket.close();
  second?.socket.close();
}
