import assert from "node:assert/strict";
import { assessQualityImpact } from "../app/lib/quality-impact.ts";

const issues = [
  { id: "duplicate-rows", check: "重复行", severity: "高", title: "发现 1 行完全重复记录", evidence: "1 行", impact: "重复", recommendation: "核实", requiresApproval: true },
  { id: "order-duplicate", check: "键与粒度", severity: "中", title: "标识字段“order_id”存在重复值", evidence: "2 行", impact: "粒度", recommendation: "核实", requiresApproval: false, field: "order_id" },
  { id: "customer-duplicate", check: "键与粒度", severity: "中", title: "标识字段“customer_id”存在重复值", evidence: "2 行", impact: "粒度", recommendation: "核实", requiresApproval: false, field: "customer_id" },
  { id: "customer-missing", check: "完整性", severity: "高", title: "字段“customer_id”存在缺失值", evidence: "1 行", impact: "缺失", recommendation: "核实", requiresApproval: true, field: "customer_id" },
  { id: "date-invalid", check: "有效性", severity: "高", title: "日期字段“purchase_date”包含无法识别的值", evidence: "1 行", impact: "日期", recommendation: "核实", requiresApproval: true, field: "purchase_date" },
  { id: "amount-outlier", check: "异常值", severity: "中", title: "数值字段“amount”存在 1 个统计异常值", evidence: "1 行", impact: "金额", recommendation: "核实", requiresApproval: false, field: "amount" },
  { id: "region-missing", check: "完整性", severity: "中", title: "字段“region”存在缺失值", evidence: "1 行", impact: "地区", recommendation: "核实", requiresApproval: true, field: "region" },
];

const countContext = {
  metricName: "去重订单量",
  metricType: "count",
  entityField: "order_id",
  valueField: null,
  timeField: "purchase_date",
  filterScope: "order_id 非空的全部记录",
  decisionQuestion: "判断订单编号的总体规模",
  grainConfirmed: true,
};
const count = assessQualityImpact(issues, countContext);
assert.equal(count.affecting, 0);
assert.equal(count.review, 0);
assert.equal(count.unrelated, 7);
assert.match(count.statement, /均不改变该指标/);

const amount = assessQualityImpact(issues, {
  ...countContext,
  metricName: "订单金额总额",
  metricType: "amount",
  valueField: "amount",
  decisionQuestion: "判断全部订单金额规模",
});
assert.equal(amount.items.find((item) => item.issueId === "duplicate-rows")?.level, "affecting");
assert.equal(amount.items.find((item) => item.issueId === "amount-outlier")?.level, "affecting");
assert.equal(amount.items.find((item) => item.issueId === "order-duplicate")?.level, "review");

const trend = assessQualityImpact(issues, {
  ...countContext,
  metricName: "月度去重订单量",
  decisionQuestion: "比较每月订单趋势",
});
assert.equal(trend.items.find((item) => item.issueId === "date-invalid")?.level, "affecting");

const regionRatio = assessQualityImpact(issues, {
  ...countContext,
  metricName: "华东订单占比",
  metricType: "ratio",
  additionalScope: "分子条件：region 等于华东；分母：全部订单",
});
assert.equal(regionRatio.items.find((item) => item.issueId === "region-missing")?.level, "affecting");

console.log(JSON.stringify({
  checks: {
    distinctCountIgnoresAllSevenUnrelatedRisks: count.unrelated === 7,
    amountReclassifiesDuplicateAndOutlier: amount.affecting >= 2,
    amountKeepsGrainAsHumanReview: amount.review >= 1,
    trendReclassifiesInvalidDate: trend.items.find((item) => item.issueId === "date-invalid")?.level === "affecting",
    ratioReclassifiesFilterFieldMissingness: regionRatio.items.find((item) => item.issueId === "region-missing")?.level === "affecting",
  },
  count: { affecting: count.affecting, review: count.review, unrelated: count.unrelated, statement: count.statement },
  amount: { affecting: amount.affecting, review: amount.review, unrelated: amount.unrelated },
  trend: { affecting: trend.affecting, review: trend.review, unrelated: trend.unrelated },
  regionRatio: { affecting: regionRatio.affecting, review: regionRatio.review, unrelated: regionRatio.unrelated },
}, null, 2));
