import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import readXlsxFile from "read-excel-file/node";
import { profileRows } from "../app/lib/tabular-profile.ts";
import { createBusinessAnalysisConfig, executeBusinessAnalysis } from "../app/lib/business-analysis.ts";
import { buildBusinessRatioSql } from "../app/lib/business-ratio-sql.ts";

const require = createRequire(import.meta.url);
const duckdb = require(path.resolve("node_modules/@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs"));
const db = await duckdb.createDuckDB({ mvp: { mainModule: path.resolve("node_modules/@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm"), mainWorker: "" } }, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
await db.instantiate(() => {});
const conn = db.connect();
const question = "比较不同地区的送货成功率";
const metadata = { fileName: "ratio-sql.csv", fileSize: 100, fileType: "CSV", activeSheet: "CSV 数据", sheetNames: ["CSV 数据"] };
let caseCount = 0;
function verify(profile, config) {
  caseCount++;
  const expected = executeBusinessAnalysis(profile, config, question);
  const records = profile.records.map(record => Object.fromEntries(profile.columns.map(column => {
    const value = record[column.name];
    return [column.name, value === null || value === undefined || (typeof value === "string" && ["", "null", "undefined", "__null__"].includes(value.trim().toLowerCase())) ? null : value instanceof Date ? value.toISOString() : String(value).trim()];
  })));
  const file = `ratio-${caseCount}.json`;
  db.registerFileText(file, JSON.stringify(records));
  conn.insertJSONFromPath(file, { name: "ratio_input" });
  const sql = buildBusinessRatioSql(config);
  const run = text => {
    const stmt = conn.prepare(text.replaceAll('"__TABLE__"', '"ratio_input"'));
    try { return stmt.query(...sql.parameters).toArray().map(row => row.toJSON()); } finally { stmt.close(); }
  };
  try {
    assert.equal(run(sql.conflicts).length, 0);
    const rows = run(sql.rows);
    assert.deepEqual(rows.map(row => [row.analysis_key, Number(row.metric_value), Number(row.numerator), Number(row.denominator), Number(row.source_rows)]),
      expected.rows.map(row => [row.key, row.value, row.numerator, row.denominator, row.sourceRows]));
    const summary = run(sql.summary)[0];
    assert.equal(Number(summary.source_rows), expected.sourceRows);
    assert.equal(Number(summary.eligible_rows), expected.eligibleRows);
    assert.equal(Number(summary.excluded_grouping_rows), expected.excludedGroupingRows);
    assert.equal(Number(summary.excluded_scope_rows), expected.excludedScopeRows);
    assert.equal(Number(summary.excluded_missing_entities), expected.excludedMissingEntities);
    assert.equal(Number(summary.full_group_count), expected.fullGroupCount);
    assert.deepEqual(run(sql.zero).map(row => row.analysis_key).sort(), [...expected.zeroDenominatorGroups].sort());
    return rows.map(row => ({ key: row.analysis_key, value: Number(row.metric_value), numerator: Number(row.numerator), denominator: Number(row.denominator) }));
  } finally { conn.query('DROP TABLE "ratio_input"'); db.dropFile(file); }
}
const profile = profileRows([["order_id", "region", "status"],
  ["A", "East", " delivered "], ["A", "East", "delivered"], ["B", "East", "cancelled"],
  ["C", "South", "DELIVERED"], ["D", "South", "shipped"], [null, "Empty", "delivered"],
  ["E", null, "delivered"], ["F", "North", null], ["G", "North", "__null__"]], metadata);
const config = { ...createBusinessAnalysisConfig(profile, null, question), groupField: "region", entityField: "order_id", ratioNumerator: { enabled: true, field: "status", operator: "equals", value: "delivered" } };
verify(profile, config);
verify(profile, { ...config, sortDirection: "asc" });
verify(profile, { ...config, ratioDenominator: { enabled: true, field: "status", operator: "not_equals", value: "cancelled" } });
verify(profile, { ...config, ratioNumerator: { ...config.ratioNumerator, value: "' OR 1=1 --" } });
verify(profile, { ...config, ratioNumerator: { ...config.ratioNumerator, operator: "not_empty", value: "" } });
const fixturePath = fileURLToPath(new URL("../../evaluation/novice_test_files/novice_test_p04.xlsx", import.meta.url));
const [sheet] = await readXlsxFile(fixturePath, { sheet: "orders" });
const original = profileRows(sheet.data, { ...metadata, fileName: "novice_test_p04.xlsx" });
const participant = verify(original, { ...config, ratioNumerator: { ...config.ratioNumerator, value: "已送达" } });
conn.close();
db.reset();
console.log(JSON.stringify({ passed: true, engine: "DuckDB-WASM 1.32.0 Node blocking runtime", independentSqlCases: caseCount, participantP04: participant, cloudCalls: 0 }, null, 2));
