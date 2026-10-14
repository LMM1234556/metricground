import assert from "node:assert/strict";
import readXlsxFile from "read-excel-file/node";
import { profileRows } from "../app/lib/tabular-profile.ts";
import { createBusinessAnalysisConfig, executeBusinessAnalysis, buildBusinessAnalysisPlan } from "../app/lib/business-analysis.ts";
import { analysisSpecFromBusinessConfig, createDatasetVersion, validateAnalysisSpec } from "../app/lib/analysis-spec.ts";
import { buildBusinessRatioSql } from "../app/lib/business-ratio-sql.ts";
import { createTaskRunFromPlan, approveTaskRun, startTaskTool, completeTaskTool } from "../app/lib/agent-runtime.ts";
import { enforcePolicyGuards } from "../app/lib/agent-plan-policy.ts";
import { buildEvidencePackage, evidenceAsMarkdown, verifyEvidencePackage } from "../app/lib/evidence-package.ts";

const metadata = { fileName: "ratio.csv", fileSize: 100, fileType: "CSV", activeSheet: "CSV 数据", sheetNames: ["CSV 数据"] };
const input = [["order_id", "region", "status", "amount"],
  ["A", "East", "delivered", 100], ["A", "East", "delivered", 100],
  ["B", "East", "cancelled", 200], ["C", "South", "DELIVERED", "bad"],
  ["D", "South", "shipped", null], [null, "Empty", "delivered", 999],
  ["E", null, "delivered", 100], ["F", "North", null, 200]];
const profile = profileRows(input, metadata);
const question = "比较不同地区的送货成功率";
const base = createBusinessAnalysisConfig(profile, null, question);
const config = { ...base, aggregation: "ratio", groupField: "region", entityField: "order_id",
  ratioNumerator: { enabled: true, field: "status", operator: "equals", value: "delivered" } };
assert.equal(base.aggregation, "ratio");
assert.equal(base.ratioNumerator.value, "", "成功状态必须由用户选择而非默默批准");
assert.equal(buildBusinessAnalysisPlan(profile, base, question).ready, false);
const result = executeBusinessAnalysis(profile, config, question);
assert.deepEqual(result.rows.map(row => [row.key, row.value, row.numerator, row.denominator]), [["East", .5, 1, 2], ["South", .5, 1, 2], ["North", 0, 0, 1]]);
assert.equal(result.excludedGroupingRows, 1);
assert.equal(result.excludedMissingEntities, 1);
assert.equal(result.excludedInvalidValues, 0, "金额错误不影响按订单统计成功率");
assert.deepEqual(result.zeroDenominatorGroups, ["Empty"]);
assert(result.checks.every(check => check.passed));
assert(result.warnings.some(warning => warning.includes("分母为零")));
const restricted = { ...config, ratioDenominator: { enabled: true, field: "status", operator: "not_equals", value: "cancelled" } };
const limited = executeBusinessAnalysis(profile, restricted, question);
assert.equal(limited.rows.find(row => row.key === "East").value, 1);
assert.equal(limited.excludedScopeRows, 2, "取消和空状态都不满足不等于条件");
assert.throws(() => executeBusinessAnalysis(profileRows([...input, ["A", "East", "shipped", 100]], metadata), config, question), /冲突/);
assert.throws(() => executeBusinessAnalysis(profileRows([...input, ["A", "West", "delivered", 100]], metadata), config, question), /冲突/);
assert.equal(buildBusinessAnalysisPlan(profile, { ...config, aggregation: "sum" }, question).ready, false);
assert.equal(buildBusinessAnalysisPlan(profile, { ...config, entityField: "status" }, question).ready, false);
assert.equal(buildBusinessAnalysisPlan(profile, { ...config, ratioNumerator: { ...config.ratioNumerator, enabled: false } }, question).ready, false);
const zero = executeBusinessAnalysis(profileRows([["order_id", "region", "status"], [null, "East", "delivered"]], metadata), config, question);
assert.equal(zero.rows.length, 0);
assert(zero.checks.some(check => !check.passed));
const hostile = { ...restricted, ratioNumerator: { ...config.ratioNumerator, value: "delivered' OR 1=1 --" } };
const sql = buildBusinessRatioSql(hostile);
assert(!sql.rows.includes(hostile.ratioNumerator.value));
assert.deepEqual(sql.parameters, ["cancelled", hostile.ratioNumerator.value]);
const spec = analysisSpecFromBusinessConfig(config, profile, question);
assert(validateAnalysisSpec(spec, [createDatasetVersion(profile)]).valid);
assert.equal(spec.numerator.filter.value, "delivered");
assert.equal(spec.valueField, null);
const candidate = enforcePolicyGuards({ analysisType: "group_compare", action: "ready", summary: "比较地区", clarification: null,
  tools: ["profile_dataset", "run_quality_checks", "execute_group_compare", "validate_result"], steps: ["确认口径"],
  fieldBindings: { entityField: "order_id", groupField: "region", valueField: "amount", timeField: null }, nextView: "经营分析", confidence: .8, limitations: [] }, question);
let run = createTaskRunFromPlan(profile, question, { plan: candidate, source: "policy-router", model: null, stepsExecuted: 0, latencyMs: 0 });
run = approveTaskRun(run, { type: "metric", statement: "确认状态和全部状态分母", spec });
const started = startTaskTool(run, "execute_group_compare", { analysisSpecId: spec.id });
run = completeTaskTool(started.run, { callId: started.callId, outputSummary: "分组比例", validationSummary: "合成测试，不作为实际DuckDB复核记录", resultSummary: "East=50%",
  resultEvidence: { engine: result.engine, sourceRows: result.sourceRows, eligibleRows: result.eligibleRows, excludedMissingEntities: result.excludedMissingEntities,
    excludedInvalidValues: result.excludedInvalidValues, groups: result.rows },
});
const evidence = buildEvidencePackage(run);
assert(verifyEvidencePackage(evidence));
assert.equal(evidence.resultEvidence.groups[0].numerator, 1);
assert(evidenceAsMarkdown(evidence).includes('"denominator": 2'));

// Replay the supplied participant's original file, not its cleaned subset.
const fixturePath = "E:/简历/agent_projects/metricground-olist-agent/evaluation/novice_test_files/novice_test_p04.xlsx";
const [sheet] = await readXlsxFile(fixturePath, { sheet: "orders" });
const original = profileRows(sheet.data, { ...metadata, fileName: "novice_test_p04.xlsx", fileType: "Excel", activeSheet: "orders", sheetNames: ["orders"] });
const originalConfig = { ...createBusinessAnalysisConfig(original, null, question), entityField: "order_id", groupField: "region", ratioNumerator: { ...config.ratioNumerator, value: "已送达" } };
const replay = executeBusinessAnalysis(original, originalConfig, question);
assert(replay.checks.every(check => check.passed));
const expected = new Map();
for (const record of original.records) {
  const region = String(record.region ?? "").trim(); const id = String(record.order_id ?? "").trim();
  if (!region || !id) continue;
  const group = expected.get(region) ?? { all: new Set(), success: new Set() };
  group.all.add(id); if (String(record.status).trim() === "已送达") group.success.add(id);
  expected.set(region, group);
}
for (const row of replay.rows) { const group = expected.get(row.key); assert.equal(row.numerator, group.success.size); assert.equal(row.denominator, group.all.size); }
assert.deepEqual(replay.rows.map(row => [row.key, row.numerator, row.denominator]), [["华南", 5, 5], ["华东", 3, 5], ["华北", 3, 5]]);
console.log(JSON.stringify({ passed: true, duplicateOrdersCountOnce: true, zeroDenominatorNotZeroPercent: true,
  conflictingOrdersBlocked: true, amountReplacementBlocked: true, ratioEvidencePreserved: true,
  participantP04: { file: original.fileName, sourceRows: replay.sourceRows, excludedGroupingRows: replay.excludedGroupingRows, rows: replay.rows }, cloudCalls: 0 }, null, 2));
