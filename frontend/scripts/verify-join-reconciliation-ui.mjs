import WebSocket from "ws";
import path from "node:path";

const orders = path.resolve("../evaluation/fixtures/join_orders_sample.csv");
const items = path.resolve("../evaluation/fixtures/join_items_sample.csv");
const targets = await fetch("http://127.0.0.1:9224/json/list").then((response) => response.json());
const target = targets.find((item) => item.url === "http://localhost:5173/");
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
async function upload(selector, file) {
  const input = await command("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(selector)})`, returnByValue: false });
  if (!input.result.objectId) throw new Error(`File input not found: ${selector}`);
  await command("DOM.setFileInputFiles", { objectId: input.result.objectId, files: [file] });
}

await command("Runtime.enable");
await command("Page.reload", { ignoreCache: true });
await new Promise((resolve) => setTimeout(resolve, 1000));
await upload('.upload-button:not(.related-upload) input[type="file"]', orders);
await evaluate(`(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const deadline = Date.now() + 10000;
  while (!document.querySelector('.related-upload input[type="file"]')) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for related upload');
    await sleep(60);
  }
})()`);
await upload('.related-upload input[type="file"]', items);

const result = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const deadline = Date.now() + 12000;
  while (!document.querySelector('.join-workbench')) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for join workbench');
    await sleep(70);
  }
  const select = (label, value) => {
    const node = document.querySelector('select[aria-label="' + label + '"]');
    node.value = value;
    node.dispatchEvent(new Event('change', { bubbles: true }));
  };
  select('关联类型', 'inner');
  const rightTable = document.querySelector('select[aria-label="关联右表"]');
  select('输出粒度表', rightTable.value);
  const grain = document.querySelector('input[aria-label="关联后粒度说明"]');
  const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  inputSetter.call(grain, '一行代表一条订单商品明细');
  grain.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(40);
  [...document.querySelectorAll('.join-confirmations input[type="checkbox"]')].forEach((input) => { if (!input.checked) input.click(); });
  await sleep(80);
  document.querySelector('.execution-approval button')?.click();
  await sleep(120);
  const reconciliation = document.querySelector('.join-reconciliation article.at-risk')?.textContent.replace(/\\s+/g, ' ').trim() ?? '';
  const failedCheck = [...document.querySelectorAll('.join-result .execution-checks .failed')].some((item) => item.textContent.includes('join_orders_sample.amount'));
  document.querySelector('.join-result-heading button')?.click();
  await sleep(140);
  [...document.querySelectorAll('[role="tab"]')].find((item) => item.textContent.includes('经营分析'))?.click();
  await sleep(100);
  select('聚合口径', 'sum');
  select('数值字段', 'join_orders_sample.amount');
  await sleep(50);
  const blocker = document.querySelector('.business-analysis-workbench .execution-blocker')?.textContent.replace(/\\s+/g, ' ').trim() ?? '';
  const executeButton = document.querySelector('.business-analysis-workbench .execution-approval button');
  return { reconciliation, failedCheck, blocker, blocked: executeButton?.disabled === true };
})()`);

const checks = {
  mixedReconciliationDetected: result.reconciliation.includes('重复与排除同时存在') && result.reconciliation.includes('410') && result.reconciliation.includes('470') && result.reconciliation.includes('+60'),
  failedReconciliationCheckVisible: result.failedCheck,
  riskPropagatesToDerivedDataset: result.blocker.includes('join_orders_sample.amount') && result.blocker.includes('源表合计 410') && result.blocker.includes('关联后 470'),
  unsafeAggregationBlocked: result.blocked,
  noRuntimeExceptions: runtimeErrors.length === 0,
};
console.log(JSON.stringify({ checks, result, runtimeErrors }, null, 2));
socket.close();
if (Object.values(checks).some((passed) => !passed)) process.exitCode = 1;
