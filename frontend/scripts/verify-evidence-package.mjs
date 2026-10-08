import assert from "node:assert/strict";
import { buildEvidencePackage, evidenceAsJson, evidenceAsMarkdown, verifyEvidencePackage } from "../app/lib/evidence-package.ts";
import { completeTaskTool, createTaskRunFromPlan, recordEvidenceExport, startTaskTool } from "../app/lib/agent-runtime.ts";
import { approveTaskRun } from "../app/lib/agent-runtime.ts";
import { analysisSpecFromBusinessConfig } from "../app/lib/analysis-spec.ts";
import { profileRows } from "../app/lib/tabular-profile.ts";

const profile = profileRows([["order_id", "amount", "region"], ["O-1", 100, "华东"], ["O-2", 80, "华南"]], {
  fileName: "orders.csv", fileSize: 50, fileType: "CSV", sheetNames: ["CSV 数据"], activeSheet: "CSV 数据",
});
const plan = {
  action: "ready", analysisType: "group_compare", summary: "地区金额", clarification: null,
  tools: ["profile_dataset", "run_quality_checks", "execute_group_compare", "validate_result"],
  steps: ["画像", "质量", "计算", "验证"], fieldBindings: { entityField: "order_id", valueField: "amount", groupField: "region", timeField: null },
  nextView: "经营分析", confidence: 1, limitations: [],
};
let run = createTaskRunFromPlan(profile, "比较地区金额", { plan, source: "policy-router", model: null, stepsExecuted: 0, latencyMs: 1 }, { id: "evidence-task", now: "2026-09-20T00:00:00.000Z" });
const spec = analysisSpecFromBusinessConfig({ analysisType: "group_compare", aggregation: "sum", entityField: "order_id", valueField: "amount", groupField: "region", timeField: "", timeGrain: "month", limit: 5, sortDirection: "desc" }, profile, "比较地区金额");
run = approveTaskRun(run, { type: "metric", statement: "确认一行一订单，金额使用 amount", spec, now: "2026-09-20T00:00:01.000Z" });
const started = startTaskTool(run, "execute_group_compare", { analysisSpecId: spec.id, records: profile.records }, { callId: "evidence-call", now: "2026-09-20T00:00:02.000Z" });
run = completeTaskTool(started.run, { callId: started.callId, outputSummary: "2 个地区", validationSummary: "结果有限且行数勾稽通过", resultSummary: "华东 100，华南 80", now: "2026-09-20T00:00:03.000Z" });
run = recordEvidenceExport(run, "2026-09-20T00:00:04.000Z");
const evidence = buildEvidencePackage(run, "2026-09-20T00:00:05.000Z");
const json = evidenceAsJson(evidence);
const markdown = evidenceAsMarkdown(evidence);

assert.equal(evidence.task.state, "COMPLETED");
assert.equal(evidence.privacy.rawRowsIncluded, false);
assert.equal(verifyEvidencePackage(evidence), true);
assert.equal(evidence.toolCalls.find((call) => call.id === "evidence-call").input.records, "[已移除原始明细数据]");
assert(!json.includes('"O-1"'), "证据包不得包含原始订单行");
assert(json.includes("export_evidence"));
assert(markdown.includes("结果有限且行数勾稽通过"));
assert(markdown.includes("不包含 Excel/CSV 原始数据行"));

const tampered = structuredClone(evidence);
tampered.resultSummary = "被篡改";
assert.equal(verifyEvidencePackage(tampered), false);

console.log(JSON.stringify({ checks: 10, checksum: evidence.integrity.checksum, tools: evidence.toolCalls.map((call) => call.tool), rawRowsIncluded: evidence.privacy.rawRowsIncluded }, null, 2));
