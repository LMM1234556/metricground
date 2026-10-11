import assert from "node:assert/strict";
import { profileRows } from "../app/lib/tabular-profile.ts";
import { createMetricDraft, metricNameTypeConflict, buildMetricContract, readableMetricDraft } from "../app/lib/metric-contract.ts";
import { applyCleaningPlan } from "../app/lib/data-cleaning.ts";
import { analysisConfirmationView, createDataScopeEvidence, rebindMetricDraft, rebindTaskAfterCleaning } from "../app/lib/analysis-handoff.ts";
import { createTaskRunFromPlan, approveTaskRun } from "../app/lib/agent-runtime.ts";
import { analysisSpecFromBusinessConfig } from "../app/lib/analysis-spec.ts";
import { createExecutionConfig, buildExecutionPlan } from "../app/lib/metric-execution.ts";
import { buildEvidencePackage, evidenceAsMarkdown, verifyEvidencePackage } from "../app/lib/evidence-package.ts";

const source = profileRows([
  ["order_id", "amount", "region", "order_date"],
  ["A", 100, "East", "2026-01-01"], ["A", 100, "East", "2026-01-01"],
  ["B", 200, "South", "invalid"], ["C", 300, null, "2026-01-03"], ["D", 400, "North", "2026-01-04"],
], { fileName: "handoff.csv", fileSize: 180, fileType: "CSV", activeSheet: "CSV 数据", sheetNames: ["CSV 数据"] });
const plan = { analysisType: "group_compare", action: "clarify", summary: "地区比较", clarification: "确认比较指标", confidence: .75,
  tools: ["profile_dataset", "run_quality_checks", "execute_group_compare", "validate_result"], steps: ["确认原问题", "确认字段"],
  fieldBindings: { entityField: "order_id", valueField: "amount", groupField: "region", timeField: null }, limitations: [], nextView: "经营分析" };
assert.equal(analysisConfirmationView(plan, "比较不同地区的表现"), "经营分析");
assert.equal(analysisConfirmationView(null, "比较不同地区的表现"), "经营分析");
assert.equal(analysisConfirmationView({ ...plan, analysisType: "trend" }), "经营分析");
assert.equal(analysisConfirmationView({ ...plan, analysisType: "metric" }, "订单数量"), "指标口径");
const response = { plan, source: "cloud-agent", provider: "dashscope", model: "synthetic-test", stepsExecuted: 2, latencyMs: 1,
  modelDecision: { analysisType: "group_compare", entityField: "", valueField: "amount", groupField: "region", timeField: "" } };
const previous = createTaskRunFromPlan(source, "比较不同地区的表现", response);
const cleaned = applyCleaningPlan(source, source.qualityIssues.filter(issue => issue.supportedRepair).map(issue => issue.id));
const scope = createDataScopeEvidence(source, cleaned.cleanedProfile, cleaned.receipt, "order_id", previous.id);
assert.equal(scope.source.rowCount, 5); assert.equal(scope.derived.rowCount, 2);
assert.equal(scope.sourceDistinctEntities, 4); assert.equal(scope.derivedDistinctEntities, 2);
let next = rebindTaskAfterCleaning(cleaned.cleanedProfile, previous.question, response, previous, scope);
assert.equal(next.question, "比较不同地区的表现");
assert.equal(next.planningEvidence.proposal.analysisType, "group_compare");
assert.deepEqual(next.planningEvidence.modelDecision, previous.planningEvidence.modelDecision);
assert.equal(next.planningEvidence.capturedAt, previous.planningEvidence.capturedAt);
assert.equal(next.planningEvidence.reusedFrom.taskId, previous.id);
assert.equal(next.datasetVersions.length, 2);
assert.equal(next.approvals.length, 0);
const spec = analysisSpecFromBusinessConfig({ analysisType: "group_compare", aggregation: "sum", entityField: "order_id", valueField: "amount", groupField: "region", timeField: "", timeGrain: "month", limit: 5, sortDirection: "desc" }, cleaned.cleanedProfile, previous.question);
assert.throws(() => approveTaskRun(next, { type: "metric", statement: "尚未核对范围", spec }), /范围尚未确认/);
next.dataScopeEvidence.confirmedAt = new Date().toISOString();
next = approveTaskRun(next, { type: "metric", statement: "确认改用清洗范围", spec });
assert.equal(next.state, "READY_TO_EXECUTE");
const originalDraft = { ...createMetricDraft(source), metricName: "平均订单金额", decisionQuestion: "核对平均金额", metricType: "average", grainConfirmed: true, qualityAcknowledged: true, definitionConfirmed: true };
const reboundDraft = rebindMetricDraft(originalDraft, cleaned.cleanedProfile);
assert.equal(reboundDraft.metricType, "average"); assert.equal(reboundDraft.metricName, "平均订单金额");
assert.equal(reboundDraft.grainConfirmed, false); assert.equal(reboundDraft.qualityAcknowledged, false);
assert.equal(metricNameTypeConflict("有效订单量", "average") !== null, true);
assert.equal(metricNameTypeConflict("去重订单量", "amount") !== null, true);
assert.equal(metricNameTypeConflict("去重订单量", "count"), null);
assert.equal(metricNameTypeConflict("平均订单金额", "average"), null);
const validDraft = { ...originalDraft, metricType: "count", metricName: "去重订单量" };
const contract = buildMetricContract(validDraft, source, {});
assert.throws(() => buildMetricContract({ ...validDraft, metricType: "average", metricName: "有效订单量" }, source, {}), /名称表示数量/);
const staleContract = { ...contract, metricName: "有效订单量", metricType: "average", valueField: "amount" };
assert.equal(buildExecutionPlan(staleContract, createExecutionConfig(source)).ready, false, "旧工作区中的矛盾合同也必须拦截");
assert(readableMetricDraft(validDraft, source).operation.includes("只算一次"));
assert(readableMetricDraft(validDraft, source).source.includes("不会自动变成筛选"));
const evidence = buildEvidencePackage(next);
assert(verifyEvidencePackage(evidence));
assert.equal(evidence.version, "1.4");
assert.equal(evidence.dataScopeEvidence.receipt.actions.reduce((total, action) => total + action.affectedRows, 0), 3);
const markdown = evidenceAsMarkdown(evidence);
assert(markdown.includes("数据范围变化与确认") && markdown.includes("未重新调用模型"));
assert(!JSON.stringify(evidence).includes('"records"'), "范围证据不包含原始明细");
console.log(JSON.stringify({ passed: true, originalGoalPreserved: true, approvalsReset: true, scopeApprovalEnforced: true, conflictingMetricBlocked: true, scopeCounts: [4, 2], realModelRequests: 0 }, null, 2));
