import type { DatasetProfile } from "./tabular-profile";

export const AGENT_TOOLS = [
  "profile_dataset",
  "run_quality_checks",
  "preview_cleaning",
  "request_metric_contract",
  "execute_metric",
  "execute_group_compare",
  "execute_trend",
  "execute_top_n",
  "validate_result",
] as const;

export type AgentToolName = typeof AGENT_TOOLS[number];
export type AgentAnalysisType = "profile" | "quality" | "cleaning" | "metric" | "group_compare" | "trend" | "top_n" | "unsupported";

export type DatasetAgentContext = {
  fileName: string;
  rowCount: number;
  columnCount: number;
  grainSuggestion: string;
  fields: Array<{
    name: string;
    type: string;
    missingRate: number;
    uniqueCount: number;
    candidateKey: boolean;
  }>;
  qualityIssues: Array<{ title: string; severity: string; check: string }>;
  availableTools: AgentToolName[];
};

export type AgentPlan = {
  action: "ready" | "clarify" | "unsupported";
  analysisType: AgentAnalysisType;
  summary: string;
  clarification: string | null;
  tools: AgentToolName[];
  steps: string[];
  fieldBindings: {
    entityField: string | null;
    valueField: string | null;
    groupField: string | null;
    timeField: string | null;
  };
  nextView: "画像" | "质量检查" | "清洗方案" | "多表关联" | "指标口径" | "经营分析" | null;
  confidence: number;
  limitations: string[];
};

export function isDistinctCountQuestion(question: string) {
  if (/平均|均值|客单价|人均|比例|占比|转化率|送达率|总额|合计|求和|总金额|金额总/i.test(question)) return false;
  const quantity = /多少|几(?:个|笔|位|条|种)|数量|个数|总数|订单量|订单数|客户数|用户数|商品数/i.test(question);
  const distinct = /去重|唯一|不同|不重复/i.test(question)
    || /(?:重复|相同).{0,12}(?:只|仅).{0,6}(?:算|计|统计).{0,4}(?:一次|一笔|一个|1次)/i.test(question);
  if (distinct && quantity) return true;
  if (/重复|缺失|异常|质量/i.test(question)) return false;
  return /订单量|订单数|客户数|用户数|会员数|商品数|业务对象数量/i.test(question)
    || /(?:多少|几)(?:个|笔|位|条|种)?.{0,8}(?:订单|客户|用户|会员|商品|sku)/i.test(question)
    || /(?:订单|客户|用户|会员|商品|sku).{0,8}(?:多少|几(?:个|笔|位|条|种))/i.test(question);
}

export function isJoinAmountRiskQuestion(question: string) {
  return /关联|合并|连接|join/i.test(question)
    && /金额|销售额|gmv|amount|revenue|price/i.test(question)
    && /放大|变多|变大|多了|增加|翻倍|重复|对不上|不一致/i.test(question);
}

export function isRowCountDifferenceQuestion(question: string) {
  return /行数|记录数|数行|明细数/i.test(question)
    && /订单数|订单量|对象数|去重|唯一/i.test(question)
    && /不一样|不一致|不同|多|少|为什么|为何|区别|差异/i.test(question);
}

export function isRankingQuestion(question: string) {
  return /前\s*(?:\d+|[一二三四五六七八九十百]+)|top\s*\d+|排名|最高|最低/i.test(question)
    || /(?:谁|哪(?:个|些|里|家|类|种)).{0,24}(?:最多|最少|最大|最小)/i.test(question)
    || /(?:金额|销售额|订单量|订单数|数量|amount|gmv).{0,8}(?:最多|最少|最大|最小)/i.test(question);
}

export function inferStrongAnalysisType(question: string): AgentAnalysisType | null {
  if (/预测|forecast|机器学习|回归|聚类/i.test(question)) return "unsupported";
  if (/清洗|去除重复(?:行|记录|数据)?|删除重复(?:行|记录|数据)?|数据去重|处理缺失|修复日期/i.test(question)) return "cleaning";
  if (isJoinAmountRiskQuestion(question) || isRowCountDifferenceQuestion(question)
    || (!isDistinctCountQuestion(question) && /重复(?:的)?(?:订单|记录|编号)|(?:订单|记录|编号).{0,8}重复/i.test(question))
    || /质量|检查.*(?:异常|缺失|重复)|有哪些.*(?:问题|风险)|能不能用|是否可用|重复统计|算重复|多算|重复值|完全重复/i.test(question)) return "quality";
  if (/数据画像|字段结构|字段类型|多少行|多少列|查看字段/i.test(question)) return "profile";
  if (/趋势|月度|按月|同比|环比|随时间|时间变化/i.test(question)) return "trend";
  if (isRankingQuestion(question)) return "top_n";
  if (/各地区|各区域|各品类|各渠道|按[^，。！？]{0,10}(?:地区|区域|品类|渠道)|分组|分群/i.test(question)) return "group_compare";
  if (isDistinctCountQuestion(question) || /总额|合计|平均|均值|比例|率|销售额|金额|gmv|收入|营收/i.test(question)) return "metric";
  return null;
}

export function resolveAgentAnalysisType(question: string, modelType: AgentAnalysisType): AgentAnalysisType {
  return inferStrongAnalysisType(question) ?? modelType;
}

export function keepRelevantFieldBindings(
  analysisType: AgentAnalysisType,
  bindings: AgentPlan["fieldBindings"],
): AgentPlan["fieldBindings"] {
  const empty = { entityField: null, valueField: null, groupField: null, timeField: null };
  if (["profile", "quality", "cleaning", "unsupported"].includes(analysisType)) return empty;
  if (analysisType === "metric") return {
    entityField: bindings.entityField,
    valueField: bindings.valueField,
    groupField: null,
    timeField: bindings.timeField,
  };
  if (["group_compare", "top_n"].includes(analysisType)) return {
    entityField: bindings.entityField,
    valueField: bindings.valueField,
    groupField: bindings.groupField,
    timeField: null,
  };
  return bindings;
}

export type AgentPlanResponse = {
  plan: AgentPlan;
  source: "policy-router" | "ollama-agent" | "cloud-agent" | "rule-fallback";
  model: string | null;
  provider?: "ollama" | "groq" | "dashscope" | null;
  stepsExecuted: number;
  attempts?: number;
  latencyMs: number;
  fallbackReason?: string;
};

export function createDatasetAgentContext(profile: DatasetProfile): DatasetAgentContext {
  return {
    fileName: profile.fileName,
    rowCount: profile.rowCount,
    columnCount: profile.columnCount,
    grainSuggestion: profile.grainSuggestion,
    fields: profile.columns.map((column) => ({
      name: column.name,
      type: column.inferredType,
      missingRate: column.missingRate,
      uniqueCount: column.uniqueCount,
      candidateKey: column.isCandidateKey,
    })),
    qualityIssues: profile.qualityIssues.map((issue) => ({
      title: issue.title,
      severity: issue.severity,
      check: issue.check,
    })),
    availableTools: [...AGENT_TOOLS],
  };
}
