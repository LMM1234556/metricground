import WebSocket from "ws";
import path from "node:path";

const files = [
  path.resolve("../evaluation/fixtures/join_orders_sample.csv"),
  path.resolve("../evaluation/fixtures/join_customers_sample.csv"),
  path.resolve("../evaluation/fixtures/join_regions_sample.csv"),
];
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
async function waitFor(selector, timeout = 8000) {
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
  await command("Runtime.callFunctionOn", {
    objectId: input.result.objectId,
    functionDeclaration: "function(){ this.dispatchEvent(new Event('change', { bubbles: true })); }",
  });
}

await command("Runtime.enable");
await command("Page.reload", { ignoreCache: true });
await new Promise((resolve) => setTimeout(resolve, 1200));
await upload('input[type="file"]', files[0]);
await upload('.related-upload input[type="file"]', files[1]);
await upload('.related-upload input[type="file"]', files[2]);
await waitFor('.join-pipeline-status');

const result = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const setInput = (selector, value) => {
    const node = document.querySelector(selector);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const confirmAll = () => [...document.querySelectorAll('.join-confirmations input[type="checkbox"]')].forEach((input) => { if (!input.checked) input.click(); });
  const findButton = (text) => [...document.querySelectorAll('button')].find((button) => button.textContent.includes(text));

  setInput('input[aria-label="关联后粒度说明"]', '一行仍代表一笔订单');
  confirmAll();
  await sleep(60);
  findButton('批准并执行关联')?.click();
  await sleep(100);
  const stepOne = {
    result: document.querySelector('.join-result-heading')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
    progress: [...document.querySelectorAll('.join-pipeline-status > div')].map((item) => item.textContent.replace(/\\s+/g, ' ').trim()),
  };
  findButton('保存步骤 1，继续第三表')?.click();
  await sleep(120);
  const bridge = {
    left: document.querySelector('select[aria-label="关联左表"]')?.selectedOptions[0]?.textContent.trim() ?? '',
    right: document.querySelector('select[aria-label="关联右表"]')?.selectedOptions[0]?.textContent.trim() ?? '',
    leftKey: document.querySelector('select[aria-label="左关联键"]')?.value ?? '',
    rightKey: document.querySelector('select[aria-label="右关联键"]')?.value ?? '',
    saved: document.querySelector('.join-saved-step')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
  };
  setInput('input[aria-label="关联后粒度说明"]', '附加区域负责人后仍是一行一订单');
  confirmAll();
  await sleep(60);
  const executeThree = findButton('批准并执行三表关联');
  const enabled = executeThree && !executeThree.disabled;
  executeThree?.click();
  await sleep(140);
  const final = {
    heading: document.querySelector('.join-result-heading')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
    steps: [...document.querySelectorAll('.pipeline-step-results > div')].map((item) => item.textContent.replace(/\\s+/g, ' ').trim()),
    checks: [...document.querySelectorAll('.join-result .execution-checks > div')].map((item) => item.textContent.replace(/\\s+/g, ' ').trim()),
    rows: [...document.querySelectorAll('.join-preview-table tbody tr')].map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent.trim())),
    enabled,
  };
  document.querySelector('.join-result-heading button')?.click();
  await sleep(100);
  return {
    stepOne,
    bridge,
    final,
    afterUse: {
      tab: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim() ?? '',
      status: document.querySelector('.dataset-status')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
      stats: [...document.querySelectorAll('.profile-stats strong')].map((item) => item.textContent.trim()),
    },
  };
})()`);

const checks = {
  firstJoinSucceeded: result.stepOne.result.includes("4 + 3 源行 → 4 结果行"),
  bridgeRecommended: result.bridge.left.includes("customers") && result.bridge.right.includes("regions") && result.bridge.leftKey === "region" && result.bridge.rightKey === "region",
  stepOneLocked: result.bridge.saved.includes("步骤 1 已锁定"),
  secondApprovalRequiredAndAccepted: result.final.enabled,
  pipelineCompleted: result.final.heading.includes("三表关联完成并通过校验") && result.final.heading.includes("最终 4 行"),
  bothStepsAudited: result.final.steps.length === 2 && result.final.steps.every((step) => step.includes("4 → 4 行")),
  pipelineChecksPassed: result.final.checks.length === 9 && result.final.checks.every((check) => check.includes("通过")),
  thirdTableFieldsPresent: result.final.rows.some((row) => row.includes("王经理")) && result.final.rows.some((row) => row.includes("核心市场")),
  resultContinuesToAnalysis: result.afterUse.tab === "画像" && result.afterUse.status.includes("join_regions_sample") && result.afterUse.stats[0] === "4",
  noRuntimeExceptions: runtimeErrors.length === 0,
};
console.log(JSON.stringify({ checks, result, runtimeErrors }, null, 2));
socket.close();
if (Object.values(checks).some((passed) => !passed)) process.exitCode = 1;
