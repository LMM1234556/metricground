// Explicit, local-only real-model trial. Credential content never leaves this process except the approved provider request.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { parseCsv } from "../app/lib/tabular-profile.ts";
import { createIntentPlanningAgent } from "../app/lib/intent-planning-agent.ts";
import { MODEL_BUDGET_SCHEMA, MODEL_RESERVE_SQL, MODEL_TRIAL_LIMITS, createBudgetedModelFetch } from "../app/lib/model-cost-policy.ts";

const path = process.argv[2];
if (!path) throw new Error("Provide the explicitly authorized local credential CSV path; never provide a key as an argument");
const pairs = parseCsv(await readFile(path, "utf8"));
const values = new Map(pairs.map((row) => [String(row[0]), String(row[1] ?? "").trim()]));
const apiKey = values.get("apiKey");
const baseURL = values.get("openAiCompatible");
if (!apiKey || !baseURL) throw new Error("Credential CSV missing required fields; values suppressed");
const provider = { id: "dashscope", kind: "cloud", label: "百炼", model: "qwen-plus", baseURL, apiKey, sendsRawRows: false };
const ledgerPath = resolve("../runtime/cloud-trial-ledger.sqlite");
await mkdir(dirname(ledgerPath), { recursive: true });
const db = new DatabaseSync(ledgerPath);
for (const sql of MODEL_BUDGET_SCHEMA) db.exec(sql);
const context = { fileName: "cloud-trial-synthetic.csv", rowCount: 3, columnCount: 3, grainSuggestion: "业务含义需人工确认",
  fields: [
    { name: "order_id", type: "文本", uniqueCount: 3, missingRate: 0, candidateKey: true },
    { name: "amount", type: "数值", uniqueCount: 3, missingRate: 0, candidateKey: false },
    { name: "region", type: "文本", uniqueCount: 2, missingRate: 0, candidateKey: false },
  ], qualityIssues: [], availableTools: ["profile_dataset", "run_quality_checks", "request_metric_contract", "execute_metric", "execute_group_compare", "validate_result"] };
const cases = [
  { question: "每个地方带来的钱分别是多少", expected: "group_compare", group: "region" },
  { question: "给我看一下这份表能干什么", expected: "profile" },
  { question: "我想看看客户都来了几位，相同客户只算一位", expected: "metric", missingCustomer: true },
];
const results = [];
let outgoing = 0;
for (const item of cases) {
  let decision = null;
  const requestId = randomUUID();
  const reserve = async () => {
    if (outgoing >= 6) throw new Error("LOCAL_TRIAL_SIX_REQUEST_LIMIT");
    const now = new Date().toISOString();
    if (!db.prepare(MODEL_RESERVE_SQL).get(now, MODEL_TRIAL_LIMITS.totalRequests)) throw new Error("MODEL_GLOBAL_LIMIT");
    outgoing++;
    const id = randomUUID();
    db.prepare("INSERT INTO cloud_model_calls (id,request_id,provider,model,status,created_at) VALUES (?,?,?,?,'reserved',?)")
      .run(id, requestId, provider.id, provider.model, now);
    return id;
  };
  const record = async (receipt) => {
    db.prepare("UPDATE cloud_model_calls SET status=?,input_tokens=?,output_tokens=?,duration_ms=? WHERE id=?")
      .run(receipt.status, receipt.inputTokens, receipt.outputTokens, receipt.durationMs, receipt.id);
  };
  const boundedFetch = createBudgetedModelFetch({ provider, reserve, record });
  const compatible = createOpenAICompatible({ name: "dashscope", baseURL, apiKey, fetch: boundedFetch });
  const agent = createIntentPlanningAgent(compatible.chatModel("qwen-plus"), context, (input) => { decision = input; return { accepted: true }; });
  const started = Date.now();
  try {
    const result = await agent.generate({ prompt: item.question, abortSignal: AbortSignal.timeout(45_000) });
    const correct = Boolean(decision && decision.analysisType === item.expected
      && (!item.group || decision.groupField === item.group)
      && (!item.missingCustomer || decision.entityField === ""));
    results.push({ question: item.question, expected: item.expected, decision, correct, source: "real-cloud-model-tool-layer",
      latencyMs: Date.now() - started, steps: result.steps.length,
      inputTokens: result.totalUsage.inputTokens ?? null, outputTokens: result.totalUsage.outputTokens ?? null });
  } catch {
    results.push({ question: item.question, expected: item.expected, correct: false, error: "MODEL_TRIAL_FAILED", latencyMs: Date.now() - started });
    break; // Never keep consuming quota after authentication/network/model failure.
  }
}
const record = { checkedAt: new Date().toISOString(), model: "qwen-plus", provider: "dashscope", requests: outgoing,
  expectedCases: cases.length, completedCases: results.length, passed: results.length === cases.length && results.every((row) => row.correct),
  scope: "Three self-built real-model tool-layer probes; not public API/browser evaluation or general accuracy", results };
await writeFile(resolve("../runtime/cloud-model-trial-result.json"), JSON.stringify(record, null, 2) + "\n");
db.close();
values.clear();
console.log(JSON.stringify(record, null, 2));
if (!record.passed) process.exitCode = 1;
