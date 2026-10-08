import assert from "node:assert/strict";
import { inferStrongAnalysisType, isDistinctCountQuestion, resolveAgentAnalysisType } from "../app/lib/agent-plan.ts";
import { profileRows } from "../app/lib/tabular-profile.ts";
import { createExecutionConfig, executeMetricContract } from "../app/lib/metric-execution.ts";

const metadata = {
  fileName: "boundary.csv",
  fileSize: 128,
  fileType: "CSV",
  sheetNames: ["CSV 数据"],
  activeSheet: "CSV 数据",
};

const dateProfile = profileRows([
  ["order_id", "purchase_date"],
  ["O-1", "2024-02-29"],
  ["O-2", "2024-02-31"],
], metadata);
assert(dateProfile.qualityIssues.some((issue) => issue.id === "invalid-date-1"), "不存在的日历日期必须被识别");

const dictionaryProfile = profileRows([
  ["字段", "含义"],
  ["order_id", "订单编号"],
  ["amount", "订单金额"],
  ["region", "客户地区"],
], metadata);
assert.equal(dictionaryProfile.headerRowNumber, 1, "字段字典首行应识别为表头");
assert.equal(dictionaryProfile.rowCount, 3);
const titledProfile = profileRows([
  ["2026 年销售明细", null, null],
  ["order_id", "amount", "region"],
  ["O-1", 100, "华东"],
], metadata);
assert.equal(titledProfile.headerRowNumber, 2, "标题行之后的真实字段行应识别为表头");
assert.equal(titledProfile.rowCount, 1);

const numericProfile = profileRows([
  ["order_id", "amount"],
  ["O-1", "100"],
  ["O-2", ""],
  ["O-3", "bad"],
], metadata);
const baseContract = {
  version: "1.0",
  metricName: "金额总额",
  decisionQuestion: "检查金额",
  metricType: "amount",
  metricTypeLabel: "金额/总量",
  formula: "SUM(amount)",
  statisticalUnit: "order_id",
  valueField: "amount",
  timeField: null,
  filterScope: "全部记录",
  grainDescription: "一行一笔订单",
  source: { fileName: "boundary.csv", sheetName: "CSV 数据", rowCount: 3 },
  qualityDisposition: { approved: 0, kept: 0, undecided: 2, statement: "保留风险" },
  qualityImpact: { affecting: 0, review: 0, unrelated: 2, items: [], statement: "2 项与当前口径无关" },
  warnings: [],
  status: "confirmed",
};
const config = createExecutionConfig(numericProfile);
const amount = executeMetricContract(baseContract, numericProfile, config);
assert.equal(amount.value, 100);
assert.equal(amount.excludedInvalidValues, 2);

const average = executeMetricContract({ ...baseContract, metricType: "average", metricTypeLabel: "平均指标" }, numericProfile, config);
assert.equal(average.value, 100, "平均值只能使用具有有效数值的业务对象作为分母");

const invalidOnlyProfile = profileRows([
  ["order_id", "amount"],
  ["O-1", ""],
  ["O-2", "bad"],
], metadata);
const invalidOnly = executeMetricContract({
  ...baseContract,
  source: { ...baseContract.source, rowCount: 2 },
}, invalidOnlyProfile, createExecutionConfig(invalidOnlyProfile));
assert.equal(invalidOnly.displayValue, "无法计算");
assert.equal(invalidOnly.checks.find((check) => check.label === "结果为有限数值")?.passed, false);

assert.throws(
  () => executeMetricContract({ ...baseContract, source: { ...baseContract.source, fileName: "other.csv" } }, numericProfile, config),
  /数据版本与指标合同不一致/,
);
assert.throws(
  () => executeMetricContract({ ...baseContract, statisticalUnit: "missing_id" }, numericProfile, config),
  /不存在的字段：missing_id/,
);
assert.throws(
  () => executeMetricContract({ ...baseContract, valueField: null }, numericProfile, config),
  /缺少数值字段/,
);

const intentCases = [
  ["统计去重业务对象数量", "metric"],
  ["计算客户数", "metric"],
  ["删除重复行", "cleaning"],
  ["检查重复值和缺失值", "quality"],
  ["按月查看销售趋势", "trend"],
  ["销售额最高的前五个品类", "top_n"],
  ["按地区分组比较", "group_compare"],
  ["按客户地区汇总订单金额", "group_compare"],
  ["预测下季度销售额", "unsupported"],
];
for (const [question, expected] of intentCases) {
  assert.equal(resolveAgentAnalysisType(question, "quality"), expected, question);
}
assert.equal(isDistinctCountQuestion("统计订单量"), true);
assert.equal(inferStrongAnalysisType("帮我看看这份数据"), null, "含糊问题应交给模型或要求澄清");

console.log(JSON.stringify({
  checks: {
    realCalendarDateValidation: true,
    headerDetectionBoundaries: true,
    missingNumericValuesExcluded: true,
    averageUsesValidEntityDenominator: true,
    allInvalidValuesDoNotBecomeZero: true,
    staleContractBlocked: true,
    missingContractFieldsBlocked: true,
    deterministicIntentGuards: intentCases.length,
    ambiguousIntentDelegated: true,
  },
}, null, 2));
