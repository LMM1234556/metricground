import assert from "node:assert/strict";
import WebSocket from "ws";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { verifyEvidencePackage } from "../app/lib/evidence-package.ts";

// Dedicated localhost test browser only. The question is routed by policy;
// this test neither configures a provider nor sends a cloud-model request.
const targets = await fetch("http://127.0.0.1:9224/json/list").then((response) => response.json());
const target = targets.find((item) => item.url === "http://localhost:5173/");
assert(target, "Dedicated MetricGround regression browser not found");
const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
const errors = [];
let sequence = 0;
socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
  }
  if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text);
});
await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
function command(method, params = {}) {
  const id = ++sequence;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(expression) {
  const response = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
  return response.result.value;
}

try {
  await command("Runtime.enable");
  await command("Page.reload", { ignoreCache: true });
  await evaluate(`(async () => {
    const until = Date.now() + 15000;
    while (!document.querySelector('input[type="file"]')) {
      if (Date.now() > until) throw new Error('Upload input not ready');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    window.__evidenceDownloads = [];
    window.__evidenceBlobs = new Map();
    window.__evidenceRun = null;
    const fetchOriginal = window.fetch;
    window.fetch = async function(input, init) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/api/task-runs') && init?.method === 'PUT') window.__evidenceRun = JSON.parse(init.body);
      return fetchOriginal.call(this, input, init);
    };
    const createOriginal = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function(blob) {
      const url = createOriginal(blob);
      window.__evidenceBlobs.set(url, blob);
      return url;
    };
    const clickOriginal = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function() {
      if (this.download.startsWith('MetricGround-')) {
        window.__evidenceDownloads.push({ name: this.download, blob: window.__evidenceBlobs.get(this.href) });
      } else clickOriginal.call(this);
    };
  })()`);
  const input = await command("Runtime.evaluate", { expression: 'document.querySelector(\'input[type="file"]\')', returnByValue: false });
  await command("DOM.setFileInputFiles", { objectId: input.result.objectId, files: [path.resolve("../evaluation/fixtures/orders_profile_sample.csv")] });
  const result = await evaluate(`(async () => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    async function waitFor(predicate, label, timeout = 20000) {
      const until = Date.now() + timeout;
      while (!predicate()) { if (Date.now() > until) throw new Error(label + '; persistence=' + document.querySelector('.task-run-persistence')?.textContent + '; capturedRevision=' + window.__evidenceRun?.persistenceRevision); await sleep(100); }
    }
    await waitFor(() => document.querySelector('.profile-card'), 'Profile not ready');
    const textarea = document.querySelector('.query-box textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, '按 region 分组比较 item_sales 合计');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.query-box').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => document.querySelector('.agent-plan-card.ready, .agent-plan-card.clarify'), 'Plan not ready');
    const tab = text => [...document.querySelectorAll('.profile-tabs button')].find(button => button.textContent.includes(text));
    document.querySelector('.agent-plan-footer button').click();
    await waitFor(() => document.querySelector('.business-analysis-confirmation'), 'Business analysis gate not ready');
    const blockedBeforeQuality = Boolean(document.querySelector('.quality-execution-blocker')) && document.querySelector('.execution-approval button').disabled;
    tab('质量检查').click();
    await sleep(100);
    for (const issue of document.querySelectorAll('.quality-issue')) {
      [...issue.querySelectorAll('button')].find(button => button.textContent.includes('暂不处理')).click();
      await sleep(100);
    }
    document.querySelector('.agent-plan-footer button').click();
    await waitFor(() => document.querySelector('.business-analysis-confirmation'), 'Business analysis not ready');
    function select(label, value) {
      const select = document.querySelector('select[aria-label="' + label + '"]');
      if (!select) throw new Error('Missing select ' + label);
      select.value = value; select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    select('聚合口径', 'sum'); select('统计对象字段', 'order_id'); select('数值字段', 'item_sales'); select('分组字段', 'region');
    await sleep(100);
    document.querySelector('.business-analysis-confirmation input').click();
    await sleep(100);
    document.querySelector('.execution-approval button').click();
    await waitFor(() => document.querySelector('.business-analysis-result .independent-verification.passed'), 'DuckDB verification not passed', 45000);
    await waitFor(() => document.querySelector('.task-state')?.textContent.includes('已完成'), 'Task not completed');
    const staleClarification = Boolean(document.querySelector('.agent-plan-card.completed .agent-clarification'));
    const clickDownload = label => {
      const button = [...document.querySelectorAll('.task-run-trace button')].find(button => button.textContent.includes(label));
      if (!button) throw new Error('Missing download button ' + label);
      button.click();
    };
    clickDownload('下载报告'); await sleep(100); clickDownload('审计 JSON');
    await waitFor(() => document.querySelector('.task-run-persistence.saved') && window.__evidenceRun?.toolCalls.some(call => call.tool === 'export_evidence'), 'Export not persisted');
    await sleep(600);
    const downloads = await Promise.all(window.__evidenceDownloads.map(async item => ({ name: item.name, content: await item.blob.text() })));
    const run = window.__evidenceRun;
    const response = await fetch('/api/task-runs?id=' + encodeURIComponent(run.id), { headers: { 'X-Trace-Id': run.traceId } });
    const persisted = await response.json();
    return { downloads, staleClarification, blockedBeforeQuality, persistedStatus: response.status, persisted: persisted.run };
  })()`);
  const jsonFile = result.downloads.find((file) => file.name.endsWith(".json"));
  const markdownFile = result.downloads.find((file) => file.name.endsWith(".md"));
  assert(jsonFile && markdownFile, "Both download paths must produce actual contents");
  const evidence = JSON.parse(jsonFile.content);
  const verification = evidence.toolCalls.find((call) => call.tool === "validate_result").input;
  assert.equal(evidence.version, "1.1");
  assert.equal(verifyEvidencePackage(evidence), true);
  const reportChecksum = markdownFile.content.match(/完整性校验：fnv1a32-pair-v1 \/ ([0-9a-f]{16})/)?.[1];
  assert.equal(reportChecksum, evidence.integrity.checksum, "报告与审计 JSON 必须共享同一证据快照校验和");
  assert(markdownFile.content.includes(`证据快照时间：${evidence.exportedAt}`));
  assert(!evidence.toolCalls.some((call) => call.tool === "export_evidence"), "下载动作不应进入不可变证据快照");
  assert(jsonFile.name.includes(evidence.task.id) && markdownFile.name.includes(evidence.task.id));
  assert(markdownFile.content.includes(evidence.task.id));
  assert.equal(evidence.analysisSpec.aggregation, "sum");
  assert.equal(evidence.analysisSpec.valueField, "item_sales");
  assert.equal(evidence.analysisSpec.groupBy[0].field, "region");
  assert.equal(evidence.planningEvidence.source, "policy-router");
  assert.equal(evidence.qualityEvidence.issues.length, 3);
  assert(evidence.qualityEvidence.issues.every((issue) => issue.decision === "kept"));
  assert.deepEqual(evidence.resultEvidence.groups.map(({ key, value }) => [key, value]), [["华南", 288.5], ["华东", 189.8], ["华北", 0]]);
  assert.equal(verification.status, "passed");
  assert(verification.sql.length > 500 && !verification.sql.includes("已截断"));
  assert.deepEqual(verification.parameters, []);
  assert.deepEqual(verification.aggregateResults.map(({ key, value }) => [key, value]), [["华南", 288.5], ["华东", 189.8], ["华北", 0]]);
  assert(markdownFile.content.includes(verification.sql));
  assert(markdownFile.content.includes("暂不处理（未修复）"));
  assert(!jsonFile.content.includes('"O-1001"'), "No original order rows");
  assert.equal(result.staleClarification, false);
  assert.equal(result.blockedBeforeQuality, true, "质量风险未逐项判断前必须阻止执行");
  assert.equal(result.persistedStatus, 200);
  assert.deepEqual(result.persisted.planningEvidence, evidence.planningEvidence);
  assert.deepEqual(result.persisted.qualityEvidence, evidence.qualityEvidence);
  assert.deepEqual(result.persisted.resultEvidence, evidence.resultEvidence);
  await command("Page.reload", { ignoreCache: true });
  const restored = await evaluate(`(async () => {
    const until = Date.now() + 20000;
    while (!document.querySelector('.task-state')?.textContent.includes('已完成')) {
      if (Date.now() > until) throw new Error('Completed task not restored after reload');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return document.querySelector('.task-run-heading small').textContent;
  })()`);
  assert(restored.includes(evidence.task.id.slice(0, 18)));
  assert.deepEqual(errors, []);
  const destination = path.resolve("../runtime/evidence-v0.3.6");
  await mkdir(destination, { recursive: true });
  for (const file of result.downloads) await writeFile(path.join(destination, path.basename(file.name)), file.content);
  const summary = { taskId: evidence.task.id, verifiedChecksum: evidence.integrity.checksum, sqlLength: verification.sql.length, modelSource: evidence.planningEvidence.source, riskCount: evidence.qualityEvidence.issues.length, datasetVersion: evidence.datasets[0].versionId, groups: evidence.resultEvidence.groups, persistenceAndReload: true, downloads: result.downloads.map((file) => file.name), runtimeErrors: errors };
  await writeFile(path.join(destination, "verification-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
} finally {
  socket.close();
}
