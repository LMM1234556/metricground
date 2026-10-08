import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { hasToolCall, isStepCount, ToolLoopAgent, tool } from "ai";
import { z } from "zod";
import {
  AGENT_TOOLS, AgentPlan, DatasetAgentContext, isDistinctCountQuestion,
  inferStrongAnalysisType, keepRelevantFieldBindings, resolveAgentAnalysisType,
} from "../../../lib/agent-plan";
import { getAgentProviderCandidates } from "../../../lib/model-provider";

const contextSchema = z.object({
  fileName: z.string().min(1).max(240),
  rowCount: z.number().int().positive(),
  columnCount: z.number().int().positive(),
  grainSuggestion: z.string().max(500),
  fields: z.array(z.object({
    name: z.string().min(1).max(160),
    type: z.string().max(30),
    missingRate: z.number().min(0).max(1),
    uniqueCount: z.number().int().min(0),
    candidateKey: z.boolean(),
  })).min(1).max(200),
  qualityIssues: z.array(z.object({
    title: z.string().max(300), severity: z.string().max(10), check: z.string().max(30),
  })).max(200),
  availableTools: z.array(z.enum(AGENT_TOOLS)).max(AGENT_TOOLS.length),
});

const decisionInputSchema = z.object({
  analysisType: z.enum(["profile", "quality", "cleaning", "metric", "group_compare", "trend", "top_n", "unsupported"]),
  entityField: z.string().max(160).optional().default(""),
  valueField: z.string().max(160).optional().default(""),
  groupField: z.string().max(160).optional().default(""),
  timeField: z.string().max(160).optional().default(""),
});

function firstMatchingField(context: DatasetAgentContext, pattern: RegExp) {
  return context.fields.find((field) => pattern.test(field.name))?.name ?? null;
}

function preferredEntityField(question: string, context: DatasetAgentContext) {
  const requestedPattern = /订单|order/i.test(question)
    ? /order|订单/i
    : /客户|用户|会员/i.test(question)
      ? /customer|user|member|客户|用户|会员/i
      : /商品|产品|sku|item/i.test(question)
        ? /sku|item|product|商品|产品/i
        : null;
  if (requestedPattern) {
    const requested = context.fields.find((field) => requestedPattern.test(field.name) && /id|key|code|no|编号|编码|单号/i.test(field.name));
    if (requested) return requested.name;
  }
  return context.fields.find((field) => field.candidateKey)?.name
    ?? firstMatchingField(context, /(?:^|_)(?:order|customer|user|sku|item)_?id|订单|客户|用户|商品.*编号/i);
}

function fallbackPlan(question: string, context: DatasetAgentContext): AgentPlan {
  const entity = preferredEntityField(question, context);
  const value = firstMatchingField(context, /amount|sales|gmv|revenue|spend|price|stock_qty|金额|销售额|收入|价格|库存/i);
  const group = firstMatchingField(context, /region|segment|category|warehouse|channel|地区|区域|品类|客户类型|仓库|渠道/i);
  const time = context.fields.find((field) => field.type === "日期")?.name
    ?? firstMatchingField(context, /date|time|month|日期|时间|月份/i);
  const base = {
    fieldBindings: { entityField: entity, valueField: value, groupField: group, timeField: time },
    confidence: 0.72,
    limitations: ["执行前仍需人工确认字段业务含义，系统不会根据字段名自行补全业务定义。"],
  };
  if (/预测|forecast|机器学习|回归|聚类/i.test(question)) return {
    ...base, action: "unsupported", analysisType: "unsupported", summary: "当前 MVP 不执行预测或机器学习建模。",
    clarification: null, tools: ["profile_dataset"], steps: ["说明能力边界和所需扩展"], nextView: null,
  };
  if (/数据画像|字段结构|字段类型|多少行|多少列|查看字段/i.test(question)) return {
    ...base, action: "ready", analysisType: "profile", summary: `先查看 ${context.fileName} 的字段画像与候选粒度。`,
    clarification: null, tools: ["profile_dataset"], steps: ["读取行列规模与字段类型", "查看缺失率、唯一值和候选粒度"], nextView: "画像",
  };
  const asksCleaning = /清洗|去除重复(?:行|记录|数据)?|删除重复(?:行|记录|数据)?|数据去重|处理缺失|修复日期/i.test(question);
  if (/质量|异常|缺失|重复|能不能用|可用/i.test(question) && !asksCleaning) return {
    ...base, action: "ready", analysisType: "quality", summary: `先检查 ${context.fileName} 的质量风险。`,
    clarification: null, tools: ["profile_dataset", "run_quality_checks"],
    steps: ["读取字段画像与候选粒度", "运行质量规则并展示证据", "由用户决定是否进入清洗方案"], nextView: "质量检查",
  };
  if (asksCleaning) return {
    ...base, action: context.qualityIssues.length ? "clarify" : "ready", analysisType: "cleaning",
    summary: context.qualityIssues.length ? `发现 ${context.qualityIssues.length} 项质量风险，需要选择处理规则。` : "未发现可自动处理的基础质量问题。",
    clarification: context.qualityIssues.length ? "是否进入清洗方案，逐项选择规则并生成不覆盖原文件的派生副本？" : null,
    tools: ["profile_dataset", "run_quality_checks", "preview_cleaning"],
    steps: ["检查质量问题", "预览处理影响", "等待二次确认", "生成派生副本并复检"], nextView: "清洗方案",
  };
  if (/趋势|月度|按月|同比|环比/i.test(question)) return {
    ...base, action: time && (value || entity) ? "ready" : "clarify", analysisType: "trend", summary: "已识别时间趋势需求，准备确认时间粒度和聚合口径。",
    clarification: !time ? "请选择当前数据中的时间字段。" : !value && !entity ? "请选择统计对象或需要汇总的数值字段。" : null,
    tools: ["profile_dataset", "run_quality_checks", "execute_trend", "validate_result"],
    steps: ["识别时间字段和候选指标字段", "确认日/周/月/季度粒度与聚合口径", "批准后执行确定性趋势计算", "验证时间顺序、有限值和行数勾稽"], nextView: "经营分析",
  };
  if (/前\s*(?:\d+|[一二三四五六七八九十])|top\s*\d+|排名|最高|最低/i.test(question)) return {
    ...base, action: group && (value || entity) ? "ready" : "clarify", analysisType: "top_n", summary: "已识别 Top N 排名需求，准备确认分组、指标和排名方向。",
    clarification: !group ? "请选择用于排名的分组字段。" : !value && !entity ? "请选择统计对象或需要汇总的数值字段。" : null,
    tools: ["profile_dataset", "run_quality_checks", "execute_top_n", "validate_result"],
    steps: ["识别分组字段和候选指标字段", "确认聚合口径、排名方向和 N", "批准后执行确定性排名", "验证排序、Top N 边界和行数勾稽"], nextView: "经营分析",
  };
  if (/各地区|各区域|各品类|各渠道|按[^，。！？]{0,10}(?:地区|区域|品类|渠道)|分组|分群/i.test(question)) return {
    ...base, action: group && (value || entity) ? "ready" : "clarify", analysisType: "group_compare", summary: "已识别分组比较需求，准备确认分组字段和聚合口径。",
    clarification: !group ? "请选择用于比较的分组字段。" : !value && !entity ? "请选择统计对象或需要汇总的数值字段。" : null,
    tools: ["profile_dataset", "run_quality_checks", "execute_group_compare", "validate_result"],
    steps: ["识别分组字段和候选指标字段", "确认统计对象、聚合口径和排序方向", "批准后执行确定性分组计算", "验证有限值、排序和行数勾稽"], nextView: "经营分析",
  };
  const ambiguousAmount = /销售|gmv|收入|金额/i.test(question);
  const asksMetric = isDistinctCountQuestion(question) || /总额|合计|平均|均值|比例|率|销售额|金额|gmv|收入|营收/i.test(question);
  if (!asksMetric) return {
    ...base, action: "clarify", analysisType: "profile", summary: "需要先明确本次分析目标。",
    clarification: "你希望先查看数据画像、检查质量、定义指标，还是进行分组或趋势分析？",
    tools: ["profile_dataset"], steps: ["读取当前数据画像", "等待用户选择分析目标"], nextView: "画像",
  };
  return {
    ...base,
    action: !entity || (ambiguousAmount && !value) ? "clarify" : "ready",
    analysisType: "metric",
    summary: "识别为单指标计算，需要先确认统计对象和业务口径。",
    clarification: !entity
      ? "哪一个字段能够唯一标识要统计的业务对象？"
      : ambiguousAmount
        ? `请确认“${value ?? "金额字段"}”的业务含义，以及是否包含退款、税费或运费。`
        : null,
    tools: ["profile_dataset", "run_quality_checks", "request_metric_contract", "execute_metric", "validate_result"],
    steps: ["核对字段和数据粒度", "确认指标名称、统计对象和筛选范围", "生成指标合同", "批准后执行确定性计算", "验证结果并保留限制"],
    nextView: "指标口径",
  };
}

function validatePlanFields(plan: AgentPlan, context: DatasetAgentContext): AgentPlan {
  const names = new Set(context.fields.map((field) => field.name));
  const invalid = Object.entries(plan.fieldBindings)
    .filter(([, value]) => value !== null && !names.has(value))
    .map(([key, value]) => `${key}=${value}`);
  if (invalid.length === 0) return plan;
  return {
    ...plan,
    action: "clarify",
    clarification: `计划引用了数据中不存在的字段：${invalid.join("、")}。请重新选择当前文件字段。`,
    fieldBindings: { entityField: null, valueField: null, groupField: null, timeField: null },
    nextView: "画像",
    limitations: [...plan.limitations, "字段绑定校验未通过，系统已阻止执行。"],
  };
}

function planFromDecision(input: z.infer<typeof decisionInputSchema>, question: string, context: DatasetAgentContext): AgentPlan {
  const isCountMetric = isDistinctCountQuestion(question);
  const analysisType = resolveAgentAnalysisType(question, input.analysisType);
  const intentPrompt: Record<typeof input.analysisType, string> = {
    profile: "查看数据画像",
    quality: "检查数据质量",
    cleaning: "清洗数据",
    metric: question,
    group_compare: "各地区分组比较",
    trend: "月度趋势",
    top_n: "排名前五",
    unsupported: "预测模型",
  };
  const base = fallbackPlan(analysisType === "metric" ? question : intentPrompt[analysisType], context);
  const candidateBindings = {
    entityField: isCountMetric ? preferredEntityField(question, context) : input.entityField.trim() || base.fieldBindings.entityField,
    valueField: isCountMetric ? null : input.valueField.trim() || base.fieldBindings.valueField,
    groupField: input.groupField.trim() || base.fieldBindings.groupField,
    timeField: isCountMetric ? null : input.timeField.trim() || base.fieldBindings.timeField,
  };
  const fieldBindings = keepRelevantFieldBindings(analysisType, candidateBindings);
  return {
    ...base,
    analysisType,
    summary: isCountMetric ? "已识别为去重计数指标，需要确认统计对象和筛选范围。" : base.summary,
    fieldBindings,
    confidence: 0.76,
  };
}

function enforcePolicyGuards(plan: AgentPlan, question: string): AgentPlan {
  const asksAmbiguousAmount = /销售金额|销售额|\bgmv\b|收入|营收|金额/i.test(question);
  const namesConcreteField = /\b(amount|price|sales|revenue|gmv|freight|tax|refund)\b/i.test(question);
  const statesAmountScope = /不含运费|包含运费|含运费|不含退款|包含退款|扣除退款|含税|不含税/i.test(question);
  if (asksAmbiguousAmount && !namesConcreteField && !statesAmountScope) {
    if (["group_compare", "trend", "top_n"].includes(plan.analysisType)) {
      return {
        ...plan,
        action: "clarify",
        clarification: "请在经营分析页确认金额字段，以及是否包含退款、税费或运费；确认前 Agent 不会执行计算。",
        limitations: [...new Set([...plan.limitations, "金额口径未确认，执行前必须人工选择数值字段并确认概念边界。"])],
        confidence: Math.min(plan.confidence, 0.78),
      };
    }
    return {
      ...plan,
      action: "clarify",
      analysisType: "metric",
      summary: "已识别金额指标需求，但业务口径尚不完整。",
      clarification: "请确认金额使用哪个字段，以及是否包含退款、税费或运费；确认前 Agent 不会执行计算。",
      tools: ["profile_dataset", "run_quality_checks", "request_metric_contract"],
      steps: ["核对数据粒度与候选金额字段", "确认退款、税费和运费范围", "生成指标合同并等待批准"],
      nextView: "指标口径",
      confidence: Math.min(plan.confidence, 0.78),
      limitations: [...new Set([...plan.limitations, "金额口径未确认，已由确定性规则阻止直接计算。"])],
    };
  }
  const namesExplicitMeasure = /订单(?:量|数)|客户数|用户数|商品数|数量|金额|销售额|gmv|收入|营收|平均|均值|客单价|\b(?:amount|price|sales|revenue|count)\b/i.test(question);
  if (["group_compare", "trend", "top_n"].includes(plan.analysisType) && !namesExplicitMeasure) {
    return {
      ...plan,
      action: "clarify",
      clarification: "请确认本次比较使用去重计数、数值求和还是按去重对象平均，并核对对应字段；“销售表现”本身不是唯一指标。",
      confidence: Math.min(plan.confidence, 0.75),
      limitations: [...new Set([...plan.limitations, "问题未指定唯一分析指标，Agent 只预填候选字段，不会自动把“销售表现”定义为销售额。"])],
    };
  }
  return plan;
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "请求内容不是有效 JSON。" }, { status: 400 });
  }
  const question = typeof payload === "object" && payload !== null && "question" in payload ? String(payload.question).trim() : "";
  const parsedContext = typeof payload === "object" && payload !== null && "dataset" in payload
    ? contextSchema.safeParse(payload.dataset)
    : null;
  if (!question || question.length > 500 || !parsedContext?.success) {
    return Response.json({ error: "问题或数据画像无效。" }, { status: 400 });
  }
  const dataset = parsedContext.data as DatasetAgentContext;
  const strongType = inferStrongAnalysisType(question);
  if (strongType) {
    const policyPlan = enforcePolicyGuards(validatePlanFields(planFromDecision({
      analysisType: strongType,
      entityField: "",
      valueField: "",
      groupField: "",
      timeField: "",
    }, question, dataset), dataset), question);
    return Response.json({
      plan: policyPlan,
      source: "policy-router",
      model: null,
      stepsExecuted: 0,
      latencyMs: Date.now() - startedAt,
    });
  }
  let submittedPlan: AgentPlan | null = null;
  const providerErrors: string[] = [];
  for (const provider of getAgentProviderCandidates(process.env)) {
    const compatible = createOpenAICompatible({ name: provider.id, baseURL: provider.baseURL, apiKey: provider.apiKey });
    try {
    const agent = new ToolLoopAgent({
      model: compatible.chatModel(provider.model),
      instructions: `/no_think
你是 MetricGround 的意图识别 Agent。必须先调用 inspectDataset，再调用 submitAnalysisPlan，不要输出普通文本。
analysisType 只能选择：profile 数据画像、quality 数据质量、cleaning 数据清洗、metric 单指标、group_compare 分组比较、trend 时间趋势、top_n 排名、unsupported 其他需求。
四类字段只能使用 inspectDataset 返回的真实字段名；没有对应字段时使用空字符串。执行权限、澄清和风险由系统规则处理。`,
      tools: {
        inspectDataset: tool({
          description: "读取当前上传文件的结构化画像和质量摘要，不读取原始明细值。",
          inputSchema: z.object({}),
          execute: async () => dataset,
        }),
        submitAnalysisPlan: tool({
          description: "提交紧凑的分析决策，由确定性策略编译为安全执行计划。",
          inputSchema: decisionInputSchema,
          execute: async (input) => {
            const candidate = planFromDecision(input, question, dataset);
            submittedPlan = enforcePolicyGuards(validatePlanFields(candidate, dataset), question);
            return { accepted: true, action: submittedPlan.action };
          },
        }),
      },
      prepareStep: ({ stepNumber }) => stepNumber === 0
        ? { activeTools: ["inspectDataset"], toolChoice: { type: "tool", toolName: "inspectDataset" } }
        : {
          activeTools: ["submitAnalysisPlan"],
          toolChoice: { type: "tool", toolName: "submitAnalysisPlan" },
          instructions: `/no_think
你已经读取数据画像。针对用户问题“${question}”，现在必须调用 submitAnalysisPlan，不要输出普通文本。
请选择一个 analysisType，并从画像中绑定 entityField、valueField、groupField、timeField；没有对应字段时使用空字符串。`,
        },
      stopWhen: [hasToolCall("submitAnalysisPlan"), isStepCount(3)],
      temperature: 0,
    });
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      submittedPlan = null;
      try {
        const result = await agent.generate({
          prompt: attempt === 1 ? question : `${question}\n只调用规定工具提交分析决策，不输出解释文本。`,
          abortSignal: AbortSignal.timeout(45_000),
        });
        if (!submittedPlan) throw new Error("Agent did not submit a plan");
        return Response.json({
          plan: submittedPlan,
          source: provider.kind === "local" ? "ollama-agent" : "cloud-agent",
          provider: provider.id,
          model: provider.model,
          stepsExecuted: result.steps.length,
          attempts: attempt,
          latencyMs: Date.now() - startedAt,
        });
      } catch (error) {
        lastError = error;
        if (!(error instanceof Error) || error.name !== "AI_ToolChoiceViolationError") break;
      }
    }
    throw lastError;
    } catch (error) {
      providerErrors.push(`${provider.id}: ${error instanceof Error ? error.message : "Unknown agent error"}`);
    }
  }
  return Response.json({
    plan: enforcePolicyGuards(fallbackPlan(question, dataset), question),
    source: "rule-fallback",
    provider: null,
    model: null,
    stepsExecuted: 0,
    latencyMs: Date.now() - startedAt,
    fallbackReason: providerErrors.join(" | "),
  });
}
