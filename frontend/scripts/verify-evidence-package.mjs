import assert from "node:assert/strict";
import { buildEvidencePackage, evidenceAsJson, evidenceAsMarkdown, verifyEvidencePackage } from "../app/lib/evidence-package.ts";
import { completeTaskTool, createTaskRunFromPlan, recordEvidenceExport, startTaskTool } from "../app/lib/agent-runtime.ts";
import { approveTaskRun } from "../app/lib/agent-runtime.ts";
import { analysisSpecFromBusinessConfig } from "../app/lib/analysis-spec.ts";
import { profileRows } from "../app/lib/tabular-profile.ts";
import { bindQualityEvidence, captureQualityEvidence } from "../app/lib/task-evidence.ts";

const profile = profileRows([["order_id", "amount", "region"], ["O-1", 100, "华东"], ["O-2", 80, "华南"]], {
  fileName: "orders.csv", fileSize: 50, fileType: "CSV", sheetNames: ["CSV 数据"], activeSheet: "CSV 数据",
});
const plan = {
  action: "ready", analysisType: "group_compare", summary: "地区金额", clarification: null,
  tools: ["profile_dataset", "run_quality_checks", "execute_group_compare", "validate_result"],
  steps: ["画像", "质量", "计算", "验证"], fieldBindings: { entityField: "order_id", valueField: "amount", groupField: "region", timeField: null },
  nextView: "经营分析", confidence: 1, limitations: [],
};
let run = createTaskRunFromPlan(profile, "比较地区金额", { plan, source: "policy-router", model: null, stepsExecuted: 0, latencyMs: 1 }, { id: "evidence-task", now: "2026-09-20T00:00:00.000Z" });
const spec = analysisSpecFromBusinessConfig({ analysisType: "group_compare", aggregation: "sum", entityField: "order_id", valueField: "amount", groupField: "region", timeField: "", timeGrain: "month", limit: 5, sortDirection: "desc" }, profile, "比较地区金额");
run = approveTaskRun(run, { type: "metric", statement: "确认一行一订单，金额使用 amount", spec, now: "2026-09-20T00:00:01.000Z" });
const started = startTaskTool(run, "execute_group_compare", { analysisSpecId: spec.id, records: profile.records }, { callId: "evidence-call", now: "2026-09-20T00:00:02.000Z" });
const fullSql = `WITH base AS (SELECT * FROM "__TABLE__")\n${"-- verification detail\n".repeat(60)}SELECT SUM("amount") FROM base;`;
const parameters = ["long-parameter-".repeat(60)];
run = completeTaskTool(started.run, {
  callId: started.callId, outputSummary: "2 个地区", validationSummary: "结果有限且行数勾稽通过", resultSummary: "华东 100，华南 80",
  validationEvidence: {
    engine: "duckdb-wasm", engineVersion: "1.32.0", status: "passed", datasetVersionId: run.datasetVersions[0].versionId,
    sql: fullSql, parameters, checks: [{ label: "分组对账", passed: true, detail: "2/2" }],
    aggregateResults: Array.from({ length: 25 }, (_, index) => ({ key: `group-${index}`, value: index })),
    apiKey: "SECRET_MUST_NOT_EXPORT", optional: undefined,
  },
  resultEvidence: { engine: "browser-deterministic", sourceRows: 2, eligibleRows: 2, excludedMissingEntities: 0, excludedInvalidValues: 0, fullGroupCount: 2, groups: [{ key: "华东", value: 100, sourceRows: 1, distinctEntities: 1, excludedInvalidValues: 0 }], groupsTruncated: false },
  now: "2026-09-20T00:00:03.000Z",
});
run = recordEvidenceExport(run, "2026-09-20T00:00:04.000Z");
const evidence = buildEvidencePackage(run, "2026-09-20T00:00:05.000Z");
const runAfterSecondExport = recordEvidenceExport(run, "2026-09-20T00:00:06.000Z", "markdown");
const evidenceAfterSecondExport = buildEvidencePackage(runAfterSecondExport, "2026-09-20T00:00:07.000Z");
const json = evidenceAsJson(evidence);
const markdown = evidenceAsMarkdown(evidence);

assert.equal(evidence.task.state, "COMPLETED");
assert.equal(evidence.privacy.rawRowsIncluded, false);
assert.equal(verifyEvidencePackage(evidence), true);
assert.equal(evidence.toolCalls.find((call) => call.id === "evidence-call").input.records, "[已移除原始明细数据]");
assert(!json.includes('"O-1"'), "证据包不得包含原始订单行");
assert(!json.includes("export_evidence"), "下载动作不应改变已完成任务的证据快照");
assert.equal(evidence.exportedAt, "2026-09-20T00:00:03.000Z", "完成时间应固定为证据快照时间");
assert.equal(evidence.integrity.checksum, evidenceAfterSecondExport.integrity.checksum, "同一完成任务的连续下载必须具有相同校验和");
assert.deepEqual(evidenceAfterSecondExport, evidence, "报告和审计 JSON 必须来自同一不可变证据快照");
assert(markdown.includes("证据快照时间：2026-09-20T00:00:03.000Z"));
assert(markdown.includes("结果有限且行数勾稽通过"));
assert(markdown.includes("不包含 Excel/CSV 原始数据行"));
assert.equal(evidence.version, "1.2");
const verification = evidence.toolCalls.find((call) => call.tool === "validate_result").input;
assert.equal(verification.sql, fullSql, "复核 SQL 不得截断");
assert.deepEqual(verification.parameters, parameters, "绑定参数不得截断");
assert.equal(verification.aggregateResults.length, 25, "聚合对账不应被通用工具数组预览截断");
assert(!json.includes("SECRET_MUST_NOT_EXPORT"));
assert.equal(verifyEvidencePackage(JSON.parse(json)), true, "序列化后校验码仍有效，不能包含 undefined");
assert(markdown.includes(fullSql));
assert(markdown.includes("primary.amount") && markdown.includes("primary.region"));
assert(markdown.includes("聚合方式：sum") && markdown.includes("包含当前数据版本的全部记录/状态"));
assert(markdown.includes("分组对账 — 2/2"));
assert(markdown.includes("policy-router"));
assert.equal(evidence.planningEvidence.usage, null, "未记录的用量不能当成 0");
assert.deepEqual(evidence.planningEvidence.proposal.fieldBindings, { entityField: "order_id", valueField: "amount", groupField: "region", timeField: null });
assert(markdown.includes("人工确认前的候选计划") && markdown.includes("分析类型：group_compare"));
assert.equal(evidence.resultEvidence.groups[0].value, 100);

const cloudPlan = structuredClone(plan);
const cloudRun = createTaskRunFromPlan(profile, "模拟规划记录", {
  plan: cloudPlan, source: "cloud-agent", provider: "dashscope", model: "qwen-plus", stepsExecuted: 2, attempts: 1, latencyMs: 123,
  usage: { inputTokens: 100, outputTokens: 50 },
}, { now: "2026-09-20T00:00:00.000Z" });
cloudPlan.analysisType = "top_n";
cloudPlan.fieldBindings.valueField = "mutated-after-capture";
const cloudEvidence = buildEvidencePackage(cloudRun);
assert.deepEqual(cloudEvidence.planningEvidence.usage, { inputTokens: 100, outputTokens: 50 });
assert.equal(cloudEvidence.planningEvidence.proposal.analysisType, "group_compare", "候选计划必须在 TaskRun 创建时冻结");
assert.equal(cloudEvidence.planningEvidence.proposal.fieldBindings.valueField, "amount", "后续 UI 修改不能改写模型原始字段选择");
assert(evidenceAsMarkdown(cloudEvidence).includes("dashscope") && evidenceAsMarkdown(cloudEvidence).includes("qwen-plus"));

const riskyProfile = profileRows([
  ["order_id", "purchase_date", "amount", "mixed"],
  ["O-1", "invalid-date", null, "RAW_SAMPLE_PRIVATE"], ["O-1", "2026-01-02", 80, 42],
], { fileName: "risky.csv", fileSize: 80, fileType: "CSV", sheetNames: ["CSV 数据"], activeSheet: "CSV 数据" });
const quality = captureQualityEvidence(riskyProfile, { "missing-2": "kept" }, "2026-09-20T00:00:01.000Z");
assert.equal(quality.issues.find((issue) => issue.id === "missing-2").decision, "kept");
assert(quality.issues.some((issue) => issue.check === "有效性"));
assert(!JSON.stringify(quality).includes("RAW_SAMPLE_PRIVATE"), "混合类型证据不得泄露原始样例");
assert.throws(() => bindQualityEvidence(run, riskyProfile, {}), /数据版本不一致/);
const riskyRun = createTaskRunFromPlan(riskyProfile, "风险快照", { plan, source: "policy-router", model: null, stepsExecuted: 0, latencyMs: 1 }, { qualityDecisions: { "missing-2": "kept" } });
const riskyMd = evidenceAsMarkdown(buildEvidencePackage(riskyRun));
assert(riskyMd.includes("字段“amount”存在缺失值") && riskyMd.includes("暂不处理（未修复）"));
assert(riskyMd.includes("未判断") && riskyMd.includes("未执行的质量检查"));

const legacyRun = structuredClone(run);
delete legacyRun.planningEvidence;
delete legacyRun.qualityEvidence;
delete legacyRun.resultEvidence;
const legacyValidation = legacyRun.toolCalls.find((call) => call.tool === "validate_result");
legacyValidation.input.sql = fullSql.slice(0, 500) + "…[已截断]";
delete legacyValidation.input.parameters;
const legacyMd = evidenceAsMarkdown(buildEvidencePackage(legacyRun));
assert(legacyMd.includes("未记录规划来源") && legacyMd.includes("未记录质量风险明细"));
assert(legacyMd.includes("历史复核 SQL 已截断"));
assert.equal(buildEvidencePackage(legacyRun).task.id, run.id, "重新导出不得创建另一任务");

const legacyPlanningRun = structuredClone(run);
delete legacyPlanningRun.planningEvidence.proposal;
const legacyPlanningMd = evidenceAsMarkdown(buildEvidencePackage(legacyPlanningRun));
assert(legacyPlanningMd.includes("历史任务未保存人工确认前的候选计划"));

const tampered = structuredClone(evidence);
tampered.resultSummary = "被篡改";
assert.equal(verifyEvidencePackage(tampered), false);

console.log(JSON.stringify({ suite: "evidence-v1.2", fullSqlLength: fullSql.length, checksum: evidence.integrity.checksum, tools: evidence.toolCalls.map((call) => call.tool), rawRowsIncluded: evidence.privacy.rawRowsIncluded }, null, 2));
