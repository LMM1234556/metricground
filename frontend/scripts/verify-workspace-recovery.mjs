import assert from "node:assert/strict";
import path from "node:path";
import WebSocket from "ws";

const fixture = path.resolve("../evaluation/fixtures/orders_quality_sample.csv");
const targets = await fetch("http://127.0.0.1:9224/json/list").then((response) => response.json());
const target = targets.find((item) => item.url === "http://localhost:5173/")
  ?? targets.find((item) => item.url === "http://127.0.0.1:5173/");
if (!target) throw new Error("MetricGround browser target not found");

const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
const runtimeErrors = [];
let requestId = 0;
socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
  }
  if (message.method === "Runtime.exceptionThrown") runtimeErrors.push(message.params.exceptionDetails.text);
});
await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });

function command(method, params = {}) {
  const id = ++requestId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(expression) {
  const response = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
  return response.result.value;
}

await command("Runtime.enable");
await command("DOM.enable");
await evaluate(`new Promise((resolve) => { const request = indexedDB.deleteDatabase('metricground-workspace'); request.onsuccess = request.onerror = request.onblocked = () => resolve(true); })`);
await command("Page.reload", { ignoreCache: true });
await new Promise((resolve) => setTimeout(resolve, 1200));
const input = await command("Runtime.evaluate", { expression: 'document.querySelector("input[type=file]")', returnByValue: false });
assert.ok(input.result.objectId, "Upload input not found");
await command("DOM.setFileInputFiles", { objectId: input.result.objectId, files: [fixture] });
await command("Runtime.callFunctionOn", {
  objectId: input.result.objectId,
  functionDeclaration: "function(){ this.dispatchEvent(new Event('change', { bubbles: true })); }",
});

const beforeReload = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const deadline = Date.now() + 15000;
  while (!document.body.innerText.includes('orders_quality_sample.csv') || !document.querySelector('.profile-card')) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for profile');
    await sleep(80);
  }
  const textarea = document.querySelector('.query-box textarea');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(textarea, '检查这份数据的质量问题，并解释对分析结果的影响');
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('.query-box').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  while (!document.querySelector('.task-run-trace') || !document.querySelector('.task-run-persistence.saved')) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for persisted TaskRun');
    await sleep(100);
  }
  await sleep(600);
  return {
    taskText: document.querySelector('.task-run-trace').innerText.replace(/\\s+/g, ' '),
    profileText: document.querySelector('.profile-card').innerText.replace(/\\s+/g, ' '),
  };
})()`);

await command("Page.reload", { ignoreCache: true });
await new Promise((resolve) => setTimeout(resolve, 900));
const afterReload = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const deadline = Date.now() + 12000;
  while (!document.body.innerText.includes('orders_quality_sample.csv') || !document.querySelector('.task-run-trace')) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for workspace recovery');
    await sleep(100);
  }
  return {
    taskText: document.querySelector('.task-run-trace').innerText.replace(/\\s+/g, ' '),
    bodyText: document.body.innerText.replace(/\\s+/g, ' '),
  };
})()`);

socket.close();
assert.match(beforeReload.taskText, /trace/);
assert.match(beforeReload.profileText, /11/);
assert.match(afterReload.taskText, /TaskRun/);
assert.match(afterReload.taskText, /已持久化|恢复工作区|版本/);
assert.match(afterReload.bodyText, /orders_quality_sample\.csv/);
assert.equal(runtimeErrors.length, 0, runtimeErrors.join("\n"));
console.log(JSON.stringify({ checksPassed: true, restoredFile: true, restoredTaskRun: true, runtimeErrors }, null, 2));
