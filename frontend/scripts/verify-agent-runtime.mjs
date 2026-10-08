import assert from "node:assert/strict";
import { analysisSpecFromBusinessConfig } from "../app/lib/analysis-spec.ts";
import { approveTaskRun, completeTaskTool, createTaskRunFromPlan, failTaskTool, startTaskTool } from "../app/lib/agent-runtime.ts";
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
clarified = approveTaskRun(clarified, { type: "metric", statement: "销售表现定义为 amount 求和", spec });
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

console.log(JSON.stringify({ checks: 18, readyFlow: run.state, clarifiedFlow: clarified.state, qualityFlow: quality.state, failedFlow: failed.state, auditEvents: run.events.length }, null, 2));
