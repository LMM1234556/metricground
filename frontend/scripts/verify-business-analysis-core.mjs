import assert from "node:assert/strict";
import { buildBusinessAnalysisPlan, createBusinessAnalysisConfig, executeBusinessAnalysis } from "../app/lib/business-analysis.ts";
import { profileRows } from "../app/lib/tabular-profile.ts";

const profile = profileRows([
  ["order_id", "customer_id", "purchase_date", "amount", "region"],
  ["O-1", "C-1", "2026-01-01", 100, "华东"],
  ["O-1", "C-1", "2026-01-01", 100, "华东"],
  ["O-2", "C-2", "2026-01-02", 80, "华东"],
  ["O-3", "C-3", "2026-02-01", 120, "华南"],
  ["O-4", "C-4", "2026-02-31", 90, "华南"],
  ["O-5", "C-5", "2026-02-05", "bad", "华北"],
  ["O-6", null, "2026-03-01", 200, null],
], {
  fileName: "business.csv", fileSize: 256, fileType: "CSV", sheetNames: ["CSV 数据"], activeSheet: "CSV 数据",
});

const base = createBusinessAnalysisConfig(profile, null, "分析各地区订单量");
const groupCount = executeBusinessAnalysis(profile, {
  ...base, analysisType: "group_compare", aggregation: "count_distinct", entityField: "order_id", groupField: "region",
});
assert.deepEqual(groupCount.rows.map((row) => [row.key, row.value]), [["华东", 2], ["华南", 2], ["华北", 1]]);
assert.equal(groupCount.eligibleRows, 6);
assert.equal(groupCount.excludedGroupingRows, 1);
assert(groupCount.checks.every((check) => check.passed));

const groupSum = executeBusinessAnalysis(profile, {
  ...base, analysisType: "group_compare", aggregation: "sum", entityField: "order_id", valueField: "amount", groupField: "region",
});
assert.deepEqual(groupSum.rows.map((row) => [row.key, row.value]), [["华东", 280], ["华南", 210]]);
assert.equal(groupSum.excludedInvalidValues, 1);
assert(groupSum.warnings.some((warning) => warning.includes("无法转换")));

const groupAverage = executeBusinessAnalysis(profile, {
  ...base, analysisType: "group_compare", aggregation: "average", entityField: "order_id", valueField: "amount", groupField: "region",
});
assert.equal(groupAverage.rows.find((row) => row.key === "华东")?.value, 140, "平均值分母必须是具有有效值的去重业务对象");

const trend = executeBusinessAnalysis(profile, {
  ...base, analysisType: "trend", aggregation: "sum", entityField: "order_id", valueField: "amount", timeField: "purchase_date", timeGrain: "month",
});
assert.deepEqual(trend.rows.map((row) => [row.key, row.value]), [["2026-01", 280], ["2026-02", 120], ["2026-03", 200]]);
assert.equal(trend.excludedGroupingRows, 1, "不存在的日历日期不能进入趋势");
assert(trend.checks.every((check) => check.passed));

const topN = executeBusinessAnalysis(profile, {
  ...base, analysisType: "top_n", aggregation: "sum", entityField: "order_id", valueField: "amount", groupField: "region", limit: 1, sortDirection: "desc",
});
assert.deepEqual(topN.rows.map((row) => row.key), ["华东"]);
assert.equal(topN.fullGroupCount, 2);
assert(topN.checks.every((check) => check.passed));

const invalidPlan = buildBusinessAnalysisPlan(profile, { ...base, analysisType: "trend", timeField: "missing_date" });
assert.equal(invalidPlan.ready, false);
assert(invalidPlan.errors.some((error) => error.includes("时间字段")));
const invalidLimit = buildBusinessAnalysisPlan(profile, { ...base, analysisType: "top_n", limit: 0 });
assert.equal(invalidLimit.ready, false);
assert(invalidLimit.errors.some((error) => error.includes("1 至 50")));

console.log(JSON.stringify({
  checks: 16,
  groupCount: groupCount.rows,
  groupSum: groupSum.rows,
  trend: trend.rows,
  topN: topN.rows,
}, null, 2));
