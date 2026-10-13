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
async function waitFor(selector, timeout = 10000) {
  await evaluate(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const deadline = Date.now() + ${timeout};
    while (!document.querySelector(${JSON.stringify(selector)})) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for ${selector}');
      await sleep(60);
    }
  })()`);
}
async function upload(selector, file) {
  await waitFor(selector);
  const input = await command("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(selector)})`, returnByValue: false });
  if (!input.result.objectId) throw new Error(`File input not found: ${selector}`);
  await command("DOM.setFileInputFiles", { objectId: input.result.objectId, files: [file] });
  await command("Runtime.callFunctionOn", { objectId: input.result.objectId, functionDeclaration: "function(){ this.dispatchEvent(new Event('change', { bubbles: true })); }" });
}

await command("Runtime.enable");
await command("Page.reload", { ignoreCache: true });
await new Promise((resolve) => setTimeout(resolve, 1000));
await upload('.upload-button:not(.related-upload) input[type="file"]', orders);
await upload('.related-upload input[type="file"]', items);
await evaluate(`(() => {
  const textarea = document.querySelector('.query-box textarea');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(textarea, '商品品类补到订单信息');
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('.query-box').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
})()`);
await waitFor('.agent-plan-card.clarify');
await waitFor('.task-run-trace.state-needs_clarification');
await waitFor(".join-safe-enrichment");

const result = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const card = document.querySelector('.join-safe-enrichment');
  const before = {
    recommendation: card?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
    selectedFields: [...card.querySelectorAll('label')].filter((label) => label.querySelector('input')?.checked).map((label) => label.textContent.trim()),
    grain: document.querySelector('input[aria-label="关联后粒度说明"]')?.value ?? '',
    stats: [...document.querySelectorAll('.join-stats strong')].map((item) => item.textContent.trim()),
  };
  [...document.querySelectorAll('.join-confirmations input[type="checkbox"]')].forEach((input) => { if (!input.checked) input.click(); });
  await sleep(80);
  const button = [...document.querySelectorAll('.execution-approval button')].find((item) => item.textContent.includes('安全补充'));
  const enabled = Boolean(button && !button.disabled);
  button?.click();
  await sleep(150);
  const rows = [...document.querySelectorAll('.join-preview-table tbody tr')].map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent.trim()));
  const after = {
    heading: document.querySelector('.join-result-heading')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
    receipt: document.querySelector('.join-preaggregation-receipt')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
    rows,
    checks: [...document.querySelectorAll('.join-result .execution-checks > div')].map((item) => item.textContent.replace(/\\s+/g, ' ').trim()),
    reconciliation: [...document.querySelectorAll('.join-reconciliation article')].map((item) => item.textContent.replace(/\\s+/g, ' ').trim()),
    enabled,
  };
  document.querySelector('.join-result-heading button')?.click();
  await sleep(120);
  return { before, after, used: {
    tab: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim() ?? '',
    status: document.querySelector('.dataset-status')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
    stats: [...document.querySelectorAll('.profile-stats strong')].map((item) => item.textContent.trim()),
    taskState: document.querySelector('.task-run-trace .task-state')?.textContent.trim() ?? '',
    taskStats: [...document.querySelectorAll('.task-run-stats strong')].map((item) => item.textContent.trim()),
    taskTools: [...document.querySelectorAll('.task-tool-trace [data-tool]')].map((item) => item.getAttribute('data-tool')),
    taskSummary: document.querySelector('.task-run-complete-guide')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
  }};
})()`);

const checks = {
  recommendationExplainsPreaggregation: result.before.recommendation.includes("先汇总右表") && result.before.recommendation.includes("不自动汇总右表数值字段"),
  categoryRecommended: result.before.selectedFields.some((field) => field.includes("category") || field.includes("品类")),
  grainPrefilled: result.before.grain.includes("去重列表"),
  previewPreservesOrderRows: result.before.stats[3] === "4" && result.before.stats[4] === "1.00x",
  executionEnabledAfterConfirmation: result.after.enabled,
  resultPreservesOrderRows: result.after.heading.includes("4 行左表 + 5 行右表明细 → 4 行左表粒度结果"),
  receiptIsInspectable: result.after.receipt.includes("5 行 → 4 个非空关联键") && result.after.receipt.includes("匹配 3 个键"),
  categoryListAggregated: result.after.rows.some((row) => row.includes("O-1001") && row.includes("A、B")),
  unmatchedOrderRetained: result.after.rows.some((row) => row.includes("O-1004")),
  allChecksPass: result.after.checks.length >= 6 && result.after.checks.every((item) => item.includes("通过")),
  orderAmountPreserved: result.after.reconciliation.some((item) => item.includes("join_orders_sample.amount") && item.includes("金额守恒") && item.includes("410")),
  derivedDatasetCanContinue: result.used.tab === "画像" && result.used.status.includes("joined.csv") && result.used.stats[0] === "4",
  joinTaskCompletedWithEvidence: result.used.taskState === "已完成" && result.used.taskStats[0] === "3"
    && result.used.taskTools.includes("execute_grain_preserving_join") && result.used.taskTools.includes("validate_join_result")
    && result.used.taskSummary.includes("category"),
  noRuntimeExceptions: runtimeErrors.length === 0,
};
console.log(JSON.stringify({ checks, result, runtimeErrors }, null, 2));
socket.close();
if (Object.values(checks).some((passed) => !passed)) process.exitCode = 1;
