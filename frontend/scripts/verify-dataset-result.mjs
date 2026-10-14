import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

mkdirSync(".sites-runtime", { recursive: true });
const output = path.resolve(".sites-runtime/dataset-result-check.mjs");
await build({ entryPoints: ["app/components/dataset-result.tsx"], outfile: output, bundle: true, packages: "external", format: "esm", platform: "node", jsx: "automatic" });
const { default: DatasetResult, downloadDatasetCsv } = await import(pathToFileURL(output).href);
const columns = ["order_id", "amount", "category", "note", "=header"].map(name => ({ name }));
const records = Array.from({ length: 30 }, (_, index) => ({
  order_id: `O-${index + 1}`, amount: index === 0 ? -10 : index,
  category: index === 0 ? "A、B" : index === 3 ? null : "品类",
  note: index === 0 ? '逗号,引号"和\n换行' : index === 1 ? "=1+1" : index === 2 ? "@SUM(1)" : "普通文本",
  "=header": "值",
}));
const profile = { fileName: "derived.csv", columns, records };
const html = renderToStaticMarkup(React.createElement(DatasetResult, { profile }));
assert.ok(html.includes("A、B"));
assert.ok(html.includes("（空）"));
assert.ok(html.includes("1–25"));
assert.ok(html.includes("第 1 / 2 页"));
assert.equal((html.match(/<th scope="row">/g) ?? []).length, 25);
let downloadedBlob, fileName, appended = false, removed = false;
const originalUrl = URL.createObjectURL;
URL.createObjectURL = blob => { downloadedBlob = blob; return "blob:test"; };
globalThis.window = { setTimeout: callback => callback() };
globalThis.document = {
  body: { appendChild: () => { appended = true; } },
  createElement: () => ({ click() { fileName = this.download; }, remove() { removed = true; } }),
};
try {
  downloadDatasetCsv(profile);
  const csv = await downloadedBlob.text();
  assert.equal(fileName, "derived.csv");
  assert.equal(downloadedBlob.type, "text/csv;charset=utf-8");
  assert.ok(csv.includes("O-30,29,品类"), "CSV must include rows beyond the visible page");
  assert.ok(csv.includes("O-1,-10,A、B"), "Numeric negatives must remain numeric");
  assert.ok(csv.includes("'=1+1") && csv.includes("'@SUM(1)") && csv.includes("'=header"));
  assert.ok(csv.includes('"逗号,引号""和\n换行"'));
  assert.ok(csv.includes("O-4,3,,普通文本"), "Missing category must export as an empty CSV cell");
  assert.equal(profile.records[1].note, "=1+1", "Export must not mutate the dataset");
  assert.equal(profile.columns[4].name, "=header", "Export must not mutate headers");
  assert.ok(appended && removed);
  console.log(JSON.stringify({ passed: true, previewRows: 25, totalExportRows: 30, fullFieldExport: true, unicode: true, csvEscaping: true, emptyValues: true, spreadsheetFormulaProtection: true, dataUnchanged: true }));
} finally { URL.createObjectURL = originalUrl; delete globalThis.window; delete globalThis.document; }
