const ALLOWED_INTENTS = new Set([
  "overview",
  "trend",
  "combined",
  "category",
  "delivery",
  "unsupported",
]);

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen3:8b";

type AnalysisIntent =
  | "overview"
  | "trend"
  | "combined"
  | "category"
  | "delivery"
  | "unsupported";

function ruleFallback(question: string): AnalysisIntent {
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

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "请求内容不是有效 JSON。" }, { status: 400 });
  }

  const question = typeof payload === "object" && payload !== null && "question" in payload
    ? String(payload.question).trim()
    : "";

  if (!question || question.length > 500) {
    return Response.json({ error: "问题不能为空，且不能超过 500 个字符。" }, { status: 400 });
  }

  const systemPrompt = `你是 MetricGround 的数据分析意图路由器。你只负责选择工具，不计算指标，也不生成 SQL。
可选 intent：
- overview：总订单、已送达订单、送达率、商品 GMV、平均客单价等核心经营指标；
- trend：月度趋势、月份变化、高点、增长走势；
- combined：同时要求核心指标和月度趋势；
- category：商品品类、类别、类目、Top 品类和品类 GMV 排名；
- delivery：配送延迟、是否准时、评价分数、差评和配送体验；
- unsupported：卖家退款、利润、库存、预测等当前未接入问题。
只输出一个 JSON 对象，例如 {"intent":"category"}。不要输出解释。`;

  try {
    const ollamaResponse = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        think: false,
        format: "json",
        keep_alive: "10m",
        options: { temperature: 0 },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: question },
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    });

    if (!ollamaResponse.ok) {
      throw new Error(`Ollama returned ${ollamaResponse.status}`);
    }

    const result = await ollamaResponse.json() as {
      message?: { content?: string };
      total_duration?: number;
    };
    const parsed = JSON.parse(result.message?.content ?? "{}") as { intent?: string };
    if (!parsed.intent || !ALLOWED_INTENTS.has(parsed.intent)) {
      throw new Error("Model returned an invalid intent");
    }

    return Response.json({
      intent: parsed.intent,
      source: "ollama",
      model: OLLAMA_MODEL,
      latencyMs: result.total_duration ? Math.round(result.total_duration / 1_000_000) : null,
    });
  } catch {
    return Response.json({
      intent: ruleFallback(question),
      source: "rule-fallback",
      model: null,
      latencyMs: null,
    });
  }
}
