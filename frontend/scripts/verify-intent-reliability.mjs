import assert from "node:assert/strict";
import { inferStrongAnalysisType, isDistinctCountQuestion } from "../app/lib/agent-plan.ts";
import { enforcePolicyGuards } from "../app/lib/agent-plan-policy.ts";
import { createBusinessAnalysisConfig, executeBusinessAnalysis } from "../app/lib/business-analysis.ts";
import { profileRows } from "../app/lib/tabular-profile.ts";

const cases = [
  ["统计 order_id 去重后的订单数量", "metric"],
  ["帮我算一下有多少笔不同的订单", "metric"],
  ["订单一共有几笔？", "metric"],
  ["相同订单编号只算一次，一共有多少个订单？", "metric"],
  ["重复订单只统计一次，有多少笔？", "metric"],
  ["共有多少个不重复的客户", "metric"],
  ["order_id 的唯一值有几个", "metric"],
  ["重复的订单有多少", "quality"],
  ["订单数是不是算重复了？", "quality"],
  ["检查重复值和缺失值", "quality"],
  ["关联后订单金额多了一倍，怎么办？", "quality"],
  ["合并客户表后 amount 对不上", "quality"],
  ["哪个地区的订单金额最多？", "top_n"],
  ["哪个地区的订单数最少？", "top_n"],
  ["金额最大的前 3 个地区", "top_n"],
  ["各地区订单数分别是多少", "group_compare"],
  ["按月观察订单金额变化", "trend"],
  ["计算每个订单的平均金额，订单数要去重", "metric"],
  ["预测下个月的销售额", "unsupported"],
  ["用回归模型预测收入", "unsupported"],
  ["对客户聚类再比较金额", "unsupported"],
];
for (const [question, expected] of cases) {
  assert.equal(inferStrongAnalysisType(question), expected, question);
}
assert.equal(inferStrongAnalysisType("帮我看看这份数据"), null);
assert.equal(isDistinctCountQuestion("计算每个订单的平均金额，订单数要去重"), false);
assert.equal(isDistinctCountQuestion("有多少重复订单"), false);

function plan(type, fields = {}) {
  const business = ["group_compare", "trend", "top_n"].includes(type);
  return {
    action: "ready", analysisType: type, summary: "候选分析计划", clarification: null,
    tools: ["profile_dataset", "run_quality_checks", business ? `execute_${type}` : "execute_metric", "validate_result"],
    steps: ["等待人工确认后执行"],
    fieldBindings: { entityField: "order_id", valueField: "amount", groupField: "region", timeField: null, ...fields },
    nextView: business ? "经营分析" : "指标口径", confidence: 0.76, limitations: [],
  };
}

const ranking = enforcePolicyGuards(plan("top_n"), "哪个地区的订单金额最多？");
assert.equal(ranking.analysisType, "top_n");
assert.equal(ranking.action, "clarify");
assert.equal(ranking.nextView, "经营分析");
assert.equal(ranking.fieldBindings.groupField, "region");
assert.ok(ranking.tools.includes("execute_top_n"));
assert.match(ranking.clarification, /退款/);
const trend = enforcePolicyGuards(plan("trend", { timeField: "purchase_date" }), "按月观察订单金额变化");
assert.equal(trend.analysisType, "trend");
assert.equal(trend.fieldBindings.timeField, "purchase_date");

const blocked = enforcePolicyGuards(plan("metric"), "预测下个月的销售额");
assert.equal(blocked.analysisType, "unsupported");
assert.equal(blocked.action, "unsupported");
assert.equal(blocked.nextView, null);
assert.deepEqual(Object.values(blocked.fieldBindings), [null, null, null, null]);
assert.deepEqual(blocked.tools, ["profile_dataset"]);
const quality = enforcePolicyGuards(plan("quality"), "检查金额字段的异常值");
assert.equal(quality.analysisType, "quality", "质量检查不能被金额口径澄清改成计算");
assert.equal(enforcePolicyGuards(plan("metric"), "计算 GMV").action, "clarify", "业务指标 GMV 不能冒充当前实际提供的 amount 字段");
assert.equal(enforcePolicyGuards(plan("metric"), "计算 amount 合计").action, "ready", "明确引用已有数值字段时保留机械聚合计划");
const missingGroup = enforcePolicyGuards({
  ...plan("top_n", { groupField: null }), action: "clarify", clarification: "请选择用于排名的分组字段。",
}, "哪个地区的订单金额最多？");
assert.match(missingGroup.clarification, /分组字段/);
assert.match(missingGroup.clarification, /退款/);

const profile = profileRows([
  ["order_id", "amount", "region"],
  ["O-1", 120, "华北"], ["O-2", 80, "华北"], ["O-3", 240, "华南"],
], { fileName: "intent.csv", fileSize: 100, fileType: "CSV", sheetNames: ["CSV 数据"], activeSheet: "CSV 数据" });
const maximum = createBusinessAnalysisConfig(profile, ranking, "哪个地区的订单金额最多？");
assert.equal(maximum.limit, 1);
assert.equal(maximum.aggregation, "sum");
assert.equal(maximum.sortDirection, "desc");
assert.deepEqual(executeBusinessAnalysis(profile, maximum).rows.map((row) => [row.key, row.value]), [["华南", 240]]);
const minimum = createBusinessAnalysisConfig(profile, ranking, "哪个地区的订单金额最少？");
assert.equal(minimum.sortDirection, "asc");
assert.deepEqual(executeBusinessAnalysis(profile, minimum).rows.map((row) => [row.key, row.value]), [["华北", 200]]);
const countRank = createBusinessAnalysisConfig(profile, plan("top_n"), "哪个地区的订单数最多？");
assert.equal(countRank.aggregation, "count_distinct");
assert.deepEqual(executeBusinessAnalysis(profile, countRank).rows.map((row) => [row.key, row.value]), [["华北", 2]]);
assert.equal(createBusinessAnalysisConfig(profile, ranking, "金额最大的前 3 个地区").limit, 3);
const missingConfig = createBusinessAnalysisConfig(profile, missingGroup, "哪个地区的订单金额最多？");
assert.equal(missingConfig.groupField, "", "计划中缺失的分组字段不能被其他文本字段悄悄替代");

console.log(JSON.stringify({ passed: true, routingCases: cases.length, policyChecks: 8,
  executionChecks: 5, scope: "自建表达与任务保持回归，不代表任意自然语言准确率" }, null, 2));
