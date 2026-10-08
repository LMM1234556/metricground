import type { DatasetProfile } from "./tabular-profile";
import { assessQualityImpact, type QualityImpactSummary } from "./quality-impact.ts";

export type MetricType = "count" | "amount" | "average" | "ratio";

export type MetricDraft = {
  metricName: string;
  decisionQuestion: string;
  metricType: MetricType;
  entityField: string;
  valueField: string;
  timeField: string;
  filterScope: string;
  numeratorDefinition: string;
  denominatorDefinition: string;
  grainDescription: string;
  grainConfirmed: boolean;
  qualityAcknowledged: boolean;
  definitionConfirmed: boolean;
};

export type MetricContract = {
  version: "1.0";
  metricName: string;
  decisionQuestion: string;
  metricType: MetricType;
  metricTypeLabel: string;
  formula: string;
  statisticalUnit: string;
  valueField: string | null;
  timeField: string | null;
  filterScope: string;
  grainDescription: string;
  source: {
    fileName: string;
    sheetName: string;
    rowCount: number;
  };
  qualityDisposition: {
    approved: number;
    reviewed: number;
    kept: number;
    undecided: number;
    statement: string;
  };
  qualityImpact: QualityImpactSummary;
  warnings: string[];
  status: "confirmed";
};

export const METRIC_TYPES: Array<{ value: MetricType; label: string; description: string }> = [
  { value: "count", label: "计数指标", description: "例如订单量、客户数，默认按业务对象去重。" },
  { value: "amount", label: "金额/总量", description: "例如 GMV、销售额，对指定数值字段求和。" },
  { value: "average", label: "平均指标", description: "例如客单价，用总量除以去重业务对象数。" },
  { value: "ratio", label: "比例指标", description: "例如送达率、转化率，必须分别说明分子和分母。" },
];

export function createMetricDraft(profile: DatasetProfile): MetricDraft {
  const identifier = profile.candidateKeys[0]
    ?? profile.columns.find((column) => /(?:^|[_\s-])(?:id|key|code|no)(?:$|[_\s-])|编号|编码|单号/i.test(column.name))?.name
    ?? profile.columns[0]?.name
    ?? "";
  const numeric = profile.columns.find((column) => column.inferredType === "数值" && column.name !== identifier)?.name ?? "";
  const date = profile.columns.find((column) => column.inferredType === "日期" || /date|time|日期|时间/i.test(column.name))?.name ?? "";

  return {
    metricName: "",
    decisionQuestion: "",
    metricType: "count",
    entityField: identifier,
    valueField: numeric,
    timeField: date,
    filterScope: "全部有效记录",
    numeratorDefinition: "",
    denominatorDefinition: "",
    grainDescription: identifier ? `一行代表一条业务记录，按 ${identifier} 识别统计对象。` : "",
    grainConfirmed: false,
    qualityAcknowledged: false,
    definitionConfirmed: false,
  };
}

export function validateMetricDraft(draft: MetricDraft, qualityIssueCount: number): string[] {
  const errors: string[] = [];
  if (draft.metricName.trim().length < 2) errors.push("请填写清晰的指标名称");
  if (draft.decisionQuestion.trim().length < 4) errors.push("请说明该指标支持什么业务判断");
  if (!draft.entityField) errors.push("请选择统计对象/去重字段");
  if (!draft.grainDescription.trim()) errors.push("请说明一行数据代表什么");
  if ((draft.metricType === "amount" || draft.metricType === "average") && !draft.valueField) {
    errors.push("请选择参与计算的数值字段");
  }
  if (draft.metricType === "ratio") {
    if (draft.numeratorDefinition.trim().length < 2) errors.push("请定义比例指标的分子");
    if (draft.denominatorDefinition.trim().length < 2) errors.push("请定义比例指标的分母");
  }
  if (!draft.filterScope.trim()) errors.push("请填写数据范围或筛选条件");
  if (!draft.grainConfirmed) errors.push("请确认数据粒度");
  if (qualityIssueCount > 0 && !draft.qualityAcknowledged) errors.push("请确认已知的数据质量风险");
  if (!draft.definitionConfirmed) errors.push("请确认指标定义不等于收入、利润等其他概念");
  return errors;
}

function buildFormula(draft: MetricDraft) {
  if (draft.metricType === "count") return `COUNT(DISTINCT ${draft.entityField})`;
  if (draft.metricType === "amount") return `SUM(${draft.valueField})`;
  if (draft.metricType === "average") return `SUM(${draft.valueField}) / COUNT(DISTINCT ${draft.entityField})`;
  return `符合【${draft.numeratorDefinition.trim()}】的去重 ${draft.entityField} 数 / 符合【${draft.denominatorDefinition.trim()}】的去重 ${draft.entityField} 数`;
}

export function buildMetricContract(
  draft: MetricDraft,
  profile: DatasetProfile,
  qualityDecisions: Record<string, "approved" | "kept">,
): MetricContract {
  const approved = profile.qualityIssues.filter((issue) =>
    issue.supportedRepair && qualityDecisions[issue.id] === "approved"
  ).length;
  const reviewed = profile.qualityIssues.filter((issue) =>
    !issue.supportedRepair && qualityDecisions[issue.id] === "approved"
  ).length;
  const kept = Object.values(qualityDecisions).filter((decision) => decision === "kept").length;
  const undecided = Math.max(profile.qualityIssues.length - approved - reviewed - kept, 0);
  const typeLabel = METRIC_TYPES.find((item) => item.value === draft.metricType)?.label ?? draft.metricType;
  const qualityImpact = assessQualityImpact(profile.qualityIssues, {
    metricName: draft.metricName,
    metricType: draft.metricType,
    entityField: draft.entityField,
    valueField: draft.metricType === "amount" || draft.metricType === "average" ? draft.valueField : null,
    timeField: draft.timeField || null,
    filterScope: draft.filterScope,
    decisionQuestion: draft.decisionQuestion,
    grainConfirmed: draft.grainConfirmed,
    additionalScope: `${draft.numeratorDefinition} ${draft.denominatorDefinition}`,
  });
  const warnings: string[] = [];
  if (qualityImpact.affecting > 0) warnings.push(`${qualityImpact.affecting} 项数据质量问题会影响当前指标，必须保留影响说明。`);
  if (qualityImpact.review > 0) warnings.push(`${qualityImpact.review} 项问题仍需人工确认，确认前结果只能作为分析预览。`);
  if (profile.qualityChecksSkipped.length > 0) warnings.push(`${profile.qualityChecksSkipped.length} 项质量检查因有效样本不足未运行，不能把“未发现问题”解释为风险已消失。`);
  if (!draft.timeField) warnings.push("未指定时间字段，指标不能直接用于时间趋势或周期对比。");
  if (draft.metricType === "ratio") warnings.push("比例指标必须保持分子属于分母，执行计算前仍需验证条件。 ");

  return {
    version: "1.0",
    metricName: draft.metricName.trim(),
    decisionQuestion: draft.decisionQuestion.trim(),
    metricType: draft.metricType,
    metricTypeLabel: typeLabel,
    formula: buildFormula(draft),
    statisticalUnit: draft.entityField,
    valueField: draft.metricType === "amount" || draft.metricType === "average" ? draft.valueField : null,
    timeField: draft.timeField || null,
    filterScope: draft.filterScope.trim(),
    grainDescription: draft.grainDescription.trim(),
    source: {
      fileName: profile.fileName,
      sheetName: profile.activeSheet,
      rowCount: profile.rowCount,
    },
    qualityDisposition: {
      approved,
      reviewed,
      kept,
      undecided,
      statement: approved + reviewed + kept === 0
        ? `没有待处置的已发现问题${profile.qualityChecksSkipped.length > 0 ? `；另有 ${profile.qualityChecksSkipped.length} 项检查未运行` : ""}。`
        : `批准清洗 ${approved} 项，人工核实 ${reviewed} 项，保留原样 ${kept} 项，未逐项决定 ${undecided} 项。`,
    },
    qualityImpact,
    warnings,
    status: "confirmed",
  };
}

export function contractAsText(contract: MetricContract) {
  return [
    `指标名称：${contract.metricName}`,
    `业务用途：${contract.decisionQuestion}`,
    `指标类型：${contract.metricTypeLabel}`,
    `计算公式：${contract.formula}`,
    `统计单位：${contract.statisticalUnit}`,
    `时间字段：${contract.timeField ?? "未指定"}`,
    `筛选范围：${contract.filterScope}`,
    `数据粒度：${contract.grainDescription}`,
    `质量处置：${contract.qualityDisposition.statement}`,
    `指标相关性：${contract.qualityImpact.statement}`,
    `风险提示：${contract.warnings.join("；") || "无"}`,
  ].join("\n");
}
