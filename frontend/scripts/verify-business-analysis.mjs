import WebSocket from "ws";
import path from "node:path";
import { writeFile } from "node:fs/promises";

const fixture = path.resolve("../evaluation/fixtures/orders_quality_sample.csv");
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
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
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
await new Promise((resolve) => setTimeout(resolve, 1700));
const input = await command("Runtime.evaluate", { expression: 'document.querySelector(\'input[type="file"]\')', returnByValue: false });
await command("DOM.setFileInputFiles", { objectId: input.result.objectId, files: [fixture] });

const result = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const deadline = Date.now() + 15000;
  while (!document.querySelector('.profile-card')) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for uploaded profile');
    await sleep(80);
  }
  const textarea = document.querySelector('.query-box textarea');
  const textareaSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  const select = (label, value) => {
    const node = document.querySelector('select[aria-label="' + label + '"]');
    if (!node) throw new Error('Missing select: ' + label);
    node.value = value;
    node.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const clickText = (selector, text) => {
    const node = [...document.querySelectorAll(selector)].find((item) => item.textContent.includes(text));
    if (!node) throw new Error('Missing button: ' + text);
    node.click();
  };
  async function ask(question) {
    const previous = document.querySelector('.agent-plan-card')?.textContent ?? '';
    textareaSetter.call(textarea, question);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.query-box').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    const started = Date.now();
    while (true) {
      const card = document.querySelector('.agent-plan-card');
      if (card && !card.classList.contains('loading') && card.textContent !== previous) break;
      if (Date.now() - started > 50000) throw new Error('Agent timeout: ' + question);
      await sleep(100);
    }
    document.querySelector('.agent-plan-footer button')?.click();
    await sleep(220);
  }
  async function approveAndRun() {
    const confirmation = document.querySelector('.business-analysis-confirmation input');
    if (!confirmation.checked) confirmation.click();
    await sleep(30);
    document.querySelector('.execution-approval button')?.click();
    const started = Date.now();
    while (true) {
      const verification = document.querySelector('.business-analysis-result .independent-verification');
      if (verification && (verification.classList.contains('passed') || verification.classList.contains('failed') || verification.classList.contains('error'))) break;
      if (Date.now() - started > 20000) throw new Error('Timed out waiting for DuckDB business-analysis verification');
      await sleep(80);
    }
    return {
      rows: [...document.querySelectorAll('.business-result-table tbody tr')].map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent.trim())),
      checks: [...document.querySelectorAll('.business-analysis-result .execution-checks > div')].map((item) => item.textContent.replace(/\\s+/g, ' ').trim()),
      warnings: [...document.querySelectorAll('.business-analysis-result .execution-warning')].map((item) => item.textContent.replace(/\\s+/g, ' ').trim()),
      chart: Boolean(document.querySelector('.business-result-chart .recharts-responsive-container')),
      independentVerification: document.querySelector('.business-analysis-result .independent-verification')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
    };
  }

  await ask('分析各地区销售表现');
  select('聚合口径', 'sum');
  select('统计对象字段', 'order_id');
  select('数值字段', 'amount');
  select('分组字段', 'region');
  const confirmationRequired = document.querySelector('.execution-approval button')?.disabled === true;
  const group = await approveAndRun();
  const groupPlan = document.querySelector('.execution-plan')?.textContent.replace(/\\s+/g, ' ').trim() ?? '';
  const groupSql = document.querySelector('.execution-code pre')?.textContent ?? '';

  select('聚合口径', 'average');
  const average = await approveAndRun();

  await ask('按月查看销售趋势');
  select('聚合口径', 'sum');
  select('统计对象字段', 'order_id');
  select('数值字段', 'amount');
  select('时间字段', 'purchase_date');
  select('时间粒度', 'month');
  const trend = await approveAndRun();

  await ask('按地区查看销售额最高的前 2 名，金额使用 amount，不含运费');
  select('聚合口径', 'sum');
  select('统计对象字段', 'order_id');
  select('数值字段', 'amount');
  select('分组字段', 'region');
  const nInput = document.querySelector('input[aria-label="排名数量"]');
  const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  inputSetter.call(nInput, '2');
  nInput.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(30);
  const topN = await approveAndRun();
  const taskTrace = {
    state: document.querySelector('.task-state')?.textContent.replace(/\s+/g, ' ').trim() ?? '',
    stats: [...document.querySelectorAll('.task-run-stats strong')].map((item) => item.textContent.trim()),
    tools: [...document.querySelectorAll('.task-tool-trace span')].map((item) => ({ tool: item.dataset.tool, status: item.dataset.status })),
    validation: document.querySelector('.task-run-validation')?.textContent.replace(/\s+/g, ' ').trim() ?? '',
  };
  document.querySelector('.business-analysis-result')?.scrollIntoView({ block: 'center' });
  await sleep(80);
  return {
    selectedTab: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim() ?? '',
    confirmationRequired, group, average, trend, topN, groupPlan, groupSql, taskTrace,
    agentTools: [...document.querySelectorAll('.agent-tool-list span')].map((item) => item.textContent.trim()),
    activeAnalysis: document.querySelector('.business-analysis-types button.active strong')?.textContent.trim() ?? '',
  };
})()`);

const checks = {
  businessAnalysisViewReached: result.selectedTab.includes("经营分析"),
  humanConfirmationRequired: result.confirmationRequired,
  groupValuesCorrect: JSON.stringify(result.group.rows.map((row) => row.slice(0, 2))) === JSON.stringify([["华北", "10,349"], ["华东", "470"], ["华南", "420"]]),
  groupValidationPassed: result.group.checks.length === 3 && result.group.checks.every((item) => item.includes("通过")),
  groupIndependentlyVerified: result.group.independentVerification.includes("DuckDB 独立 SQL 复核")
    && result.group.independentVerification.includes("已通过"),
  groupWarningsExposeExcludedRows: result.group.warnings.some((item) => item.includes("1 行分组字段为空")),
  inspectablePlanAndSql: result.groupPlan.includes("排除空分组") && result.groupSql.includes("GROUP BY analysis_key"),
  averageValuesCorrect: JSON.stringify(result.average.rows.map((row) => row.slice(0, 2))) === JSON.stringify([["华北", "3,449.67"], ["华东", "156.67"], ["华南", "140"]]),
  averageIndependentlyVerified: result.average.independentVerification.includes("DuckDB 独立 SQL 复核")
    && result.average.independentVerification.includes("已通过"),
  trendValuesCorrect: JSON.stringify(result.trend.rows.map((row) => row.slice(0, 2))) === JSON.stringify([["2026-01", "11,249"]]),
  trendWarnsInvalidDate: result.trend.warnings.some((item) => item.includes("时间无法识别")),
  trendChartRendered: result.trend.chart,
  trendIndependentlyVerified: result.trend.independentVerification.includes("DuckDB 独立 SQL 复核")
    && result.trend.independentVerification.includes("已通过"),
  topNValuesCorrect: JSON.stringify(result.topN.rows.map((row) => row.slice(0, 2))) === JSON.stringify([["华北", "10,349"], ["华东", "470"]]),
  topNLimitValidated: result.topN.checks.some((item) => item.includes("Top N 边界正确") && item.includes("通过")),
  topNIndependentlyVerified: result.topN.independentVerification.includes("DuckDB 独立 SQL 复核")
    && result.topN.independentVerification.includes("已通过"),
  topNToolCalled: result.agentTools.includes("Top N 排名") && result.agentTools.includes("结果验证"),
  topNTypeSelected: result.activeAnalysis === "Top N",
  taskRunCompleted: result.taskTrace.state.includes("已完成"),
  taskRunRecordedApproval: Number(result.taskTrace.stats[3]) >= 1,
  taskRunRecordedExecutionAndValidation: result.taskTrace.tools.some((item) => item.tool === "execute_top_n" && item.status === "succeeded")
    && result.taskTrace.tools.some((item) => item.tool === "validate_result" && item.status === "succeeded")
    && result.taskTrace.validation.includes("DuckDB-WASM 1.32.0 独立复核通过"),
  noRuntimeExceptions: runtimeErrors.length === 0,
};
const screenshot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
await writeFile(new URL("../../runtime/metricground-business-analysis.png", import.meta.url), Buffer.from(screenshot.data, "base64"));
console.log(JSON.stringify({ checks, result, runtimeErrors }, null, 2));
socket.close();
if (Object.values(checks).some((passed) => !passed)) process.exitCode = 1;
