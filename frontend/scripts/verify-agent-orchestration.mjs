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
await new Promise((resolve) => setTimeout(resolve, 1800));
const input = await command("Runtime.evaluate", { expression: 'document.querySelector(\'input[type="file"]\')', returnByValue: false });
await command("DOM.setFileInputFiles", { objectId: input.result.objectId, files: [fixture] });

const result = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const deadline = Date.now() + 15000;
  while (!document.querySelector('.agent-plan-card')) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for agent entry');
    await sleep(80);
  }
  const textarea = document.querySelector('.query-box textarea');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  async function ask(question) {
    const previousText = document.querySelector('.agent-plan-card')?.textContent ?? '';
    setter.call(textarea, question);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.query-box').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    const start = Date.now();
    while (true) {
      const card = document.querySelector('.agent-plan-card');
      const currentText = card?.textContent ?? '';
      const completed = card && !card.classList.contains('loading') && currentText !== previousText && document.querySelector('.agent-source');
      if (completed) break;
      if (Date.now() - start > 50000) throw new Error('Agent timed out: ' + question);
      await sleep(100);
    }
    await sleep(40);
    return {
      className: document.querySelector('.agent-plan-card')?.className ?? '',
      text: document.querySelector('.agent-plan-card')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
      source: document.querySelector('.agent-source')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
      tools: [...document.querySelectorAll('.agent-tool-list span')].map((item) => item.textContent.trim()),
      fallbackReason: document.querySelector('.agent-plan-card')?.dataset.fallbackReason ?? '',
    };
  }
  const quality = await ask('这份数据有哪些质量问题？');
  document.querySelector('.agent-plan-footer button')?.click();
  await sleep(700);
  const qualityNavigation = {
    notice: document.querySelector('.agent-navigation-notice')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
    selectedTab: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim() ?? '',
  };
  const distinctCount = await ask('统计去重业务对象数量');
  const customerCount = await ask('计算客户数');
  document.querySelector('.agent-plan-footer button')?.click();
  await sleep(700);
  const customerMetricHandoff = {
    selectedTab: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim() ?? '',
    metricType: document.querySelector('.metric-type-grid button[aria-pressed="true"] strong')?.textContent.trim() ?? '',
    entityField: document.querySelector('select[name="entityField"]')?.value ?? '',
    metricName: document.querySelector('input[name="metricName"]')?.value ?? '',
  };
  const amount = await ask('计算销售金额');
  const group = await ask('分析各地区销售表现');
  document.querySelector('.agent-plan-footer button')?.click();
  await sleep(700);
  const groupHandoff = {
    selectedTab: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim() ?? '',
    analysisType: document.querySelector('.business-analysis-types button.active strong')?.textContent.trim() ?? '',
    entityField: document.querySelector('select[aria-label="统计对象字段"]')?.value ?? '',
    valueField: document.querySelector('select[aria-label="数值字段"]')?.value ?? '',
    groupField: document.querySelector('select[aria-label="分组字段"]')?.value ?? '',
  };
  const ambiguous = await ask('帮我看看这份数据');
  document.querySelector('.agent-plan-card')?.scrollIntoView({ block: 'center' });
  await sleep(60);
  return { quality, qualityNavigation, distinctCount, customerCount, customerMetricHandoff, amount, group, groupHandoff, ambiguous, olistAnswerVisible: Boolean(document.querySelector('.answer-card')), evidence: document.querySelector('.agent-evidence-content')?.textContent.replace(/\\s+/g, ' ').trim() ?? '' };
})()`);

const checks = {
  clearIntentUsesReliableRouter: result.quality.source.includes("确定性策略路由"),
  qualityPlanUsesTools: result.quality.text.includes("Agent 执行计划") && result.quality.tools.includes("质量检查"),
  qualityIgnoresIrrelevantBindings: result.quality.className.includes("ready") && !result.quality.text.includes("字段绑定校验未通过"),
  qualityContinueNavigates: result.qualityNavigation.selectedTab.includes("质量检查") && result.qualityNavigation.notice.includes("已进入“质量检查”"),
  distinctCountUsesMetricPlan: result.distinctCount.className.includes("ready") && result.distinctCount.text.includes("去重计数指标") && result.distinctCount.tools.includes("指标口径确认") && !result.distinctCount.text.includes("valueFieldcount"),
  customerCountUsesCustomerEntity: result.customerCount.className.includes("ready") && result.customerMetricHandoff.selectedTab.includes("指标口径") && result.customerMetricHandoff.metricType.includes("计数指标") && result.customerMetricHandoff.entityField === "customer_id" && result.customerMetricHandoff.metricName.includes("客户"),
  amountAmbiguityClarified: result.amount.className.includes("clarify") && result.amount.text.includes("退款") && result.amount.text.includes("运费"),
  groupPlanUsesDeterministicTool: !result.group.className.includes("unsupported") && result.group.tools.includes("分组比较") && result.group.tools.includes("结果验证"),
  groupPlanNavigatesAndBindsFields: result.groupHandoff.selectedTab.includes("经营分析") && result.groupHandoff.analysisType.includes("分组比较") && result.groupHandoff.entityField === "order_id" && result.groupHandoff.valueField === "amount" && result.groupHandoff.groupField === "region",
  ambiguousRequestDoesNotInventMetric: !result.ambiguous.tools.includes("确定性计算") && (result.ambiguous.source.includes("qwen3:8b") || result.ambiguous.text.includes("明确本次分析目标")),
  uploadedDataDoesNotShowOlistAnswer: result.olistAnswerVisible === false,
  evidenceUsesUploadedDataset: result.evidence.includes("orders_quality_sample.csv") && result.evidence.includes("11 行"),
  rawRowsNotSentNoticeVisible: result.group.text.includes("不向模型发送原始数据行"),
  noRuntimeExceptions: runtimeErrors.length === 0,
};
const screenshot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
await writeFile(new URL("../../runtime/metricground-agent-plan.png", import.meta.url), Buffer.from(screenshot.data, "base64"));
console.log(JSON.stringify({ checks, result, runtimeErrors }, null, 2));
socket.close();
if (Object.values(checks).some((passed) => !passed)) process.exitCode = 1;
