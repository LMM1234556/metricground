import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);
const cases = JSON.parse(await readFile(new URL("evaluation/intent_cases.json", root), "utf8"));

function ruleBaseline(question) {
  if (/延迟|晚到|配送|送达时间|差评|评价|评论/i.test(question)) return "delivery";
  if (/品类|类别|类目|商品类|排名|前五|top\s*5/i.test(question)) return "category";
  const asksForTrend = /月度|趋势|变化|增长|高点|月份/i.test(question);
  const asksForOverview = /核心|经营指标|总订单|订单量|送达率|客单价/i.test(question)
    || (!asksForTrend && /GMV/i.test(question));
  if (asksForTrend && asksForOverview) return "combined";
  if (asksForTrend) return "trend";
  if (asksForOverview) return "overview";
  return "unsupported";
}

async function routeWithModel(question) {
  const startedAt = performance.now();
  const response = await fetch("http://localhost:5173/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`API returned ${response.status}`);
  const result = await response.json();
  return { ...result, observedLatencyMs: Math.round(performance.now() - startedAt) };
}

const results = [];
for (const testCase of cases) {
  const model = await routeWithModel(testCase.question);
  const ruleIntent = ruleBaseline(testCase.question);
  results.push({
    ...testCase,
    ruleIntent,
    ruleCorrect: ruleIntent === testCase.intent,
    modelIntent: model.intent,
    modelCorrect: model.intent === testCase.intent,
    source: model.source,
    latencyMs: model.latencyMs ?? model.observedLatencyMs,
  });
}

function rate(correct, total) {
  return Number((correct / total * 100).toFixed(1));
}

const ruleCorrect = results.filter((item) => item.ruleCorrect).length;
const modelCorrect = results.filter((item) => item.modelCorrect).length;
const unsupported = results.filter((item) => item.intent === "unsupported");
const latencies = results.map((item) => item.latencyMs).sort((a, b) => a - b);
const metrics = {
  total: results.length,
  ruleAccuracy: rate(ruleCorrect, results.length),
  modelAccuracy: rate(modelCorrect, results.length),
  accuracyLiftPercentagePoints: Number((rate(modelCorrect, results.length) - rate(ruleCorrect, results.length)).toFixed(1)),
  unsupportedRecall: rate(unsupported.filter((item) => item.modelIntent === "unsupported").length, unsupported.length),
  averageLatencyMs: Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length),
  p95LatencyMs: latencies[Math.ceil(latencies.length * 0.95) - 1],
  allResponsesFromOllama: results.every((item) => item.source === "ollama"),
};

const timestamp = new Date().toISOString();
await writeFile(
  new URL("evaluation/results-latest.json", root),
  JSON.stringify({ timestamp, metrics, results }, null, 2) + "\n",
);

const failures = results.filter((item) => !item.modelCorrect);
const report = `# 意图路由固定题集测评\n\n` +
  `- 测评时间：${timestamp}\n` +
  `- 题目数量：${metrics.total}（6 类意图，每类 5 题）\n` +
  `- 关键词规则准确率：${metrics.ruleAccuracy}%\n` +
  `- 本地 Qwen3:8b 准确率：${metrics.modelAccuracy}%\n` +
  `- 准确率提升：${metrics.accuracyLiftPercentagePoints} 个百分点\n` +
  `- 暂不支持问题召回率：${metrics.unsupportedRecall}%\n` +
  `- 平均响应时间：${metrics.averageLatencyMs} ms；P95：${metrics.p95LatencyMs} ms\n` +
  `- 模型响应来源：${metrics.allResponsesFromOllama ? "全部来自 Ollama" : "包含规则兜底"}\n\n` +
  `## 错误案例\n\n` +
  (failures.length
    ? failures.map((item) => `- ${item.id}：期望 \`${item.intent}\`，实际 \`${item.modelIntent}\`；${item.question}`).join("\n")
    : "固定题集内无错误。") + "\n\n" +
  `> 说明：这是项目自建的小规模功能回归题集，不代表模型在所有开放问题上的泛化准确率。\n`;

await writeFile(new URL("evaluation/report-latest.md", root), report);
console.log(JSON.stringify({ metrics, failures }, null, 2));

if (!metrics.allResponsesFromOllama || metrics.modelAccuracy < 90 || metrics.unsupportedRecall < 80) {
  process.exitCode = 1;
}
