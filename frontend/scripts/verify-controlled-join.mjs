import assert from "node:assert/strict";
import { createJoinSpec, executeControlledJoin, executeJoinPipeline, previewJoin, validateJoinSpec } from "../app/lib/controlled-join.ts";
import { createDatasetCatalog, profileRelationship } from "../app/lib/dataset-catalog.ts";
import { profileRows } from "../app/lib/tabular-profile.ts";

function profile(fileName, rows) {
  return profileRows(rows, { fileName, fileSize: JSON.stringify(rows).length, fileType: "CSV", sheetNames: ["CSV 数据"], activeSheet: "CSV 数据" });
}
function confirmed(spec, grain) {
  return { ...spec, intendedGrainDescription: grain, keyMeaningConfirmed: true, relationshipConfirmed: true, grainConfirmed: true, orphanRiskAcknowledged: true, expansionRiskAcknowledged: true, status: "confirmed" };
}

const orders = profile("orders.csv", [["order_id", "customer_id", "amount"], ["O-1", "C-1", 100], ["O-2", "C-1", 80], ["O-3", "C-2", 120], ["O-4", "C-X", 50]]);
const items = profile("items.csv", [["order_id", "item_id", "category"], ["O-1", "I-1", "A"], ["O-1", "I-2", "B"], ["O-2", "I-3", "A"], ["O-3", "I-4", "C"], ["O-X", "I-5", "D"]]);
const customers = profile("customers.csv", [["customer_id", "region"], ["C-1", "华东"], ["C-2", "华南"], ["C-3", "华北"]]);
const catalog = createDatasetCatalog([{ profile: orders, alias: "orders" }, { profile: items, alias: "items" }, { profile: customers, alias: "customers" }]);
const [orderTable, itemTable, customerTable] = catalog.tables;

const customerRel = profileRelationship(catalog, { leftTableId: orderTable.tableId, rightTableId: customerTable.tableId, leftFields: ["customer_id"], rightFields: ["customer_id"] });
let customerSpec = createJoinSpec(catalog, customerRel);
assert.equal(validateJoinSpec(catalog, customerSpec).valid, false, "未确认的关联不能执行");
customerSpec = confirmed(customerSpec, "一行仍代表一笔订单");
const customerValidation = validateJoinSpec(catalog, customerSpec);
assert.equal(customerValidation.valid, true);
const customerPreview = previewJoin(catalog, customerSpec);
assert.equal(customerPreview.estimatedOutputRows, 4);
const orderCustomerJoin = executeControlledJoin(catalog, customerSpec);
assert.equal(orderCustomerJoin.outputRows, 4);
assert.equal(orderCustomerJoin.unmatchedLeftRows, 1);
assert.equal(orderCustomerJoin.records.find((record) => record["orders.order_id"] === "O-1")["customers.region"], "华东");
assert(orderCustomerJoin.checks.every((check) => check.passed));
const safeOrderAmount = orderCustomerJoin.amountReconciliations.find((item) => item.qualifiedField === "orders.amount");
assert.equal(safeOrderAmount.status, "balanced");
assert.equal(safeOrderAmount.sourceTotal, 350);
assert.equal(safeOrderAmount.outputTotal, 350);

const itemRel = profileRelationship(catalog, { leftTableId: orderTable.tableId, rightTableId: itemTable.tableId, leftFields: ["order_id"], rightFields: ["order_id"] });
let unsafeItemSpec = createJoinSpec(catalog, itemRel, { joinType: "left", intendedGrainTableId: orderTable.tableId });
unsafeItemSpec = confirmed(unsafeItemSpec, "一行代表一笔订单");
const unsafeValidation = validateJoinSpec(catalog, unsafeItemSpec);
assert.equal(unsafeValidation.valid, false);
assert(unsafeValidation.errors.some((error) => error.includes("输出粒度")));

let itemSpec = createJoinSpec(catalog, itemRel, { joinType: "inner", intendedGrainTableId: itemTable.tableId });
itemSpec = confirmed(itemSpec, "一行代表一条已匹配订单商品明细");
const itemValidation = validateJoinSpec(catalog, itemSpec);
assert.equal(itemValidation.valid, true);
const orderItemJoin = executeControlledJoin(catalog, itemSpec);
assert.equal(orderItemJoin.outputRows, 4);
assert.equal(orderItemJoin.expansion, 1);
assert.equal(orderItemJoin.records.filter((record) => record["orders.order_id"] === "O-1").length, 2);
const riskyOrderAmount = orderItemJoin.amountReconciliations.find((item) => item.qualifiedField === "orders.amount");
assert.equal(riskyOrderAmount.status, "mixed");
assert.equal(riskyOrderAmount.sourceTotal, 350);
assert.equal(riskyOrderAmount.outputTotal, 400);
assert.equal(riskyOrderAmount.netDelta, 50);
assert.equal(riskyOrderAmount.duplicatedSourceRows, 1);
assert.equal(riskyOrderAmount.excludedSourceRows, 1);
assert(orderItemJoin.checks.some((check) => check.label === "金额对账：orders.amount" && !check.passed));
assert(orderItemJoin.warnings.some((warning) => warning.includes("orders.amount") && warning.includes("阻止")));

const manyLeft = profile("many-left.csv", [["key"], ["A"], ["A"]]);
const manyRight = profile("many-right.csv", [["key"], ["A"], ["A"]]);
const manyCatalog = createDatasetCatalog([{ profile: manyLeft }, { profile: manyRight }]);
const manyRel = profileRelationship(manyCatalog, { leftTableId: manyCatalog.tables[0].tableId, rightTableId: manyCatalog.tables[1].tableId, leftFields: ["key"], rightFields: ["key"] });
const manySpec = confirmed(createJoinSpec(manyCatalog, manyRel), "多对多结果");
assert.equal(validateJoinSpec(manyCatalog, manySpec).valid, false);
assert.throws(() => executeControlledJoin(manyCatalog, manySpec), /多对多关联已被默认禁止/);

const pipeline = executeJoinPipeline(catalog, [customerSpec]);
assert.equal(pipeline.records.length, 4);
assert.deepEqual(pipeline.tableIds.sort(), [orderTable.tableId, customerTable.tableId].sort());

const itemCustomers = createDatasetCatalog([{ profile: items, alias: "items" }, { profile: orders, alias: "orders" }, { profile: customers, alias: "customers" }]);
const [pipelineItems, pipelineOrders, pipelineCustomers] = itemCustomers.tables;
const itemsToOrdersRel = profileRelationship(itemCustomers, { leftTableId: pipelineItems.tableId, rightTableId: pipelineOrders.tableId, leftFields: ["order_id"], rightFields: ["order_id"] });
const ordersToCustomersRel = profileRelationship(itemCustomers, { leftTableId: pipelineOrders.tableId, rightTableId: pipelineCustomers.tableId, leftFields: ["customer_id"], rightFields: ["customer_id"] });
const itemsToOrders = confirmed(createJoinSpec(itemCustomers, itemsToOrdersRel, { intendedGrainTableId: pipelineItems.tableId }), "一行代表一条商品明细");
const ordersToCustomers = confirmed(createJoinSpec(itemCustomers, ordersToCustomersRel, { intendedGrainTableId: pipelineOrders.tableId }), "订单信息附加客户维度，不改变当前商品明细行");
const threeTable = executeJoinPipeline(itemCustomers, [itemsToOrders, ordersToCustomers]);
assert.equal(threeTable.tableIds.length, 3);
assert.equal(threeTable.records.length, 5);
assert.equal(threeTable.records.find((record) => record["items.item_id"] === "I-1")["customers.region"], "华东");
assert.equal(threeTable.records.find((record) => record["items.item_id"] === "I-5")["orders.order_id"], null);
const pipelineOrderAmount = threeTable.amountReconciliations.find((item) => item.qualifiedField === "orders.amount");
assert.equal(pipelineOrderAmount.status, "mixed");
assert.equal(pipelineOrderAmount.outputTotal, 400);

console.log(JSON.stringify({
  checks: 40,
  safeN1: { outputRows: orderCustomerJoin.outputRows, unmatchedLeftRows: orderCustomerJoin.unmatchedLeftRows, amountStatus: safeOrderAmount.status },
  unsafe1NBlocked: !unsafeValidation.valid,
  safe1NInner: { outputRows: orderItemJoin.outputRows, cardinality: orderItemJoin.cardinality, amountStatus: riskyOrderAmount.status, amountDelta: riskyOrderAmount.netDelta },
  manyToManyBlocked: !validateJoinSpec(manyCatalog, manySpec).valid,
  threeTablePipeline: { rows: threeTable.records.length, tables: threeTable.tableIds.length, steps: threeTable.steps.length },
}, null, 2));
