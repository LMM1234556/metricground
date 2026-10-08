import assert from "node:assert/strict";
import { createDatasetAgentContext } from "../app/lib/agent-plan.ts";
import { createBusinessAnalysisConfig, executeBusinessAnalysis } from "../app/lib/business-analysis.ts";
import { createDatasetCatalog, profileRelationship } from "../app/lib/dataset-catalog.ts";
import { createJoinSpec, executeControlledJoin } from "../app/lib/controlled-join.ts";
import { profileRows } from "../app/lib/tabular-profile.ts";

function profile(fileName, rows) {
  return profileRows(rows, { fileName, fileSize: JSON.stringify(rows).length, fileType: "CSV", sheetNames: ["CSV 数据"], activeSheet: "CSV 数据" });
}
async function plan(question, dataset) {
  const response = await fetch("http://localhost:5173/api/agent/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, dataset: createDatasetAgentContext(dataset) }),
  });
  if (!response.ok) throw new Error(`Agent API ${response.status}: ${await response.text()}`);
  return response.json();
}
function confirmed(spec, grain) {
  return { ...spec, intendedGrainDescription: grain, keyMeaningConfirmed: true, relationshipConfirmed: true, grainConfirmed: true, orphanRiskAcknowledged: true, expansionRiskAcknowledged: true, status: "confirmed" };
}

const orders = profile("orders.csv", [
  ["order_id", "customer_id", "order_date", "amount", "region"],
  ["O-1", "C-1", "2026-01-01", 100, "华东"],
  ["O-2", "C-2", "2026-01-02", 80, "华南"],
  ["O-3", "C-3", "2026-02-01", 120, "华东"],
  ["O-4", "C-4", "bad-date", 50, null],
]);
const orderPlan = await plan("按地区比较 amount 合计，不含运费", orders);
assert.equal(orderPlan.source, "policy-router");
assert.equal(orderPlan.plan.analysisType, "group_compare");
assert.equal(orderPlan.plan.fieldBindings.groupField, "region");
assert.equal(orderPlan.plan.fieldBindings.valueField, "amount");
const orderConfig = createBusinessAnalysisConfig(orders, orderPlan.plan, "按地区比较 amount 合计，不含运费");
const orderResult = executeBusinessAnalysis(orders, { ...orderConfig, aggregation: "sum", groupField: "region", valueField: "amount" });
assert.deepEqual(orderResult.rows.map((row) => [row.key, row.value]), [["华东", 220], ["华南", 80]]);
assert.equal(orderResult.excludedGroupingRows, 1);

const joinedOrders = profile("joined-orders.csv", [
  ["join_orders_sample.order_id", "join_orders_sample.amount", "join_customers_sample.region"],
  ["O-1", 120, "华东"], ["O-2", 80, "华南"], ["O-3", 150, "华东"], ["O-4", 60, null],
]);
const naturalJoinedPlan = await plan("按客户地区汇总订单金额，并说明无法匹配地区的订单影响", joinedOrders);
assert.equal(naturalJoinedPlan.plan.analysisType, "group_compare", "按客户地区汇总必须优先路由到分组比较");
assert.equal(naturalJoinedPlan.plan.fieldBindings.entityField, "join_orders_sample.order_id", "客户地区只是分组维度，订单金额仍应按订单作为统计对象");
assert.equal(naturalJoinedPlan.plan.fieldBindings.groupField, "join_customers_sample.region");
const scopedJoinedPlan = await plan("按客户地区分组比较 join_orders_sample.amount 合计，不含运费、税费和退款", joinedOrders);
assert.equal(scopedJoinedPlan.plan.analysisType, "group_compare");
assert.equal(scopedJoinedPlan.plan.action, "ready");

const marketing = profile("campaign_daily.csv", [
  ["campaign_id", "report_date", "channel", "spend", "clicks", "conversions"],
  ["M-1", "2026-01-01", "搜索", 100, 1000, 50],
  ["M-2", "2026-01-01", "信息流", 80, 800, 32],
  ["M-3", "2026-02-01", "搜索", 120, 1100, 55],
  ["M-1", "2026-02-02", "搜索", 20, 200, 10],
]);
const marketingPlan = await plan("按月查看 conversions 合计趋势", marketing);
assert.equal(marketingPlan.plan.analysisType, "trend");
assert.equal(marketingPlan.plan.fieldBindings.timeField, "report_date");
const marketingConfig = createBusinessAnalysisConfig(marketing, marketingPlan.plan, "按月查看 conversions 合计趋势");
const marketingResult = executeBusinessAnalysis(marketing, { ...marketingConfig, analysisType: "trend", aggregation: "sum", entityField: "campaign_id", valueField: "conversions", timeField: "report_date", timeGrain: "month" });
assert.deepEqual(marketingResult.rows.map((row) => [row.key, row.value]), [["2026-01", 82], ["2026-02", 65]]);
const ratioPlan = await plan("计算营销转化率", marketing);
assert.equal(ratioPlan.plan.analysisType, "metric");
assert.equal(ratioPlan.plan.nextView, "指标口径");
assert(ratioPlan.plan.steps.some((step) => step.includes("确认")), "比例指标必须进入人工口径确认，而不是由模型直接给答案");

const inventory = profile("inventory.csv", [
  ["snapshot_id", "snapshot_date", "warehouse", "sku_id", "stock_qty"],
  ["S-1", "2026-01-01", "华东仓", "SKU-1", 20],
  ["S-2", "2026-01-01", "华东仓", "SKU-2", 30],
  ["S-3", "2026-01-01", "华南仓", "SKU-3", 15],
]);
const inventoryPlan = await plan("按仓库分组比较 stock_qty 合计", inventory);
assert.equal(inventoryPlan.plan.analysisType, "group_compare");
assert.equal(inventoryPlan.plan.fieldBindings.groupField, "warehouse");
assert.equal(inventoryPlan.plan.fieldBindings.valueField, "stock_qty");
const inventoryConfig = createBusinessAnalysisConfig(inventory, inventoryPlan.plan, "按仓库分组比较 stock_qty 合计");
const inventoryResult = executeBusinessAnalysis(inventory, { ...inventoryConfig, aggregation: "sum", entityField: "snapshot_id", valueField: "stock_qty", groupField: "warehouse" });
assert.deepEqual(inventoryResult.rows.map((row) => [row.key, row.value]), [["华东仓", 50], ["华南仓", 15]]);

const ambiguous = await plan("分析各地区销售表现", orders);
assert.equal(ambiguous.plan.action, "clarify");
assert(ambiguous.plan.clarification.includes("去重计数") || ambiguous.plan.clarification.includes("金额字段"));
const unsupported = await plan("预测下个月销量并训练回归模型", inventory);
assert.equal(unsupported.plan.action, "unsupported");
assert.equal(unsupported.plan.analysisType, "unsupported");

const campaigns = profile("campaigns.csv", [
  ["campaign_id", "campaign_name", "owner"], ["M-1", "品牌词", "A"], ["M-2", "新品", "B"], ["M-3", "召回", "A"],
]);
const campaignCatalog = createDatasetCatalog([{ profile: marketing, alias: "daily" }, { profile: campaigns, alias: "campaigns" }]);
const campaignRel = profileRelationship(campaignCatalog, {
  leftTableId: campaignCatalog.tables[0].tableId,
  rightTableId: campaignCatalog.tables[1].tableId,
  leftFields: ["campaign_id"],
  rightFields: ["campaign_id"],
});
assert.equal(campaignRel.cardinality, "N:1");
const campaignJoin = executeControlledJoin(campaignCatalog, confirmed(createJoinSpec(campaignCatalog, campaignRel), "一行仍代表一条活动日报"));
assert.equal(campaignJoin.outputRows, 4);
assert.equal(campaignJoin.records[0]["campaigns.campaign_name"], "品牌词");

const products = profile("products.csv", [
  ["sku_id", "category"], ["SKU-1", "A"], ["SKU-2", "B"], ["SKU-3", "A"],
]);
const inventoryCatalog = createDatasetCatalog([{ profile: inventory, alias: "inventory" }, { profile: products, alias: "products" }]);
const inventoryRel = profileRelationship(inventoryCatalog, {
  leftTableId: inventoryCatalog.tables[0].tableId,
  rightTableId: inventoryCatalog.tables[1].tableId,
  leftFields: ["sku_id"],
  rightFields: ["sku_id"],
});
assert.equal(inventoryRel.cardinality, "1:1");
const inventoryJoin = executeControlledJoin(inventoryCatalog, confirmed(createJoinSpec(inventoryCatalog, inventoryRel), "一行代表一个仓库 SKU 快照"));
assert.equal(inventoryJoin.outputRows, 3);
assert(inventoryJoin.checks.every((check) => check.passed));

const allText = JSON.stringify({ orderPlan, marketingPlan, inventoryPlan });
assert(!allText.includes("Olist"), "通用数据流程不得回退为 Olist 固定答案");
assert(orders.qualityIssues.some((issue) => issue.check === "有效性"));
assert(orders.qualityIssues.some((issue) => issue.check === "完整性"));
assert(marketingResult.checks.every((check) => check.passed));
assert(inventoryResult.checks.every((check) => check.passed));

console.log(JSON.stringify({
  checks: 34,
  scenarios: {
    orders: { plan: orderPlan.plan.analysisType, rows: orderResult.rows, qualityIssues: orders.qualityIssues.length },
    marketing: { plan: marketingPlan.plan.analysisType, rows: marketingResult.rows, ratioGate: ratioPlan.plan.nextView },
    inventory: { plan: inventoryPlan.plan.analysisType, rows: inventoryResult.rows },
  },
  safety: { ambiguous: ambiguous.plan.action, unsupported: unsupported.plan.action, noOlistFallback: true },
  joins: { campaign: campaignRel.cardinality, inventory: inventoryRel.cardinality },
}, null, 2));
