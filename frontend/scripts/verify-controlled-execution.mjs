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
const mobileTest = process.argv.includes("--mobile") || process.env.METRICGROUND_MOBILE_TEST === "1";
if (mobileTest) {
  await command("Emulation.setDeviceMetricsOverride", {
    width: 820,
    height: 1180,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await command("Network.enable");
  await command("Network.setCacheDisabled", { cacheDisabled: true });
  await command("Network.emulateNetworkConditions", {
    offline: false,
    latency: 120,
    downloadThroughput: 1_000_000,
    uploadThroughput: 500_000,
    connectionType: "cellular4g",
  });
}
await command("Page.reload", { ignoreCache: true });
await new Promise((resolve) => setTimeout(resolve, 1700));
const fileInput = await command("Runtime.evaluate", { expression: 'document.querySelector(\'input[type="file"]\')', returnByValue: false });
if (!fileInput.result?.objectId) throw new Error("Upload input not found");
await command("DOM.setFileInputFiles", { objectId: fileInput.result.objectId, files: [fixture] });
await command("Runtime.callFunctionOn", {
  objectId: fileInput.result.objectId,
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
  };
  const setText = (name, value) => {
    const node = document.querySelector('[name="' + name + '"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const waitForDuckDB = async () => {
    const verificationDeadline = Date.now() + 20000;
    while (!document.querySelector('.independent-verification.passed') && !document.querySelector('.independent-verification.failed') && !document.querySelector('.independent-verification.error')) {
      if (Date.now() > verificationDeadline) throw new Error('Timed out waiting for DuckDB verification');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  clickByText('.profile-tabs button', '质量检查');
  await new Promise((resolve) => setTimeout(resolve, 60));
  [...document.querySelectorAll('.quality-actions')].forEach((actions) => actions.querySelector('button')?.click());
  await new Promise((resolve) => setTimeout(resolve, 60));
  clickByText('.profile-tabs button', '指标口径');
  await new Promise((resolve) => setTimeout(resolve, 50));
  setText('metricName', '有效订单量');
  setText('decisionQuestion', '判断各地区订单规模');
  [...document.querySelectorAll('.contract-confirmations input')].forEach((checkbox) => {
    if (!checkbox.checked) checkbox.click();
  });
  clickByText('.contract-submit-row button', '生成并确认');
  await new Promise((resolve) => setTimeout(resolve, 80));
  clickByText('.contract-next-step button', '下一步：预览并执行计算');
  await new Promise((resolve) => setTimeout(resolve, 80));

  const baseRule = document.querySelector('.execution-rule');
  baseRule.querySelector('input[type="checkbox"]').click();
  const fieldSelect = baseRule.querySelector('select');
  fieldSelect.value = 'region';
  fieldSelect.dispatchEvent(new Event('change', { bubbles: true }));
  const comparisonInput = baseRule.querySelector('input[placeholder="输入比较值"]');
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  valueSetter.call(comparisonInput, '华东');
  comparisonInput.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 50));

  const sqlCode = document.querySelector('.execution-code pre')?.textContent ?? '';
  clickByText('.execution-code-tabs button', 'pandas');
  await new Promise((resolve) => setTimeout(resolve, 30));
  const pandasCode = document.querySelector('.execution-code pre')?.textContent ?? '';
  clickByText('.execution-approval button', '批准并执行');
  await waitForDuckDB();
  const countResultValue = document.querySelector('.execution-result-main strong')?.textContent?.trim();
  const countResultDetails = [...document.querySelectorAll('.execution-result-details strong')].map((item) => item.textContent.trim());
  const countChecks = [...document.querySelectorAll('.execution-checks > div')].map((item) => item.textContent.replace(/\\s+/g, ' ').trim());
  const countWarnings = [...document.querySelectorAll('.execution-warning')].map((item) => item.textContent.replace(/\\s+/g, ' ').trim());
  const guideAfterCount = document.querySelector('.novice-steps .active strong')?.textContent.trim() ?? '';
  const resultNextText = document.querySelector('.execution-result-next')?.textContent.replace(/\\s+/g, ' ').trim() ?? '';
  const taskStateAfterCount = document.querySelector('.task-state')?.textContent.trim() ?? '';
  const completedPlanText = document.querySelector('.agent-plan-card')?.textContent.replace(/\\s+/g, ' ').trim() ?? '';
  const completedPlanFooter = document.querySelector('.agent-plan-footer')?.textContent.replace(/\\s+/g, ' ').trim() ?? '';
  const completionGuide = document.querySelector('.task-run-complete-guide')?.textContent.replace(/\\s+/g, ' ').trim() ?? '';
  const taskValidation = document.querySelector('.task-run-validation')?.textContent.replace(/\\s+/g, ' ').trim() ?? '';
  const countIndependentVerification = document.querySelector('.independent-verification')?.textContent.replace(/\\s+/g, ' ').trim() ?? '';
  clickByText('.task-run-complete-actions button', '下载报告并完成');
  await new Promise((resolve) => setTimeout(resolve, 100));
  const exportedCompletionGuide = document.querySelector('.task-run-complete-guide')?.textContent.replace(/\\s+/g, ' ').trim() ?? '';
  const completedGuideSteps = document.querySelectorAll('.novice-steps .done').length;
  const startNewAnalysisVisible = [...document.querySelectorAll('.task-run-complete-actions button')].some((item) => item.textContent.includes('开始新的分析'));

  clickByText('.profile-tabs button', '质量检查');
  await new Promise((resolve) => setTimeout(resolve, 60));
  const completedQualityGuide = document.querySelector('.quality-step-guide')?.textContent.replace(/\\s+/g, ' ').trim() ?? '';
  clickByText('.profile-tabs button', '指标口径');
  await new Promise((resolve) => setTimeout(resolve, 60));
  clickByText('.metric-type-grid button', '比例指标');
  await new Promise((resolve) => setTimeout(resolve, 40));
  const completedTraceInvalidatedAfterDefinitionChange = !document.querySelector('.task-run-trace');
  setText('numeratorDefinition', 'region 为华东的订单');
  setText('denominatorDefinition', '全部订单');
  clickByText('.contract-submit-row button', '生成并确认');
  await new Promise((resolve) => setTimeout(resolve, 80));
  clickByText('.profile-tabs button', '计算执行');
  await new Promise((resolve) => setTimeout(resolve, 80));
  const numeratorRule = document.querySelectorAll('.execution-rule')[1];
  const numeratorField = numeratorRule.querySelector('select');
  numeratorField.value = 'region';
  numeratorField.dispatchEvent(new Event('change', { bubbles: true }));
  const numeratorInput = numeratorRule.querySelector('input[placeholder="输入比较值"]');
  valueSetter.call(numeratorInput, '华东');
  numeratorInput.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const ratioDisabledBeforeConfirmation = document.querySelector('.execution-approval button')?.disabled === true;
  document.querySelector('.execution-ratio-confirmation input')?.click();
  await new Promise((resolve) => setTimeout(resolve, 30));
  clickByText('.execution-approval button', '批准并执行');
  await waitForDuckDB();
  const ratioResultValue = document.querySelector('.execution-result-main strong')?.textContent?.trim();
  const ratioChecks = [...document.querySelectorAll('.execution-checks > div')].map((item) => item.textContent.replace(/\\s+/g, ' ').trim());
  const ratioIndependentVerification = document.querySelector('.independent-verification')?.textContent.replace(/\\s+/g, ' ').trim() ?? '';
  document.querySelector('.execution-result')?.scrollIntoView({ block: 'center' });
  await new Promise((resolve) => setTimeout(resolve, 80));
  return {
    tabs: [...document.querySelectorAll('.profile-tabs button')].map((item) => item.textContent.trim()),
    planSteps: document.querySelectorAll('.execution-plan li').length,
    sqlCode,
    pandasCode,
    countResultValue,
    countResultDetails,
    countChecks,
    countWarnings,
    ratioResultValue,
    ratioChecks,
    ratioDisabledBeforeConfirmation,
    engine: document.querySelector('.engine-badge')?.textContent?.trim(),
    guideAfterCount,
    resultNextText,
    taskStateAfterCount,
    completedPlanText,
    completedPlanFooter,
    completionGuide,
    exportedCompletionGuide,
    completedGuideSteps,
    startNewAnalysisVisible,
    taskValidation,
    countIndependentVerification,
    ratioIndependentVerification,
    completedTraceInvalidatedAfterDefinitionChange,
    completedQualityGuide,
  };
})()`);

const checks = {
  executionTabVisible: result.tabs.some((tab) => tab.includes("计算执行")),
  planIsInspectable: result.planSteps === 5,
  sqlIsParameterized: result.sqlCode.includes("COUNT(DISTINCT `order_id`)") && result.sqlCode.includes(":filter_value"),
  pandasIsInspectable: result.pandasCode.includes("nunique(dropna=True)"),
  distinctCountCorrect: result.countResultValue === "3",
  rowLineageCorrect: JSON.stringify(result.countResultDetails.slice(0, 3)) === JSON.stringify(["11", "4", "3"]),
  validationsPassed: result.countChecks.length === 3 && result.countChecks.every((item) => item.includes("通过")),
  runtimeFilterReclassifiesRelevantRisk: result.countWarnings.some((warning) => warning.includes("1 项指标相关风险"))
    && result.taskValidation.includes("1 项会影响当前指标")
    && result.taskValidation.includes("6 项与当前口径无关"),
  ratioCalculationCorrect: result.ratioResultValue === "30.00%",
  ratioBoundaryValidated: result.ratioChecks.length === 4 && result.ratioChecks.every((item) => item.includes("通过")),
  ratioDefinitionConfirmationRequired: result.ratioDisabledBeforeConfirmation,
  deterministicEngineDisclosed: result.engine.includes("主计算 + DuckDB 独立复核"),
  countIndependentlyVerified: result.countIndependentVerification.includes("DuckDB 独立 SQL 复核已通过")
    && result.countIndependentVerification.includes("DuckDB 指标值一致"),
  ratioIndependentlyVerified: result.ratioIndependentVerification.includes("DuckDB 独立 SQL 复核已通过")
    && result.ratioIndependentVerification.includes("DuckDB 排除与比例边界一致"),
  taskTraceIncludesIndependentEvidence: result.taskValidation.includes("DuckDB-WASM 1.32.0 独立复核通过"),
  manualGuidedRunCreatesCompletedAgentTrace: result.guideAfterCount === "验证结果" && result.taskStateAfterCount.includes("已完成"),
  resultShowsExplicitVerificationStep: result.resultNextText.includes("下一步：查看验证证据"),
  completedPlanRemovesStaleNavigation: result.completedPlanText.includes("本次 Agent 任务已完成") && !result.completedPlanFooter.includes("按计划继续"),
  completionGuideHasFinalAction: result.completionGuide.includes("验证完成，请下载交付文件") && result.completionGuide.includes("下载报告并完成"),
  exportShowsCompletionFeedback: result.exportedCompletionGuide.includes("交付文件已下载，本次分析已完成")
    && result.exportedCompletionGuide.includes("TaskRun 审计记录已持久化")
    && result.exportedCompletionGuide.includes("本地数据工作区仅保存在当前浏览器")
    && result.completedGuideSteps === 5
    && result.startNewAnalysisVisible,
  definitionChangeInvalidatesOldEvidence: result.completedTraceInvalidatedAfterDefinitionChange,
  completedQualityReviewPointsToEvidence: result.completedQualityGuide.includes("质量判断已纳入本次结果")
    && result.completedQualityGuide.includes("查看验证证据")
    && !result.completedQualityGuide.includes("明确分析口径"),
  noRuntimeExceptions: runtimeErrors.length === 0,
};

const screenshot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
await writeFile(new URL("../../runtime/metricground-controlled-execution.png", import.meta.url), Buffer.from(screenshot.data, "base64"));
console.log(JSON.stringify({ checks, result, runtimeErrors }, null, 2));
socket.close();
if (Object.values(checks).some((passed) => !passed)) process.exitCode = 1;
