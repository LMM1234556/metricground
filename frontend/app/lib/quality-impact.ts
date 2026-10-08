import type { QualityIssue } from "./tabular-profile";

export type QualityImpactLevel = "affecting" | "review" | "unrelated";

export type MetricQualityContext = {
  metricName: string;
  metricType: "count" | "amount" | "average" | "ratio";
  entityField: string;
  valueField: string | null;
  timeField: string | null;
  filterScope: string;
  decisionQuestion: string;
  grainConfirmed: boolean;
  additionalScope?: string;
};

export type QualityImpactItem = {
  issueId: string;
  level: QualityImpactLevel;
  label: string;
  reason: string;
  recommendedDecision: "kept" | "approved" | "manual_review";
  recommendedAction: string;
};

export type QualityImpactSummary = {
  affecting: number;
  review: number;
  unrelated: number;
  items: QualityImpactItem[];
  statement: string;
};

function normalized(value: string | null | undefined) {
  return (value ?? "").trim().toLocaleLowerCase();
}

function issueField(issue: QualityIssue) {
  if (issue.field) return issue.field;
  return issue.title.match(/[“"]([^”"]+)[”"]/)?.[1] ?? "";
}

function referencesField(field: string, context: MetricQualityContext) {
  if (!field) return false;
  const needle = normalized(field);
  return normalized(`${context.filterScope} ${context.decisionQuestion} ${context.additionalScope ?? ""}`).includes(needle);
}

function usesTime(context: MetricQualityContext) {
  return /按(?:日|周|月|季|年)|趋势|环比|同比|周期|日期|时间|day|week|month|quarter|year|date|time/i
    .test(`${context.metricName} ${context.decisionQuestion} ${context.filterScope} ${context.additionalScope ?? ""}`);
}

function item(
  issue: QualityIssue,
  level: QualityImpactLevel,
  reason: string,
  recommendedAction: string,
  recommendedDecision: QualityImpactItem["recommendedDecision"],
): QualityImpactItem {
  const label = level === "affecting" ? "影响本指标" : level === "review" ? "需要人工确认" : "本指标不受影响";
  return { issueId: issue.id, level, label, reason, recommendedAction, recommendedDecision };
}

export function assessQualityIssueForMetric(issue: QualityIssue, context: MetricQualityContext): QualityImpactItem {
  const field = issueField(issue);
  const isEntity = Boolean(field) && normalized(field) === normalized(context.entityField);
  const isValue = Boolean(field) && normalized(field) === normalized(context.valueField);
  const isTime = Boolean(field) && normalized(field) === normalized(context.timeField);
  const usedByFilter = referencesField(field, context);
  const distinctEntityMetric = context.metricType === "count" || context.metricType === "ratio";

  if (issue.check === "重复行") {
    if (distinctEntityMetric) {
      return item(issue, "unrelated", `公式按 ${context.entityField} 去重，完全相同的重复行不会增加去重对象数。`, "保留原样并记录说明；若改做金额汇总，需要重新评估。", "kept");
    }
    return item(issue, "affecting", "金额或平均值会累计数据行，完全重复记录可能造成重复求和。", "进入清洗方案预览去重影响，核对后再生成派生副本。", "approved");
  }

  if (issue.check === "键与粒度") {
    if (isEntity && distinctEntityMetric) {
      if (!context.grainConfirmed) {
        return item(issue, "review", `公式会对 ${context.entityField} 去重，但仍需确认重复值代表同一业务对象，而不是编号复用。`, "先确认一行代表什么及编号是否允许重复。", "manual_review");
      }
      return item(issue, "unrelated", `已确认 ${context.entityField} 的业务粒度，公式 COUNT(DISTINCT) 会处理重复编号。`, "记录为已核实，不对原始数据去重。", "approved");
    }
    if (isEntity || usedByFilter || (context.metricType !== "count" && context.metricType !== "ratio")) {
      return item(issue, "review", "重复标识可能是正常的一对多明细，也可能造成金额重复累计，单靠字段名不能判断。", "核实行粒度、主键规则和金额所在粒度后再决定。", "manual_review");
    }
    return item(issue, "unrelated", `字段 ${field || "该标识字段"} 未参与当前公式或筛选。`, "本指标可保留原样；更换统计对象时重新评估。", "kept");
  }

  if (issue.check === "完整性") {
    if (isEntity) return item(issue, "affecting", `缺失 ${context.entityField} 的记录无法进入去重对象计数。`, "核实缺失记录的业务含义，并在结果中披露排除行数。", "manual_review");
    if (isValue && (context.metricType === "amount" || context.metricType === "average")) {
      return item(issue, "affecting", `缺失 ${context.valueField} 的记录无法参与求和。`, "核实能否补值；不能确认时排除并披露行数。", "manual_review");
    }
    if ((isTime && usesTime(context)) || usedByFilter) {
      return item(issue, "affecting", `字段 ${field} 用于当前时间范围或筛选，缺失值会改变样本范围。`, "确认排除规则并披露缺失行数。", "manual_review");
    }
    return item(issue, "unrelated", `字段 ${field || "该字段"} 未参与当前公式、时间范围或筛选。`, "本次保留原样；使用该字段分析时重新评估。", "kept");
  }

  if (issue.check === "异常值") {
    if (isValue && (context.metricType === "amount" || context.metricType === "average")) {
      return item(issue, "affecting", `${context.valueField} 直接参与${context.metricType === "amount" ? "求和" : "均值"}，异常值可能显著改变结果。`, "回查原始记录和单位，不要只按 IQR 自动删除。", "manual_review");
    }
    return item(issue, "unrelated", `字段 ${field || "该数值字段"} 不参与当前指标计算。`, "本次保留原样；计算金额或均值时重新评估。", "kept");
  }

  if (issue.check === "有效性") {
    if ((isTime && usesTime(context)) || usedByFilter || isValue || isEntity) {
      return item(issue, "affecting", `字段 ${field || "该字段"} 参与当前公式、时间范围或筛选，无效值可能被遗漏或错误归类。`, "先确认格式转换或排除规则，再执行计算。", "manual_review");
    }
    return item(issue, "unrelated", `字段 ${field || "该字段"} 未参与当前指标计算。`, "本次保留原样；引用该字段时重新评估。", "kept");
  }

  return item(issue, "review", "现有结构化规则不足以判断它是否改变本次结果。", "查看原始证据并由人工确认。", "manual_review");
}

export function assessQualityImpact(issues: QualityIssue[], context: MetricQualityContext): QualityImpactSummary {
  const items = issues.map((issue) => assessQualityIssueForMetric(issue, context));
  const affecting = items.filter((entry) => entry.level === "affecting").length;
  const review = items.filter((entry) => entry.level === "review").length;
  const unrelated = items.filter((entry) => entry.level === "unrelated").length;
  const statement = affecting > 0 || review > 0
    ? `${affecting} 项会影响当前指标，${review} 项仍需人工确认，${unrelated} 项与当前口径无关。`
    : `当前 ${issues.length} 项数据集风险均不改变该指标的计算结果；更换指标、筛选或分组后必须重新评估。`;
  return { affecting, review, unrelated, items, statement };
}
