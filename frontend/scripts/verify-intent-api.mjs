import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";

const baseUrl = process.env.METRICGROUND_BASE_URL ?? "http://localhost:5173";
let cookie = "";
async function request(path, payload) {
  const url = new URL(path, baseUrl);
  const raw = payload == null ? null : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const headers = { accept: "application/json", ...(cookie ? { Cookie: cookie } : {}) };
    if (raw) Object.assign(headers, { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(raw)) });
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(url, { method: raw ? "POST" : "GET", headers, signal: AbortSignal.timeout(15000) }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try { resolve({ status: res.statusCode, body: JSON.parse(text), headers: res.headers }); }
        catch { reject(new Error(`Invalid API JSON: HTTP ${res.statusCode}, ${text.slice(0, 120)}`)); }
      });
    });
    req.on("error", reject);
    req.end(raw);
  });
}

const session = await request("/api/session");
assert.equal(session.status, 200);
cookie = session.headers["set-cookie"]?.[0]?.split(";")[0] ?? "";
const dataset = {
  fileName: "intent-api-probe.csv", rowCount: 3, columnCount: 3, grainSuggestion: "业务含义需人工确认",
  fields: [
    { name: "order_id", type: "文本", missingRate: 0, uniqueCount: 3, candidateKey: true },
    { name: "amount", type: "数值", missingRate: 0, uniqueCount: 3, candidateKey: false },
    { name: "region", type: "文本", missingRate: 0, uniqueCount: 2, candidateKey: false },
  ],
  qualityIssues: [],
  availableTools: ["profile_dataset", "run_quality_checks", "request_metric_contract", "execute_metric", "execute_top_n", "validate_result"],
};

async function plan(question, context = dataset) {
  const response = await request("/api/agent/plan", { question, dataset: context });
  assert.equal(response.status, 200, question);
  assert.equal(response.body.source, "policy-router", "本组回归明确验证确定性策略，不冒充模型语义能力");
  return response.body.plan;
}

const paraphrase = await plan("帮我算一下有多少笔不同的订单");
assert.equal(paraphrase.analysisType, "metric");
assert.equal(paraphrase.action, "ready");
assert.equal(paraphrase.fieldBindings.entityField, "order_id");
assert.equal(paraphrase.fieldBindings.valueField, null);
assert.equal(paraphrase.nextView, "指标口径");
const once = await plan("相同订单编号只算一次，一共有多少个订单？");
assert.equal(once.analysisType, "metric");
assert.equal(once.nextView, "指标口径");
assert.ok(once.tools.includes("request_metric_contract"));
const maximum = await plan("哪个地区的订单金额最多？");
assert.equal(maximum.analysisType, "top_n");
assert.equal(maximum.action, "clarify");
assert.equal(maximum.fieldBindings.groupField, "region");
assert.equal(maximum.fieldBindings.valueField, "amount");
assert.equal(maximum.nextView, "经营分析");
assert.match(maximum.clarification, /退款/);
const forecast = await plan("预测下个月的销售额");
assert.equal(forecast.analysisType, "unsupported");
assert.equal(forecast.action, "unsupported");
assert.equal(forecast.nextView, null);
assert.deepEqual(forecast.tools, ["profile_dataset"]);
const missingCustomer = await plan("统计客户数");
assert.equal(missingCustomer.action, "clarify");
assert.equal(missingCustomer.fieldBindings.entityField, null, "缺少客户字段时不能用订单字段代替");
const withoutRegion = { ...dataset, columnCount: 2, fields: dataset.fields.filter((field) => field.name !== "region") };
const missingGroup = await plan("哪个地区的订单金额最多？", withoutRegion);
assert.equal(missingGroup.analysisType, "top_n");
assert.equal(missingGroup.action, "clarify");
assert.equal(missingGroup.fieldBindings.groupField, null);
assert.match(missingGroup.clarification, /分组字段/);
const joinRisk = await plan("关联后订单金额多了一倍，怎么办？");
assert.equal(joinRisk.analysisType, "quality");
assert.equal(joinRisk.action, "clarify");
assert.equal(joinRisk.nextView, "多表关联");
assert.match(joinRisk.clarification, /画像不足以确认根因/);
assert.ok(!joinRisk.tools.includes("execute_metric"));
const average = await plan("计算每个订单的平均金额，订单数要去重");
assert.equal(average.analysisType, "metric");
assert.equal(average.fieldBindings.valueField, "amount", "平均金额不能被当成只需要编号的去重计数");
const absentIdentifier = await plan("统计 missing_id 的去重数量");
assert.equal(absentIdentifier.action, "clarify");
assert.equal(absentIdentifier.fieldBindings.entityField, null);
const rowDifference = await plan("为什么表的行数比订单数多？", {
  ...dataset, fields: dataset.fields.map((field) => field.name === "order_id" ? { ...field, uniqueCount: 2 } : field),
});
assert.equal(rowDifference.analysisType, "quality");
assert.match(rowDifference.summary, /3 行/);
assert.match(rowDifference.summary, /2 个/);
assert.match(rowDifference.clarification, /订单明细/);
assert.ok(!rowDifference.tools.includes("execute_metric"));
const noDifference = await plan("为什么表的行数比订单数多？");
assert.match(noDifference.summary, /未发现/);

console.log(JSON.stringify({ passed: true, cases: 11, source: "policy-router", scope: "实际 API 路由与字段绑定回归，不代表模型准确率" }, null, 2));
