import assert from "node:assert/strict";
import path from "node:path";
import WebSocket from "ws";
import { buildEvidencePackage, evidenceAsMarkdown, verifyEvidencePackage } from "../app/lib/evidence-package.ts";

const targets = await fetch("http://127.0.0.1:9224/json/list").then(r => r.json());
const target = targets.find(item => item.url === "http://localhost:5173/");
assert(target, "Dedicated localhost browser required");
const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map(); const errors = []; let sequence = 0;
socket.on("message", raw => {
  const message = JSON.parse(raw.toString());
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id); pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
  }
  if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text);
});
await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
function command(method, params = {}) {
  const id = ++sequence; socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(expression) {
  const response = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
  return response.result.value;
}
try {
  await command("Runtime.enable");
  await command("Page.reload", { ignoreCache: true });
  await evaluate(`(async () => {
    const end = Date.now() + 15000;
    while (!Object.keys(document.querySelector('input[type=file]') ?? {}).some(key => key.startsWith('__reactProps$'))) {
      if (Date.now() > end) throw new Error('Hydrated file input not ready');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const original = window.fetch; window.__handoffWrites = [];
    window.fetch = async function(input, init) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/api/task-runs') && init?.method === 'PUT') window.__handoffWrites.push(JSON.parse(init.body));
      return original.call(this, input, init);
    };
  })()`);
  const input = await command("Runtime.evaluate", { expression: "document.querySelector('input[type=file]')", returnByValue: false });
  await command("DOM.setFileInputFiles", { objectId: input.result.objectId, files: [path.resolve("../evaluation/fixtures/orders_quality_sample.csv")] });
  const result = await evaluate(`(async () => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    async function wait(predicate, label, timeout = 20000) {
      const until = Date.now() + timeout;
      while (!predicate()) { if (Date.now() > until) throw new Error(label); await sleep(80); }
    }
    function click(selector, text) {
      const button = [...document.querySelectorAll(selector)].find(node => node.textContent.includes(text));
      if (!button) throw new Error('Missing button ' + text); button.click();
    }
    function text(name, value) {
      const node = document.querySelector(name);
      const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, value);
      node.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await wait(() => document.querySelector('.profile-card'), 'File profile missing');
    text('.query-box textarea', '比较不同地区的表现');
    document.querySelector('.query-box').dispatchEvent(new Event('submit', { bubbles:true, cancelable:true }));
    await wait(() => document.querySelector('.agent-plan-card.clarify'), 'Comparison plan missing');
    click('.profile-tabs button', '质量检查'); await sleep(100);
    for (const issue of document.querySelectorAll('.quality-issue')) { [...issue.querySelectorAll('button')].find(b => b.textContent.includes('暂不处理')).click(); await sleep(80); }
    click('.quality-step-guide button', '下一步'); await sleep(150);
    const afterQuality = document.querySelector('[role=tab][aria-selected=true]').textContent;
    const draftAnswersQuestion = document.querySelector('.analysis-draft-summary').textContent.includes('比较不同地区的表现');
    document.querySelector('.business-analysis-confirmation input').click();
    const parentId = document.querySelector('.task-run-heading small').textContent;
    click('.profile-tabs button', '清洗方案'); await sleep(100);
    for (const checkbox of document.querySelectorAll('.cleaning-option input')) if (!checkbox.checked) checkbox.click();
    await sleep(150); document.querySelector('.cleaning-second-confirm input').click();
    click('.cleaning-submit-row button', '二次确认');
    await wait(() => document.querySelector('.data-scope-review'), 'Scope change not visible');
    await sleep(250);
    click('.novice-guide-body > button', '前往'); await sleep(150);
    const afterClean = document.querySelector('[role=tab][aria-selected=true]').textContent;
    const confirmationReset = !document.querySelector('.business-analysis-confirmation input').checked;
    document.querySelector('.business-analysis-confirmation input').click(); await sleep(100);
    const blockedBeforeScope = document.querySelector('.execution-approval button').disabled;
    const scopeText = document.querySelector('.data-scope-review').textContent;
    document.querySelector('input[aria-label="确认清洗后的分析范围"]').click(); await sleep(100);
    document.querySelector('.execution-approval button').click();
    await wait(() => document.querySelector('.business-analysis-result .independent-verification.passed'), 'DuckDB comparison failed', 45000);
    await wait(() => document.querySelector('.task-state').textContent.includes('已完成'), 'Task not completed');
    await wait(() => window.__handoffWrites.some(run => run.state === 'COMPLETED') && document.querySelector('.task-run-persistence.saved'), 'Completed run not saved');
    const run = window.__handoffWrites.filter(run => run.state === 'COMPLETED').at(-1);
    const persistedResponse = await fetch('/api/task-runs?id=' + encodeURIComponent(run.id), { headers: { 'X-Trace-Id': run.traceId } });
    const persisted = (await persistedResponse.json()).run;
    text('.query-box textarea', '统计 order_id 去重后的订单数量');
    document.querySelector('.query-box').dispatchEvent(new Event('submit', { bubbles:true, cancelable:true }));
    await wait(() => window.__handoffWrites.some(run => run.question === '统计 order_id 去重后的订单数量' && run.state !== 'COMPLETED'), 'Count handoff missing');
    click('.agent-plan-footer button', '口径'); await sleep(150);
    text('input[name=metricName]', '有效订单量');
    click('.metric-type-grid button', '平均指标'); await sleep(100);
    const value = document.querySelector('select[name=valueField]'); value.value = 'amount'; value.dispatchEvent(new Event('change', { bubbles:true }));
    for (const checkbox of document.querySelectorAll('.contract-confirmations input')) if (!checkbox.checked) checkbox.click();
    await sleep(100); click('.contract-submit-row button', '生成并确认'); await sleep(150);
    const nameConflict = document.querySelector('.contract-errors')?.textContent.includes('名称表示数量');
    const originalGoalConflict = document.querySelector('.contract-errors')?.textContent.includes('原问题要求统计数量');
    const conflictDidNotCreateContract = !document.querySelector('.metric-contract-output');
    const originalQuestion = '原始文件所有状态下有多少笔不同订单';
    text('.query-box textarea', originalQuestion);
    document.querySelector('.query-box').dispatchEvent(new Event('submit', { bubbles:true, cancelable:true }));
    await wait(() => window.__handoffWrites.some(run => run.question === originalQuestion), 'Original goal missing');
    await sleep(150);
    const originalScopeWarning = document.querySelector('.data-scope-review [role=alert]')?.textContent.includes('不能只勾选');
    const restoreDiscoverable = Boolean(document.querySelector('.scope-restore-button'));
    document.querySelector('.scope-restore-button').click();
    await wait(() => !document.querySelector('.data-scope-review'), 'Scope not cleared after restoration');
    click('.profile-tabs button', '画像'); await sleep(150);
    const restoredRows = Number(document.querySelector('.profile-stats strong').textContent);
    await wait(() => window.__handoffWrites.some(run => run.question === originalQuestion && run.datasetVersions[0].rowCount === 11 && run.approvals.length === 0), 'Restoration did not reset task approvals');
    text('.query-box textarea', '比较不同地区的送货成功率');
    document.querySelector('.query-box').dispatchEvent(new Event('submit', { bubbles:true, cancelable:true }));
    await wait(() => document.querySelector('.agent-plan-card.clarify'), 'Grouped ratio clarification missing');
    const ratePlanClarifies = document.querySelector('.agent-plan-card.clarify')?.textContent.includes('确认成功条件和分母范围');
    click('.profile-tabs button', '经营分析'); await sleep(200);
    const rateAggregationSelected = document.querySelector('select[aria-label="聚合口径"]')?.value === 'ratio';
    const rateCannotExecute = document.querySelector('.business-analysis-workbench .execution-approval button').disabled;
    const rateExplained = document.querySelector('.execution-plan-error')?.textContent.includes('请确认分子的比较值');
    return { afterQuality, afterClean, draftAnswersQuestion, parentId, confirmationReset, blockedBeforeScope, scopeText, persisted, persistedStatus:persistedResponse.status, nameConflict, originalGoalConflict, conflictDidNotCreateContract, originalScopeWarning, restoreDiscoverable, restoredRows, ratePlanClarifies, rateAggregationSelected, rateCannotExecute, rateExplained };
  })()`);
  assert.equal(result.afterQuality.trim(), "经营分析");
  assert.equal(result.afterClean.trim(), "经营分析");
  assert(result.draftAnswersQuestion && result.confirmationReset && result.blockedBeforeScope);
  assert(result.scopeText.includes("11 → 7") && result.scopeText.includes("10 → 7"));
  assert.equal(result.persistedStatus, 200);
  assert.equal(result.persisted.question, "比较不同地区的表现");
  assert.equal(result.persisted.analysisSpec.groupBy[0].field, "region");
  assert(result.persisted.dataScopeEvidence.confirmedAt);
  assert(result.persisted.planningEvidence.reusedFrom.taskId);
  assert.equal(result.persisted.dataScopeEvidence.receipt.removedRows, 4);
  assert(result.nameConflict && result.originalGoalConflict && result.conflictDidNotCreateContract);
  assert(result.originalScopeWarning && result.restoreDiscoverable);
  assert.equal(result.restoredRows, 11);
  assert(result.ratePlanClarifies && result.rateAggregationSelected && result.rateCannotExecute && result.rateExplained);
  const evidence = buildEvidencePackage(result.persisted);
  assert(verifyEvidencePackage(evidence));
  assert(evidenceAsMarkdown(evidence).includes("数据范围变化与确认"));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed:true, qualityRoutesToComparison:true, cleaningPreservesQuestion:true, changedScopeBlockedUntilConfirmed:true, contractNameAndGoalConflictsBlocked:true, groupedRatioRequiresExplicitDefinition:true, evidenceVersion:evidence.version, runtimeErrors:errors, source:"Local policy route; no cloud requests" }, null, 2));
} finally { socket.close(); }
