import WebSocket from "ws";
import path from "node:path";
import { writeFile } from "node:fs/promises";

const fixture = path.resolve("../evaluation/fixtures/orders_profile_sample.csv");
const optionalExcelFixture = process.argv[2] ? path.resolve(process.argv[2]) : null;
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
  if (message.method === "Runtime.exceptionThrown") {
    runtimeErrors.push(message.params.exceptionDetails.text);
  }
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
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
  return response.result.value;
}

await command("Runtime.enable");
await command("Page.reload", { ignoreCache: true });
await new Promise((resolve) => setTimeout(resolve, 1800));

async function setFile(filePath) {
  const inputNode = await command("Runtime.evaluate", {
    expression: 'document.querySelector(\'input[type="file"]\')',
    returnByValue: false,
  });
  if (!inputNode.result?.objectId) throw new Error("Upload input not found");
  await command("DOM.setFileInputFiles", { objectId: inputNode.result.objectId, files: [filePath] });
}

await setFile(fixture);
const state = await evaluate(`(async () => {
  const deadline = Date.now() + 15000;
  while (!document.querySelector('.profile-card')) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for profile');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    status: document.querySelector('.dataset-status')?.textContent?.replace(/\\s+/g, ' ').trim(),
    stats: [...document.querySelectorAll('.profile-stats strong')].map((item) => item.textContent.trim()),
    grain: document.querySelector('.grain-card p')?.textContent?.trim(),
    rowCount: document.querySelectorAll('.profile-table tbody tr').length,
    missingRate: [...document.querySelectorAll('.profile-table tbody tr')]
      .find((row) => row.textContent.includes('freight_value'))?.children[2]?.textContent?.trim(),
    notice: document.querySelector('.profile-next-note')?.textContent?.replace(/\\s+/g, ' ').trim(),
  };
})()`);

const checks = {
  statusShowsUploadedFile: state.status?.includes("orders_profile_sample.csv") && state.status.includes("5 行 · 7 列"),
  profileStatsCorrect: JSON.stringify(state.stats) === JSON.stringify(["5", "7", "1", "1"]),
  grainSuggestionUsesOrderId: state.grain?.includes("order_id") && state.grain.includes("一笔订单"),
  allColumnsVisible: state.rowCount === 7,
  missingRateCorrect: state.missingRate === "20.0%",
  scopeBoundaryVisible: state.notice?.includes("不代表数据可以直接使用"),
  noRuntimeExceptions: runtimeErrors.length === 0,
};

let excelState = null;
if (optionalExcelFixture) {
  await setFile(optionalExcelFixture);
  const excelName = path.basename(optionalExcelFixture);
  excelState = await evaluate(`(async () => {
    const deadline = Date.now() + 15000;
    while (!document.querySelector('.dataset-status')?.textContent?.includes(${JSON.stringify(excelName)})) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for Excel profile');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const selector = document.querySelector('.sheet-selector select');
    const before = {
      options: selector ? [...selector.options].map((option) => option.value) : [],
      activeSheet: selector?.value ?? null,
      stats: [...document.querySelectorAll('.profile-stats strong')].map((item) => item.textContent.trim()),
    };
    if (selector && selector.options.length > 1) {
      selector.value = selector.options[1].value;
      selector.dispatchEvent(new Event('change', { bubbles: true }));
      const targetSheet = selector.options[1].value;
      await new Promise((resolve) => setTimeout(resolve, 1200));
      while (document.querySelector('.sheet-selector select')?.value !== targetSheet) {
        if (Date.now() > deadline) throw new Error('Timed out switching Excel sheet');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    return {
      ...before,
      switchedSheet: document.querySelector('.sheet-selector select')?.value ?? null,
      switchedStats: [...document.querySelectorAll('.profile-stats strong')].map((item) => item.textContent.trim()),
      error: document.querySelector('.file-error')?.textContent?.trim() ?? null,
    };
  })()`);
  checks.excelWorkbookLoaded = JSON.stringify(excelState.options) === JSON.stringify(["订单明细", "字段说明"])
    && JSON.stringify(excelState.stats) === JSON.stringify(["4", "5", "0", "1"])
    && excelState.error === null;
  checks.excelSheetSwitchWorks = excelState.switchedSheet === "字段说明"
    && JSON.stringify(excelState.switchedStats) === JSON.stringify(["3", "2", "0", "0"]);
}

const screenshot = await command("Page.captureScreenshot", {
  format: "png",
  captureBeyondViewport: false,
});
await writeFile(
  new URL("../../runtime/metricground-file-profile.png", import.meta.url),
  Buffer.from(screenshot.data, "base64"),
);

console.log(JSON.stringify({ checks, state, excelState, runtimeErrors }, null, 2));
socket.close();
if (Object.values(checks).some((passed) => !passed)) process.exitCode = 1;
