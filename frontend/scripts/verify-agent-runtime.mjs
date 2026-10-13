import assert from "node:assert/strict";
import { analysisSpecFromBusinessConfig } from "../app/lib/analysis-spec.ts";
import { approveTaskRun, completeJoinTaskRun, completeTaskTool, createTaskRunFromPlan, failTaskTool, startTaskTool } from "../app/lib/agent-runtime.ts";
import { profileRows } from "../app/lib/tabular-profile.ts";

const profile = profileRows([
  ["order_id", "amount", "region"], ["O-1", 100, "华东"], ["O-2", 80, "华南"],
], { fileName: "orders.csv", fileSize: 50, fileType: "CSV", sheetNames: ["CSV 数据"], activeSheet: "CSV 数据" });
const basePlan = {
  action: "ready", analysisType: "group_compare", summary: "地区订单金额比较", clarification: null,
  tools: ["profile_dataset", "run_quality_checks", "execute_group_compare", "validate_result"],
  steps: ["读取画像", "检查质量", "确认口径", "分组计算", "验证结果"],
  fieldBindings: { entityField: "order_id", valueField: "amount", groupField: "region", timeField: null },
  nextView: "经营分析", confidence: 0.9, limitations: [],
};
let run = createTaskRunFromPlan(profile, "比较各地区订单金额", { plan: basePlan, source: "policy-router", model: null, stepsExecuted: 0, latencyMs: 1 }, { id: "runtime-ready" });
assert.equal(run.state, "NEEDS_APPROVAL");
assert.deepEqual(run.toolCalls.map((call) => call.tool), ["profile_dataset", "run_quality_checks"]);
const spec = analysisSpecFromBusinessConfig({ analysisType: "group_compare", aggregation: "sum", entityField: "order_id", valueField: "amount", groupField: "region", timeField: "", timeGrain: "month", limit: 5, sortDirection: "desc" }, profile, "比较各地区订单金额");
run = approveTaskRun(run, { type: "metric", statement: "确认一行一订单，按地区汇总 amount", spec });
assert.equal(run.state, "READY_TO_EXECUTE");
const started = startTaskTool(run, "execute_group_compare", { specId: spec.id }, { callId: "business-call" });
run = completeTaskTool(started.run, { callId: started.callId, outputSummary: "2 个地区", validationSummary: "有限值、排序、行数勾稽均通过", resultSummary: "华东 100，华南 80" });
assert.equal(run.state, "COMPLETED");
assert.equal(run.toolCalls.filter((call) => call.status === "succeeded").length, 4);
assert.equal(run.approvals.length, 1);

const clarifyPlan = { ...basePlan, action: "clarify", clarification: "确认金额字段", tools: ["profile_dataset", "run_quality_checks", "execute_group_compare", "validate_result"] };
let clarified = createTaskRunFromPlan(profile, "比较各地区销售表现", { plan: clarifyPlan, source: "policy-router", model: null, stepsExecuted: 0, latencyMs: 1 }, { id: "runtime-clarify" });
assert.equal(clarified.state, "NEEDS_CLARIFICATION");
clarified = approveTaskRun(clarified, { type: "metric", statement: "销售表现定义为 amount 求和", spec: { ...spec, question: clarified.question } });
assert.equal(clarified.state, "READY_TO_EXECUTE");

const qualityPlan = { ...basePlan, action: "ready", analysisType: "quality", tools: ["profile_dataset", "run_quality_checks", "validate_result"], nextView: "质量检查" };
const quality = createTaskRunFromPlan(profile, "检查质量", { plan: qualityPlan, source: "policy-router", model: null, stepsExecuted: 0, latencyMs: 1 }, { id: "runtime-quality" });
assert.equal(quality.state, "COMPLETED");
assert(quality.validationSummary);

let failed = createTaskRunFromPlan(profile, "比较各地区订单金额", { plan: basePlan, source: "policy-router", model: null, stepsExecuted: 0, latencyMs: 1 }, { id: "runtime-failed" });
failed = approveTaskRun(failed, { type: "metric", statement: "已确认", spec });
const failedStart = startTaskTool(failed, "execute_group_compare", { specId: spec.id }, { callId: "failed-call" });
failed = failTaskTool(failedStart.run, { callId: failedStart.callId, code: "INVALID_VALUE", message: "数值字段无法转换" });
assert.equal(failed.state, "FAILED");
assert.equal(failed.toolCalls.at(-1).status, "failed");

const items = profileRows([
  ["order_id", "category"], ["O-1", "A"], ["O-1", "B"], ["O-2", "A"],
], { fileName: "items.csv", fileSize: 40, fileType: "CSV", sheetNames: ["CSV 数据"], activeSheet: "CSV 数据" });
const joinPlan = {
  ...basePlan,
  action: "clarify",
  analysisType: "join",
  summary: "把商品品类补到订单信息",
  clarification: "确认关联键、关系和输出粒度",
  tools: ["profile_dataset", "request_join"],
  steps: ["读取画像", "确认关联", "预聚合右表", "执行关联", "验证结果"],
  fieldBindings: { entityField: null, valueField: null, groupField: null, timeField: null },
  nextView: "多表关联",
};
let joinRun = createTaskRunFromPlan(profile, "把商品品类补到订单信息", { plan: joinPlan, source: "policy-router", model: null, stepsExecuted: 0, latencyMs: 1 }, { id: "runtime-join", relatedProfiles: [items] });
assert.equal(joinRun.state, "NEEDS_CLARIFICATION");
const derived = profileRows([
  ["orders.order_id", "orders.amount", "items.category_distinct_list"], ["O-1", 100, "A、B"], ["O-2", 80, "A"],
], { fileName: "orders-items-joined.csv", fileSize: 80, fileType: "CSV", sheetNames: ["关联结果"], activeSheet: "关联结果" });
derived.joinAmountReconciliations = [{ tableId: "orders", tableAlias: "orders", field: "amount", qualifiedField: "orders.amount", sourceTotal: 180, outputTotal: 180, netDelta: 0, netDeltaRate: 0, validSourceRows: 2, outputValueRows: 2, duplicatedSourceRows: 0, excludedSourceRows: 0, duplicationImpact: 0, exclusionImpact: 0, status: "balanced" }];
derived.joinDerivationEvidence = { operation: "right-distinct-list-by-key", sourceVersionIds: joinRun.datasetVersions.map((version) => version.versionId), leftKeys: ["order_id"], rightKeys: ["order_id"], selectedRightFields: ["category"], grainDescription: "一行一订单，品类为去重列表", leftSourceRows: 2, rightSourceRows: 3, groupedRightKeys: 2, matchedRightKeys: 2, unmatchedLeftRows: 0, rightOrphanRows: 0, outputRows: 2 };
const wrongSourceDerived = structuredClone(derived);
wrongSourceDerived.joinDerivationEvidence.sourceVersionIds = ["dataset_other_left", "dataset_other_right"];
assert.throws(() => completeJoinTaskRun(joinRun, wrongSourceDerived), /源数据版本与当前 TaskRun 不一致/);
const wrongTaskRun = structuredClone(joinRun);
wrongTaskRun.planningEvidence.proposal.analysisType = "group_compare";
assert.throws(() => completeJoinTaskRun(wrongTaskRun, derived), /不是多表关联任务/);
joinRun = completeJoinTaskRun(joinRun, derived);
assert.equal(joinRun.state, "COMPLETED");
assert.equal(joinRun.datasetVersions.length, 3);
assert.equal(joinRun.approvals.at(-1).type, "join");
assert.deepEqual(joinRun.toolCalls.slice(-2).map((call) => call.tool), ["execute_grain_preserving_join", "validate_join_result"]);
assert(joinRun.datasetVersions.at(-1).joinDerivationEvidence);
assert(joinRun.resultSummary.includes("category"));

console.log(JSON.stringify({ checks: 28, readyFlow: run.state, clarifiedFlow: clarified.state, qualityFlow: quality.state, failedFlow: failed.state, joinFlow: joinRun.state, auditEvents: run.events.length }, null, 2));
