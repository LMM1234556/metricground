import WebSocket from "ws";
import path from "node:path";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const fixture = path.resolve("../evaluation/fixtures/orders_quality_sample.csv");
const sourceHashBefore = createHash("sha256").update(await readFile(fixture)).digest("hex");
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
await new Promise((resolve) => setTimeout(resolve, 1500));
const fileInput = await command("Runtime.evaluate", { expression: 'document.querySelector(\'input[type="file"]\')', returnByValue: false });
if (!fileInput.result?.objectId) throw new Error("Upload input not found");
await command("DOM.setFileInputFiles", { objectId: fileInput.result.objectId, files: [fixture] });

const result = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const deadline = Date.now() + 15000;
  while (!document.querySelector('.profile-card')) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for profile');
    await sleep(100);
  }
  const clickByText = (selector, text) => {
    const node = [...document.querySelectorAll(selector)].find((item) => item.textContent.includes(text));
    if (!node) throw new Error('Cannot find: ' + text);
    node.click();
  };
  const setText = (name, value) => {
    const node = document.querySelector('[name="' + name + '"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  };

  clickByText('.profile-tabs button', '清洗方案');
  await sleep(60);
  const optionCount = document.querySelectorAll('.cleaning-option input').length;
  [...document.querySelectorAll('.cleaning-option input')].forEach((checkbox) => {
    if (!checkbox.checked) checkbox.click();
  });
  await sleep(100);
  const preview = [...document.querySelectorAll('.cleaning-preview-stats strong')].map((item) => item.textContent.trim());
  const previewWarning = document.querySelector('.cleaning-preview-warning')?.textContent.replace(/\s+/g, ' ').trim() ?? '';
  const applyButton = [...document.querySelectorAll('.cleaning-submit-row button')].find((item) => item.textContent.includes('二次确认'));
  const disabledBeforeConfirm = applyButton.disabled;
  document.querySelector('.cleaning-second-confirm input').click();
  await sleep(40);
  applyButton.click();
  await sleep(120);

  const qualityTabText = [...document.querySelectorAll('.profile-tabs button')].find((item) => item.textContent.includes('质量检查'))?.textContent.trim();
  const banner = document.querySelector('.cleaned-version-banner')?.textContent.replace(/\\s+/g, ' ').trim() ?? '';
  const status = document.querySelector('.dataset-status')?.textContent.replace(/\\s+/g, ' ').trim() ?? '';
  const qualityEmpty = document.querySelector('.quality-empty')?.textContent.replace(/\\s+/g, ' ').trim() ?? '';

  clickByText('.profile-tabs button', '指标口径');
  await sleep(70);
  setText('metricName', '清洗后订单量');
  setText('decisionQuestion', '核对清洗后的订单规模');
  [...document.querySelectorAll('.contract-confirmations input')].forEach((checkbox) => {
    if (!checkbox.checked) checkbox.click();
  });
  clickByText('.contract-submit-row button', '生成并确认');
  await sleep(80);
  const contractText = document.querySelector('.metric-contract-output')?.textContent.replace(/\\s+/g, ' ').trim() ?? '';
  clickByText('.profile-tabs button', '计算执行');
  await sleep(80);
  clickByText('.execution-approval button', '批准并执行');
  await sleep(100);
  const resultValue = document.querySelector('.execution-result-main strong')?.textContent?.trim();
  const resultDetails = [...document.querySelectorAll('.execution-result-details strong')].map((item) => item.textContent.trim());
  const checks = [...document.querySelectorAll('.execution-checks > div')].map((item) => item.textContent.replace(/\\s+/g, ' ').trim());

  clickByText('.profile-tabs button', '清洗方案');
  await sleep(70);
  const receipt = document.querySelector('.cleaning-receipt')?.textContent.replace(/\\s+/g, ' ').trim() ?? '';
  document.querySelector('.cleaning-receipt')?.scrollIntoView({ block: 'center' });
  await sleep(80);
  return { optionCount, preview, previewWarning, disabledBeforeConfirm, qualityTabText, banner, status, qualityEmpty, contractText, resultValue, resultDetails, checks, receipt };
})()`);

const sourceHashAfter = createHash("sha256").update(await readFile(fixture)).digest("hex");
const checks = {
  fourSafeRulesOffered: result.optionCount === 4,
  previewReconciles: JSON.stringify(result.preview) === JSON.stringify(["11 行", "4 行", "7 行", "7 → 0"]),
  skippedCheckIsNotReportedAsResolved: result.previewWarning.includes("IQR 异常检查将不运行") && result.previewWarning.includes("不代表异常值已解决"),
  secondConfirmationRequired: result.disabledBeforeConfirm === true,
  derivedVersionVisible: result.status.includes("orders_quality_sample-cleaned.csv") && result.status.includes("7 行"),
  qualityRerunCompleted: result.qualityTabText === "质量检查" && result.qualityEmpty.includes("已运行的基础检查未发现明显问题") && result.qualityEmpty.includes("检查因样本不足未运行"),
  beforeAfterBannerVisible: result.banner.includes("11 → 7 行") && result.banner.includes("已发现问题 7 → 0") && result.banner.includes("检查因样本不足未运行"),
  contractBindsDerivedData: result.contractText.includes("清洗后订单量") && result.contractText.includes("检查未运行"),
  calculationUsesDerivedRows: result.resultValue === "7" && result.resultDetails[0] === "7" && result.resultDetails[1] === "7",
  resultChecksPass: result.checks.length === 3 && result.checks.every((item) => item.includes("通过")),
  receiptIsAuditable: result.receipt.includes("清洗副本已生成并复检") && result.receipt.includes("原文件未覆盖"),
  sourceFileUnchanged: sourceHashBefore === sourceHashAfter,
  noRuntimeExceptions: runtimeErrors.length === 0,
};

const screenshot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
await writeFile(new URL("../../runtime/metricground-cleaning-workflow.png", import.meta.url), Buffer.from(screenshot.data, "base64"));
console.log(JSON.stringify({ checks, result, sourceHashBefore, sourceHashAfter, runtimeErrors }, null, 2));
socket.close();
if (Object.values(checks).some((passed) => !passed)) process.exitCode = 1;
