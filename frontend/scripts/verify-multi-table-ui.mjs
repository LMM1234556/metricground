import WebSocket from "ws";
import path from "node:path";

const orders = path.resolve("../evaluation/fixtures/join_orders_sample.csv");
const customers = path.resolve("../evaluation/fixtures/join_customers_sample.csv");
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

await command("Runtime.enable");
await command("Page.reload", { ignoreCache: true });
await new Promise((resolve) => setTimeout(resolve, 1200));
await evaluate(`(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const deadline = Date.now() + 8000;
  while (!document.querySelector('input[type="file"]')) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for primary upload control');
    await sleep(60);
  }
})()`);
let inputs = await command("Runtime.evaluate", { expression: 'document.querySelector(\'.upload-button:not(.related-upload) input[type="file"]\')', returnByValue: false });
if (!inputs.result.objectId) throw new Error("Primary file input not found");
await command("DOM.setFileInputFiles", { objectId: inputs.result.objectId, files: [orders] });
await evaluate(`(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const deadline = Date.now() + 8000;
  while (!document.querySelector('.related-upload input[type="file"]')) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for related-table upload control');
    await sleep(60);
  }
})()`);
inputs = await command("Runtime.evaluate", { expression: 'document.querySelector(\'.related-upload input[type="file"]\')', returnByValue: false });
if (!inputs.result.objectId) throw new Error("Related file input not found");
await command("DOM.setFileInputFiles", { objectId: inputs.result.objectId, files: [customers] });

const result = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const deadline = Date.now() + 12000;
  while (!document.querySelector('.join-workbench')) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for multi-table workbench');
    await sleep(80);
  }
  const guideBeforeJoin = {
    active: document.querySelector('.novice-steps .active strong')?.textContent.trim() ?? '',
    title: document.querySelector('.novice-guide-body h2')?.textContent.trim() ?? '',
    steps: [...document.querySelectorAll('.novice-steps strong')].map((item) => item.textContent.trim()),
  };
  const setInput = (selector, value) => {
    const node = document.querySelector(selector);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  };
  setInput('input[aria-label="关联后粒度说明"]', '一行仍代表一笔订单');
  await sleep(40);
  [...document.querySelectorAll('.join-confirmations input[type="checkbox"]')].forEach((input) => { if (!input.checked) input.click(); });
  await sleep(80);
  const button = [...document.querySelectorAll('.execution-approval button')].find((item) => item.textContent.includes('执行关联'));
  const enabled = button && !button.disabled;
  button?.click();
  await sleep(120);
  const beforeUse = {
    activeTab: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim() ?? '',
    relation: [...document.querySelectorAll('.join-stats strong')].map((item) => item.textContent.trim()),
    heading: document.querySelector('.join-result-heading')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
    checks: [...document.querySelectorAll('.join-result .execution-checks > div')].map((item) => item.textContent.replace(/\\s+/g, ' ').trim()),
    reconciliation: [...document.querySelectorAll('.join-reconciliation article')].map((item) => item.textContent.replace(/\\s+/g, ' ').trim()),
    rows: [...document.querySelectorAll('.join-preview-table tbody tr')].map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent.trim())),
    enabled,
  };
  document.querySelector('.join-result-heading button')?.click();
  await sleep(140);
  return {
    guideBeforeJoin,
    beforeUse,
    afterUse: {
      activeTab: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim() ?? '',
      status: document.querySelector('.dataset-status')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
      stats: [...document.querySelectorAll('.profile-stats strong')].map((item) => item.textContent.trim()),
      notice: document.querySelector('.agent-navigation-notice')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
      guideSteps: [...document.querySelectorAll('.novice-steps li')].map((item) => ({ text: item.textContent.trim(), state: item.className })),
    },
  };
})()`);

const checks = {
  multiTableTabReached: result.beforeUse.activeTab.includes("多表关联"),
  noviceGuideIncludesJoinStep: result.guideBeforeJoin.active === "确认关联"
    && result.guideBeforeJoin.title.includes("表关系和输出粒度")
    && result.guideBeforeJoin.steps.includes("确认关联"),
  nToOneDetected: result.beforeUse.relation[0] === "N:1",
  orphanRowsExposed: result.beforeUse.relation[2] === "1 / 1",
  executionRequiresAndAcceptsConfirmations: result.beforeUse.enabled,
  joinedRowsCorrect: result.beforeUse.heading.includes("4 + 3 源行 → 4 结果行") && result.beforeUse.rows.length === 4,
  joinedRegionVisible: result.beforeUse.rows.some((row) => row.includes("华东")),
  postJoinChecksPass: result.beforeUse.checks.length === 5 && result.beforeUse.checks.every((item) => item.includes("通过")),
  amountReconciliationVisible: result.beforeUse.reconciliation.some((item) => item.includes("join_orders_sample.amount") && item.includes("金额守恒") && item.includes("410")),
  joinedDatasetCanContinueAnalysis: result.afterUse.activeTab === "画像" && result.afterUse.status.includes("joined.csv") && result.afterUse.stats[0] === "4",
  grainReviewNoticeVisible: result.afterUse.notice.includes("核对字段画像与输出粒度"),
  joinedVersionKeepsCompletedJoinStep: result.afterUse.guideSteps.some((item) => item.text.includes("确认关联") && item.state.includes("done")),
  noRuntimeExceptions: runtimeErrors.length === 0,
};
console.log(JSON.stringify({ checks, result, runtimeErrors }, null, 2));
socket.close();
if (Object.values(checks).some((passed) => !passed)) process.exitCode = 1;
