import assert from "node:assert/strict";
import { MockLanguageModelV3 } from "ai/test";
import { createIntentPlanningAgent } from "../app/lib/intent-planning-agent.ts";
import { compileModelPlan } from "../app/lib/model-plan-provenance.ts";
import { createTaskRunFromPlan, approveTaskRun } from "../app/lib/agent-runtime.ts";
import { profileRows } from "../app/lib/tabular-profile.ts";
import { createDatasetAgentContext } from "../app/lib/agent-plan.ts";
import { analysisSpecFromBusinessConfig } from "../app/lib/analysis-spec.ts";
import { buildEvidencePackage, evidenceAsMarkdown, verifyEvidencePackage } from "../app/lib/evidence-package.ts";

const profile = profileRows([["order_id", "amount", "region"], ["O-1", 100, "华东"], ["O-2", 80, "华南"]], {
  fileName: "synthetic.csv", fileSize: 60, fileType: "CSV", sheetNames: ["CSV 数据"], activeSheet: "CSV 数据",
});
const base = {
  action: "ready", analysisType: "group_compare", summary: "分组候选", clarification: null,
  tools: ["profile_dataset", "run_quality_checks", "execute_group_compare", "validate_result"],
  steps: ["确认口径", "批准后执行"], nextView: "经营分析", confidence: 0.76, limitations: [],
  fieldBindings: { entityField: "order_id", valueField: "amount", groupField: "region", timeField: null },
};
const submitted = { analysisType: "group_compare", entityField: "order_id", groupField: "region" };
const resultFor = (toolName, input) => ({
  content: [{ type: "tool-call", toolCallId: toolName, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls", raw: "tool_calls" },
  usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } }, warnings: [],
});
const model = new MockLanguageModelV3({ doGenerate: [resultFor("inspectDataset", {}), resultFor("submitAnalysisPlan", submitted)] });
let captured;
const agent = createIntentPlanningAgent(model, createDatasetAgentContext(profile), input => {
  captured = compileModelPlan(input,
    decision => ({ ...structuredClone(base), fieldBindings: { ...base.fieldBindings, entityField: decision.entityField } }),
    candidate => ({ ...candidate, action: "clarify", clarification: "请确认金额口径", confidence: 0.75 }),
    candidate => candidate);
  return { accepted: true, action: captured.plan.action };
});
const generated = await agent.generate({ prompt: "哪里表现好？" });
assert.equal(generated.steps.length, 2);
assert.equal(model.doGenerateCalls.length, 2);
assert.equal(captured.modelDecision.valueField, "", "模型未绑定字段必须保持为空，不能倒写程序默认值");
assert.equal(captured.plan.fieldBindings.valueField, "amount");
assert(captured.planAdjustments.some(x => x.stage === "compile" && x.field === "valueField" && x.before === "" && x.after === "amount"));
assert(captured.planAdjustments.some(x => x.stage === "policy" && x.field === "action" && x.before === "ready" && x.after === "clarify"));

let run = createTaskRunFromPlan(profile, "哪里表现好？", {
  ...captured, source: "cloud-agent", provider: "dashscope", model: "synthetic-mock", stepsExecuted: 2, attempts: 1, latencyMs: 0,
});
const spec = analysisSpecFromBusinessConfig({ analysisType: "group_compare", aggregation: "count_distinct", entityField: "order_id", valueField: "", groupField: "region", timeField: "", timeGrain: "month", limit: 5, sortDirection: "desc" }, profile, "哪里表现好？");
run = approveTaskRun(run, { type: "metric", statement: "人工改为去重计数", spec });
captured.modelDecision.valueField = "modified";
captured.planAdjustments[0].after = "modified";
captured.plan.fieldBindings.valueField = "modified";
const evidence = buildEvidencePackage(run);
assert(verifyEvidencePackage(evidence));
assert.equal(evidence.planningEvidence.modelDecision.valueField, "");
assert.equal(evidence.planningEvidence.proposal.fieldBindings.valueField, "amount");
assert.equal(evidence.analysisSpec.aggregation, "count_distinct");
assert(!evidence.planningEvidence.planAdjustments.some(x => x.after === "modified"));
assert(evidenceAsMarkdown(evidence).includes("compile / valueField"));

const invalidDecision = { analysisType: "group_compare", entityField: "order_id", valueField: "nonexistent", groupField: "region", timeField: "" };
const rejected = compileModelPlan(invalidDecision,
  input => ({ ...structuredClone(base), fieldBindings: { ...base.fieldBindings, valueField: input.valueField } }),
  candidate => candidate,
  candidate => ({ ...candidate, action: "clarify", fieldBindings: { entityField: null, valueField: null, groupField: null, timeField: null } }));
assert.equal(rejected.modelDecision.valueField, "nonexistent");
assert.equal(rejected.plan.fieldBindings.valueField, null);
assert(rejected.planAdjustments.some(x => x.stage === "field-validation" && x.field === "valueField" && x.before === "nonexistent" && x.after === null));
const rawType = { ...invalidDecision, analysisType: "metric", valueField: "amount" };
const overridden = compileModelPlan(rawType, () => structuredClone(base), x => x, x => x);
assert(overridden.planAdjustments.some(x => x.field === "analysisType" && x.before === "metric" && x.after === "group_compare"));
console.log(JSON.stringify({ passed: true, mockedSdkSteps: generated.steps.length, scope: "Synthetic SDK tool calls, compilation/policy/field changes, immutable evidence and human override; no network or real model requests" }, null, 2));
