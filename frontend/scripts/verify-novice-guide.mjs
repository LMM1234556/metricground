import WebSocket from "ws";
import path from "node:path";

const fixture = path.resolve("../evaluation/fixtures/join_orders_sample.csv");
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
  while (!document.querySelector('input[type=file]') || !document.querySelector('.novice-guide')) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for primary upload control');
    await sleep(60);
  }
})()`);

const initial = await evaluate(`({
  title: document.querySelector('.novice-guide-body h2')?.textContent.trim() ?? '',
  active: document.querySelector('.novice-steps .active strong')?.textContent.trim() ?? '',
  modes: [...document.querySelectorAll('.mode-switch button')].map((item) => ({ text: item.textContent.trim(), active: item.classList.contains('active') })),
  sidebarHeading: document.querySelector('.recent-section .section-heading')?.textContent.trim() ?? '',
})`);

const input = await command("Runtime.evaluate", { expression: 'document.querySelector("input[type=file]")', returnByValue: false });
if (!input.result.objectId) throw new Error("Primary upload input not found");
await command("DOM.setFileInputFiles", { objectId: input.result.objectId, files: [fixture] });
await command("Runtime.callFunctionOn", {
  objectId: input.result.objectId,
  functionDeclaration: "function(){ this.dispatchEvent(new Event('change', { bubbles: true })); }",
});

const result = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const deadline = Date.now() + 8000;
  while (!document.querySelector('.profile-card')) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for uploaded profile');
    await sleep(60);
  }
  await sleep(120);
  const afterUpload = {
    active: document.querySelector('.novice-steps .active strong')?.textContent.trim() ?? '',
    title: document.querySelector('.novice-guide-body h2')?.textContent.trim() ?? '',
    guidance: document.querySelector('.novice-guide-body')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
    query: document.querySelector('.query-box textarea')?.value ?? 'missing',
    placeholder: document.querySelector('.query-box textarea')?.placeholder ?? '',
    sidebarHeading: document.querySelector('.recent-section .section-heading')?.textContent.trim() ?? '',
    sidebarTemplates: [...document.querySelectorAll('.recent-section button')].map((item) => item.textContent.trim()),
    protectionMode: document.querySelector('.readonly-badge')?.textContent.trim() ?? '',
  };
  document.querySelector('.novice-guide-body > button')?.click();
  await sleep(120);
  const afterQualityAction = document.querySelector('[role=tab][aria-selected=true]')?.textContent.trim() ?? '';
  const inlineGuideBefore = document.querySelector('.quality-step-guide')?.textContent.replace(/\s+/g, ' ').trim() ?? '';
  [...document.querySelectorAll('.quality-issue')].forEach((issue) => {
    const buttons = issue.querySelectorAll('.quality-actions button');
    const reviewOnly = [...buttons].find((button) => button.textContent.includes('确认已核实'));
    if (reviewOnly) reviewOnly.click(); else buttons[0]?.click();
  });
  await sleep(150);
  const inlineGuideAfter = document.querySelector('.quality-step-guide')?.textContent.replace(/\s+/g, ' ').trim() ?? '';
  document.querySelector('.quality-step-guide > button')?.click();
  await sleep(120);
  const tabAfterInlineNext = document.querySelector('[role=tab][aria-selected=true]')?.textContent.trim() ?? '';
  const metricQuickTemplates = [...document.querySelectorAll('.metric-quick-grid button')].map((item) => item.textContent.replace(/\s+/g, ' ').trim());
  document.querySelector('.metric-quick-grid button')?.click();
  await sleep(100);
  const prefilledMetric = {
    name: document.querySelector('input[name=metricName]')?.value ?? '',
    decision: document.querySelector('input[name=decisionQuestion]')?.value ?? '',
    entity: document.querySelector('select[name=entityField]')?.value ?? '',
    scope: document.querySelector('input[name=filterScope]')?.value ?? '',
    grain: document.querySelector('textarea[name=grainDescription]')?.value ?? '',
    confirmationsChecked: [...document.querySelectorAll('.contract-confirmations input[type=checkbox]')].filter((item) => item.checked).length,
  };
  const define = {
    active: document.querySelector('.novice-steps .active strong')?.textContent.trim() ?? '',
    title: document.querySelector('.novice-guide-body h2')?.textContent.trim() ?? '',
    templates: [...document.querySelectorAll('.novice-templates button')].map((item) => item.textContent.trim()),
  };
  const amountTemplate = [...document.querySelectorAll('.novice-templates button')].find((item) => item.textContent.includes('amount'));
  amountTemplate?.click();
  await sleep(80);
  const templateFilled = document.querySelector('.query-box textarea')?.value ?? '';
  const taskRunVisibleBeforeExecution = Boolean(document.querySelector('.task-run-trace'));
  const expert = [...document.querySelectorAll('.mode-switch button')].find((item) => item.textContent.includes('自主模式'));
  expert?.click();
  await sleep(80);
  const expertMode = {
    guideHidden: !document.querySelector('.novice-guide'),
    compactNotice: document.querySelector('.expert-mode-note')?.textContent.replace(/\s+/g, ' ').trim() ?? '',
    suggestionsHidden: !document.querySelector('.suggestion-row'),
    placeholder: document.querySelector('.query-box textarea')?.placeholder ?? '',
    sidebarItems: [...document.querySelectorAll('.primary-nav .nav-item')].map((item) => item.textContent.replace(/\s+/g, ' ').trim()),
  };
  const guided = [...document.querySelectorAll('.mode-switch button')].find((item) => item.textContent.includes('新手引导'));
  guided?.click();
  await sleep(80);
  const guidedModeRestored = Boolean(document.querySelector('.novice-guide'));
  [...document.querySelectorAll('.contract-confirmations input[type=checkbox]')].forEach((checkbox) => {
    if (!checkbox.checked) checkbox.click();
  });
  document.querySelector('.contract-submit-row button')?.click();
  await sleep(120);
  const contractConfirmed = Boolean(document.querySelector('.metric-contract-output'));
  document.querySelector('.contract-next-step button')?.click();
  await sleep(120);
  const executionButton = document.querySelector('.execution-approval button');
  const executionReady = Boolean(executionButton) && !executionButton.disabled;
  executionButton?.click();
  const verificationDeadline = Date.now() + 20000;
  while (!document.querySelector('.independent-verification.passed')
    && !document.querySelector('.independent-verification.failed')
    && !document.querySelector('.independent-verification.error')) {
    if (Date.now() > verificationDeadline) throw new Error('Timed out waiting for novice workflow verification');
    await sleep(100);
  }
  const completedWorkflow = {
    activeStep: document.querySelector('.novice-steps .active strong')?.textContent.trim() ?? '',
    doneSteps: document.querySelectorAll('.novice-steps .done').length,
    result: document.querySelector('.execution-result-main strong')?.textContent.trim() ?? '',
    duckdbStatus: document.querySelector('.independent-verification')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
    taskState: document.querySelector('.task-state')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
    validation: document.querySelector('.task-run-validation')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
    completionAction: document.querySelector('.task-run-complete-guide')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
  };
  return {
    afterUpload, afterQualityAction, inlineGuideBefore, inlineGuideAfter, tabAfterInlineNext,
    metricQuickTemplates, prefilledMetric, define, templateFilled, taskRunVisibleBeforeExecution,
    expertMode, guidedModeRestored, contractConfirmed, executionReady, completedWorkflow,
  };
})()`);

const checks = {
  startsAtUpload: initial.active === "上传数据" && initial.title.includes("上传"),
  guidedModeDefault: initial.modes.find((item) => item.text === "新手引导")?.active === true,
  demoContentIsLabeledAsDemo: initial.sidebarHeading === "演示案例",
  uploadClearsStaleQuestion: result.afterUpload.query === "",
  uploadedDataRemovesOlistExamples: result.afterUpload.placeholder.includes("order_id")
    && !result.afterUpload.placeholder.includes("2018 年 GMV")
    && result.afterUpload.sidebarHeading === "当前数据模板"
    && result.afterUpload.sidebarTemplates.some((item) => item.includes("order_id")),
  originalFileProtectionIsExplicit: result.afterUpload.protectionMode.includes("原文件保护模式"),
  movesToQuality: result.afterUpload.active === "检查质量" && result.afterQualityAction.includes("质量检查"),
  qualityGuidancePreventsBlindSkipping: result.afterUpload.guidance.includes("正式工作不能机械地全部暂不处理") && result.afterUpload.guidance.includes("不代表问题已经解决"),
  qualityViewShowsVisibleProgress: /已完成 \d+\/\d+ 项/.test(result.inlineGuideBefore) && result.inlineGuideBefore.includes("定位下一项"),
  reviewOnlyConfirmationDoesNotTriggerCleaning: result.inlineGuideAfter.includes("人工核实结论") && !result.inlineGuideAfter.includes("确认清洗方案"),
  qualityViewShowsExplicitNextStep: result.inlineGuideAfter.includes("本步判断已完成") && result.inlineGuideAfter.includes("下一步：明确分析口径") && result.tabAfterInlineNext.includes("指标口径"),
  metricPageOffersPlainLanguageChoices: result.metricQuickTemplates.length >= 2 && result.metricQuickTemplates.some((item) => item.includes("去重订单量")),
  metricTemplatePrefillsButDoesNotApprove: result.prefilledMetric.name === "去重订单量" && result.prefilledMetric.decision.length > 4 && result.prefilledMetric.entity === "order_id" && result.prefilledMetric.scope.includes("order_id") && result.prefilledMetric.grain.includes("去重") && result.prefilledMetric.confirmationsChecked === 0,
  decisionsMoveToDefinition: result.define.active === "明确口径",
  templatesUseActualFields: result.define.templates.some((item) => item.includes("order_id")) && result.define.templates.some((item) => item.includes("amount")),
  templateFillsWithoutExecuting: result.templateFilled.includes("amount") && !result.taskRunVisibleBeforeExecution,
  expertModeIsCompactAndManual: result.expertMode.guideHidden
    && result.expertMode.suggestionsHidden
    && result.expertMode.compactNotice.includes('不会绕过安全门槛')
    && result.expertMode.placeholder.includes('指标、统计对象、分组、时间范围和筛选条件'),
  sidebarHasNoDeadProductNavigation: result.expertMode.sidebarItems.length === 1
    && result.expertMode.sidebarItems[0].includes('分析工作台'),
  guidedModeCanBeRestored: result.guidedModeRestored,
  confirmedContractUnlocksExecution: result.contractConfirmed && result.executionReady,
  noviceCompletesValidatedMetric: result.completedWorkflow.result === "4"
    && result.completedWorkflow.activeStep === "验证结果"
    && result.completedWorkflow.doneSteps === 4
    && result.completedWorkflow.taskState.includes("已完成"),
  independentVerificationIsVisible: result.completedWorkflow.duckdbStatus.includes("DuckDB 独立 SQL 复核已通过")
    && result.completedWorkflow.validation.includes("DuckDB-WASM 1.32.0 独立复核通过"),
  completionActionIsExplicit: result.completedWorkflow.completionAction.includes("验证完成，请下载交付文件")
    && result.completedWorkflow.completionAction.includes("下载报告并完成"),
  noRuntimeExceptions: runtimeErrors.length === 0,
};

console.log(JSON.stringify({ checks, initial, result, runtimeErrors }, null, 2));
await command("Page.reload", { ignoreCache: true });
await new Promise((resolve) => setTimeout(resolve, 600));
socket.close();
if (Object.values(checks).some((passed) => !passed)) process.exitCode = 1;
