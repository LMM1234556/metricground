import WebSocket from "ws";
import path from "node:path";
import { writeFile } from "node:fs/promises";

const fixture = path.resolve("../evaluation/fixtures/orders_quality_sample.csv");
const targets = await fetch("http://127.0.0.1:9224/json/list").then((response) => response.json());
const target = targets.find((item) => item.url === "http://localhost:5173/");
if (!target) throw new Error("MetricGround browser target not found");

const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let requestId = 0;
const runtimeErrors = [];

socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  }
  if (message.method === "Runtime.exceptionThrown") runtimeErrors.push(message.params.exceptionDetails.text);
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
  const response = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
  return response.result.value;
}

await command("Runtime.enable");
await command("Page.reload", { ignoreCache: true });
await new Promise((resolve) => setTimeout(resolve, 1800));
const input = await command("Runtime.evaluate", {
  expression: 'document.querySelector(\'input[type="file"]\')',
  returnByValue: false,
});
if (!input.result?.objectId) throw new Error("Upload input not found");
await command("DOM.setFileInputFiles", { objectId: input.result.objectId, files: [fixture] });
await command("Runtime.callFunctionOn", {
  objectId: input.result.objectId,
  functionDeclaration: "function(){ this.dispatchEvent(new Event('change', { bubbles: true })); }",
});

const result = await evaluate(`(async () => {
  const deadline = Date.now() + 15000;
  while (!document.querySelector('.profile-card')) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for profile');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const clickByText = (selector, text) => {
    const node = [...document.querySelectorAll(selector)].find((item) => item.textContent.includes(text));
    if (!node) throw new Error('Cannot find: ' + text);
    node.click();
    return node;
  };
  const setText = (name, value) => {
    const node = document.querySelector('[name="' + name + '"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  };

  clickByText('.profile-tabs button', '质量检查');
  await new Promise((resolve) => setTimeout(resolve, 80));
  const qualityImpactText = document.querySelector('.quality-impact-summary')?.textContent.replace(/\\s+/g, ' ').trim() ?? '';
  const qualityImpactCounts = [...document.querySelectorAll('.quality-impact-counts strong')].map((item) => item.textContent.trim());
  clickByText('.quality-impact-summary button', '记录 6 项');
  await new Promise((resolve) => setTimeout(resolve, 60));
  const qualityProgressAfterRecommendation = document.querySelector('.quality-step-guide')?.textContent.replace(/\\s+/g, ' ').trim() ?? '';

  clickByText('.profile-tabs button', '指标口径');
  await new Promise((resolve) => setTimeout(resolve, 100));
  clickByText('.contract-submit-row button', '生成并确认');
  await new Promise((resolve) => setTimeout(resolve, 50));
  const blockedMessage = document.querySelector('.contract-errors')?.textContent ?? '';

  setText('metricName', '有效订单量');
  setText('decisionQuestion', '判断各地区订单规模');
  [...document.querySelectorAll('.contract-confirmations input')].forEach((checkbox) => {
    if (!checkbox.checked) checkbox.click();
  });
  clickByText('.contract-submit-row button', '生成并确认');
  await new Promise((resolve) => setTimeout(resolve, 100));
  const countContract = document.querySelector('.metric-contract-output')?.textContent ?? '';

  clickByText('.metric-type-grid button', '比例指标');
  await new Promise((resolve) => setTimeout(resolve, 50));
  clickByText('.contract-submit-row button', '生成并确认');
  await new Promise((resolve) => setTimeout(resolve, 50));
  const ratioBlockedMessage = document.querySelector('.contract-errors')?.textContent ?? '';
  setText('numeratorDefinition', '状态为 delivered 的订单');
  setText('denominatorDefinition', '全部状态订单');
  clickByText('.contract-submit-row button', '生成并确认');
  await new Promise((resolve) => setTimeout(resolve, 100));
  const ratioContract = document.querySelector('.metric-contract-output')?.textContent ?? '';
  const downloadVisible = Boolean(document.querySelector('.contract-output-heading button'));
  const nextStepText = document.querySelector('.contract-next-step')?.textContent.replace(/\s+/g, ' ').trim() ?? '';
  document.querySelector('.contract-next-step button')?.click();
  await new Promise((resolve) => setTimeout(resolve, 120));

  return {
    tabs: [...document.querySelectorAll('.profile-tabs button')].map((item) => item.textContent.trim()),
    qualityImpactText,
    qualityImpactCounts,
    qualityProgressAfterRecommendation,
    blockedMessage,
    countContract,
    ratioBlockedMessage,
    ratioContract,
    downloadVisible,
    nextStepText,
    activeTabAfterNext: document.querySelector('[role=tab][aria-selected=true]')?.textContent.trim() ?? '',
    nextNotice: document.querySelector('.agent-navigation-notice')?.textContent.replace(/\s+/g, ' ').trim() ?? '',
  };
})()`);

const checks = {
  metricTabVisible: result.tabs.some((tab) => tab.includes("指标口径")),
  qualityImpactGuidesNoviceBeforeContract: result.qualityImpactText.includes("按当前口径草案判断")
    && JSON.stringify(result.qualityImpactCounts) === JSON.stringify(["0", "1", "6"]),
  safeRecommendationsRequireOneRemainingHumanDecision: result.qualityProgressAfterRecommendation.includes("已完成 6/7 项")
    && result.qualityProgressAfterRecommendation.includes("还剩 1 项"),
  incompleteDefinitionBlocked: result.blockedMessage.includes("指标名称") && result.blockedMessage.includes("数据粒度"),
  countContractGenerated: result.countContract.includes("有效订单量") && result.countContract.includes("COUNT(DISTINCT order_id)"),
  qualityRiskScopedToMetric: result.countContract.includes("指标相关性")
    && result.countContract.includes("当前 7 项数据集风险均不改变该指标的计算结果")
    && !result.countContract.includes("7 项数据质量问题尚未改变原始数据"),
  ratioRequiresBothSides: result.ratioBlockedMessage.includes("分子") && result.ratioBlockedMessage.includes("分母"),
  ratioContractGenerated: result.ratioContract.includes("状态为 delivered") && result.ratioContract.includes("全部状态订单"),
  contractDownloadVisible: result.downloadVisible,
  contractShowsExplicitNextStep: result.nextStepText.includes("下一步：预览并执行计算") && result.activeTabAfterNext.includes("计算执行") && result.nextNotice.includes("审核计算计划"),
  noRuntimeExceptions: runtimeErrors.length === 0,
};

const screenshot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
await writeFile(
  new URL("../../runtime/metricground-metric-contract.png", import.meta.url),
  Buffer.from(screenshot.data, "base64"),
);

console.log(JSON.stringify({ checks, result, runtimeErrors }, null, 2));
socket.close();
if (Object.values(checks).some((passed) => !passed)) process.exitCode = 1;
