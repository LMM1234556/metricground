import assert from "node:assert/strict";
import { analysisSpecFromBusinessConfig, analysisSpecFromMetricContract, createDatasetVersion, validateAnalysisSpec } from "../app/lib/analysis-spec.ts";
import { buildMetricContract, createMetricDraft } from "../app/lib/metric-contract.ts";
import { profileRows } from "../app/lib/tabular-profile.ts";
import { bindDatasetVersions, completeValidation, createTaskRun, detectDataVersionChange, failToolCall, markTaskFailure, recordApproval, setTaskPlan, startToolCall, succeedToolCall, transitionTaskRun } from "../app/lib/task-run.ts";

const metadata = { fileName: "orders.csv", fileSize: 120, fileType: "CSV", sheetNames: ["CSV 数据"], activeSheet: "CSV 数据" };
const profile = profileRows([
  ["order_id", "purchase_date", "amount", "region"],
  ["O-1", "2026-01-01", 100, "华东"],
  ["O-2", "2026-01-02", 80, "华南"],
  ["O-3", "2026-02-01", 120, "华东"],
], metadata);
const sameProfile = profileRows([
  ["order_id", "purchase_date", "amount", "region"],
  ["O-1", "2026-01-01", 100, "华东"],
  ["O-2", "2026-01-02", 80, "华南"],
  ["O-3", "2026-02-01", 120, "华东"],
], metadata);
const changedProfile = profileRows([
  ["order_id", "purchase_date", "amount", "region"],
  ["O-1", "2026-01-01", 100, "华东"],
  ["O-2", "2026-01-02", 81, "华南"],
  ["O-3", "2026-02-01", 120, "华东"],
], metadata);

const version = createDatasetVersion(profile);
assert.equal(version.versionId, createDatasetVersion(sameProfile).versionId, "相同数据必须生成稳定版本标识");
assert.notEqual(version.versionId, createDatasetVersion(changedProfile).versionId, "单元格变化必须改变版本标识");

const draft = createMetricDraft(profile);
Object.assign(draft, {
  metricName: "订单金额", decisionQuestion: "判断各期订单金额规模", metricType: "amount", entityField: "order_id",
  valueField: "amount", timeField: "purchase_date", grainDescription: "一行代表一笔订单。",
  grainConfirmed: true, qualityAcknowledged: true, definitionConfirmed: true,
});
const contract = buildMetricContract(draft, profile, {});
const metricSpec = analysisSpecFromMetricContract(contract, profile);
assert.equal(metricSpec.analysisType, "sum");
assert.equal(metricSpec.aggregation, "sum");
assert.equal(validateAnalysisSpec(metricSpec, [version]).valid, true);

const businessSpec = analysisSpecFromBusinessConfig({
  analysisType: "top_n", aggregation: "sum", entityField: "order_id", valueField: "amount", groupField: "region",
  timeField: "purchase_date", timeGrain: "month", limit: 2, sortDirection: "desc",
}, profile, "订单金额最高的两个地区");
assert.equal(validateAnalysisSpec(businessSpec, [version]).valid, true);
assert.deepEqual(businessSpec.groupBy, [{ table: "primary", field: "region" }]);

let run = createTaskRun({ id: "task-test", question: businessSpec.question, datasetVersions: [version], now: "2026-09-20T00:00:00.000Z" });
assert.equal(run.state, "DATA_PROFILED");
run = transitionTaskRun(run, "PLANNING", "开始拆解需求", "2026-09-20T00:00:01.000Z");
run = setTaskPlan(run, ["读取画像", "确认口径", "执行并验证"], businessSpec, "2026-09-20T00:00:02.000Z");
run = transitionTaskRun(run, "NEEDS_APPROVAL", "等待确认统计粒度", "2026-09-20T00:00:03.000Z");
run = recordApproval(run, { id: "approval-grain", type: "grain", decision: "approved", statement: "确认一行代表一笔订单", at: "2026-09-20T00:00:04.000Z" });
run = transitionTaskRun(run, "READY_TO_EXECUTE", "口径确认完成", "2026-09-20T00:00:05.000Z");
run = transitionTaskRun(run, "EXECUTING", "开始调用确定性分析工具", "2026-09-20T00:00:06.000Z");
const started = startToolCall(run, "execute_top_n", { analysisSpecId: businessSpec.id }, { id: "tool-1", now: "2026-09-20T00:00:07.000Z" });
run = succeedToolCall(started.run, started.callId, "生成 2 个地区结果", "2026-09-20T00:00:08.000Z");
run = transitionTaskRun(run, "VALIDATING", "执行完成，开始勾稽", "2026-09-20T00:00:09.000Z");
run = completeValidation(run, "行数、有限值、排序与 Top N 数量检查通过", "华东 220，华南 80", "2026-09-20T00:00:10.000Z");
assert.equal(run.state, "COMPLETED");
assert.equal(run.toolCalls[0].status, "succeeded");
assert.equal(run.approvals.length, 1);
assert.equal(run.events.at(-1).to, "COMPLETED");

const unchanged = detectDataVersionChange(run, [version]);
assert.equal(unchanged.state, "COMPLETED");
const changed = detectDataVersionChange(run, [createDatasetVersion(changedProfile)], "2026-09-20T00:00:11.000Z");
assert.equal(changed.state, "DATA_VERSION_CHANGED");

let failedRun = createTaskRun({ id: "task-failed", question: "测试失败记录", datasetVersions: [version] });
failedRun = transitionTaskRun(failedRun, "PLANNING", "规划");
failedRun = transitionTaskRun(failedRun, "READY_TO_EXECUTE", "无需澄清");
failedRun = transitionTaskRun(failedRun, "EXECUTING", "执行");
const failedStarted = startToolCall(failedRun, "execute_metric", {}, { id: "tool-fail" });
failedRun = failToolCall(failedStarted.run, failedStarted.callId, "字段不存在");
failedRun = markTaskFailure(failedRun, { code: "FIELD_NOT_FOUND", message: "字段不存在", recoverable: true });
assert.equal(failedRun.state, "FAILED");
assert.equal(failedRun.failure.code, "FIELD_NOT_FOUND");
assert.equal(failedRun.toolCalls[0].status, "failed");

let idle = createTaskRun({ id: "task-idle", question: "等待数据" });
idle = bindDatasetVersions(idle, [version]);
assert.equal(idle.state, "DATA_PROFILED");
assert.throws(() => transitionTaskRun(idle, "COMPLETED", "跳过执行"), /非法 Agent 状态转换/);

console.log(JSON.stringify({
  checks: 20,
  versionId: version.versionId,
  completedState: run.state,
  eventCount: run.events.length,
  toolCalls: run.toolCalls.length,
  approvals: run.approvals.length,
  changedState: changed.state,
  failedState: failedRun.state,
}, null, 2));
