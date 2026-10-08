import assert from "node:assert/strict";
import { createDatasetCatalog, discoverRelationshipCandidates, profileRelationship, profileTableKey } from "../app/lib/dataset-catalog.ts";
import { profileRows } from "../app/lib/tabular-profile.ts";

function profile(fileName, rows) {
  return profileRows(rows, { fileName, fileSize: JSON.stringify(rows).length, fileType: "CSV", sheetNames: ["CSV 数据"], activeSheet: "CSV 数据" });
}

const orders = profile("orders.csv", [
  ["order_id", "customer_id", "amount"],
  ["O-1", "C-1", 100],
  ["O-2", "C-1", 80],
  ["O-3", "C-2", 120],
  ["O-4", "C-X", 50],
]);
const items = profile("items.csv", [
  ["order_id", "item_id", "category"],
  ["O-1", "I-1", "A"],
  ["O-1", "I-2", "B"],
  ["O-2", "I-3", "A"],
  ["O-3", "I-4", "C"],
  ["O-X", "I-5", "D"],
]);
const customers = profile("customers.csv", [
  ["customer_id", "region"],
  ["C-1", "华东"],
  ["C-2", "华南"],
  ["C-3", "华北"],
]);

const catalog = createDatasetCatalog([
  { profile: orders, alias: "orders" },
  { profile: items, alias: "items" },
  { profile: customers, alias: "customers" },
]);
assert.equal(catalog.tables.length, 3);
assert.deepEqual(catalog.tables.map((table) => table.alias), ["orders", "items", "customers"]);
assert.throws(() => createDatasetCatalog([...catalog.tables.map((table) => ({ profile: table.profile })), { profile: orders }]), /1 至 3/);

const [orderTable, itemTable, customerTable] = catalog.tables;
const orderKey = profileTableKey(catalog, orderTable.tableId, ["order_id"]);
assert.equal(orderKey.unique, true);
const itemOrderKey = profileTableKey(catalog, itemTable.tableId, ["order_id"]);
assert.equal(itemOrderKey.unique, false);
assert.equal(itemOrderKey.duplicatedKeyCount, 1);

const orderItems = profileRelationship(catalog, {
  leftTableId: orderTable.tableId, rightTableId: itemTable.tableId, leftFields: ["order_id"], rightFields: ["order_id"],
});
assert.equal(orderItems.cardinality, "1:N");
assert.equal(orderItems.leftOrphanRows, 1);
assert.equal(orderItems.rightOrphanRows, 1);
assert.equal(orderItems.estimatedLeftJoinRows, 5);
assert.equal(orderItems.estimatedLeftJoinExpansion, 1.25);
assert.equal(orderItems.duplicatedLeftMeasureRisk, true);

const orderCustomers = profileRelationship(catalog, {
  leftTableId: orderTable.tableId, rightTableId: customerTable.tableId, leftFields: ["customer_id"], rightFields: ["customer_id"],
});
assert.equal(orderCustomers.cardinality, "N:1");
assert.equal(orderCustomers.leftOrphanRows, 1);
assert.equal(orderCustomers.rightOrphanRows, 1);
assert.equal(orderCustomers.duplicatedLeftMeasureRisk, false);

const manyLeft = profile("many-left.csv", [["key", "value"], ["A", 1], ["A", 2]]);
const manyRight = profile("many-right.csv", [["key", "label"], ["A", "x"], ["A", "y"]]);
const manyCatalog = createDatasetCatalog([{ profile: manyLeft, alias: "left" }, { profile: manyRight, alias: "right" }]);
const many = profileRelationship(manyCatalog, {
  leftTableId: manyCatalog.tables[0].tableId, rightTableId: manyCatalog.tables[1].tableId, leftFields: ["key"], rightFields: ["key"],
});
assert.equal(many.cardinality, "N:N");
assert.equal(many.blockedByDefault, true);
assert.equal(many.estimatedLeftJoinRows, 4);

const compositeLeft = profile("composite-left.csv", [["order_id", "seq", "amount"], ["O-1", 1, 10], ["O-1", 2, 20]]);
const compositeRight = profile("composite-right.csv", [["order_id", "seq", "status"], ["O-1", 1, "ok"], ["O-1", 2, "ok"]]);
const compositeCatalog = createDatasetCatalog([{ profile: compositeLeft }, { profile: compositeRight }]);
const composite = profileRelationship(compositeCatalog, {
  leftTableId: compositeCatalog.tables[0].tableId,
  rightTableId: compositeCatalog.tables[1].tableId,
  leftFields: ["order_id", "seq"], rightFields: ["order_id", "seq"],
});
assert.equal(composite.cardinality, "1:1");
assert.equal(composite.leftRowCoverage, 1);
assert.throws(() => profileTableKey(compositeCatalog, compositeCatalog.tables[0].tableId, ["order_id", "seq", "amount"]), /1 个字段或 2 个字段/);

const discovered = discoverRelationshipCandidates(catalog);
assert(discovered.some((candidate) => candidate.cardinality === "1:N" && candidate.leftFields[0] === "order_id"));
assert(discovered.some((candidate) => candidate.cardinality === "N:1" && candidate.leftFields[0] === "customer_id"));

console.log(JSON.stringify({
  checks: 24,
  tables: catalog.tables.map((table) => table.alias),
  orderItems: { cardinality: orderItems.cardinality, expansion: orderItems.estimatedLeftJoinExpansion, leftOrphans: orderItems.leftOrphanRows, rightOrphans: orderItems.rightOrphanRows },
  orderCustomers: { cardinality: orderCustomers.cardinality, leftCoverage: orderCustomers.leftRowCoverage },
  manyToManyBlocked: many.blockedByDefault,
  composite: composite.cardinality,
  discovered: discovered.length,
}, null, 2));
