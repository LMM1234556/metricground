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
await new Promise((resolve) => setTimeout(resolve, 1600));
const input = await command("Runtime.evaluate", {
  expression: 'document.querySelector(\'input[type="file"]\')',
  returnByValue: false,
});
if (!input.result?.objectId) throw new Error("Upload input not found");
await command("DOM.setFileInputFiles", { objectId: input.result.objectId, files: [fixture] });

const result = await evaluate(`(async () => {
  const deadline = Date.now() + 15000;
  while (!document.querySelector('.profile-card')) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for profile');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const qualityTab = [...document.querySelectorAll('.profile-tabs button')]
    .find((button) => button.textContent.includes('质量检查'));
  qualityTab.click();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const titles = [...document.querySelectorAll('.quality-issue h3')]
    .map((item) => item.textContent.trim());
  const summary = [...document.querySelectorAll('.quality-summary strong')]
    .map((item) => item.textContent.trim());
  const firstApproval = document.querySelector('.quality-issue .quality-actions button:nth-of-type(2)');
  firstApproval.click();
  await new Promise((resolve) => setTimeout(resolve, 50));
  return {
    titles,
    summary,
    issueCount: document.querySelectorAll('.quality-issue').length,
    hasEvidence: document.querySelectorAll('.quality-issue dt').length >= 3,
    approvalRecorded: document.querySelector('.quality-actions > span')?.textContent?.includes('批准清洗'),
    privacyNote: document.querySelector('.approval-note')?.textContent?.replace(/\\s+/g, ' ').trim(),
  };
})()`);

const checks = {
  duplicateDetected: result.titles.some((title) => title.includes("完全重复")),
  identifierRiskDetected: result.titles.some((title) => title.includes("order_id") && title.includes("重复")),
  missingnessDetected: result.titles.some((title) => title.includes("缺失值")),
  invalidDateDetected: result.titles.some((title) => title.includes("日期") && title.includes("无法识别")),
  outlierDetected: result.titles.some((title) => title.includes("异常值")),
  evidenceImpactAdviceVisible: result.hasEvidence,
  approvalRecordedWithoutMutation: result.approvalRecorded && result.privacyNote?.includes("不会修改或覆盖原始文件"),
  noRuntimeExceptions: runtimeErrors.length === 0,
};

const screenshot = await command("Page.captureScreenshot", {
  format: "png",
  captureBeyondViewport: false,
});
await writeFile(
  new URL("../../runtime/metricground-quality-checks.png", import.meta.url),
  Buffer.from(screenshot.data, "base64"),
);

console.log(JSON.stringify({ checks, result, runtimeErrors }, null, 2));
socket.close();
if (Object.values(checks).some((passed) => !passed)) process.exitCode = 1;
