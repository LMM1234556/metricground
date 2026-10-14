import type { DatasetProfile } from "./tabular-profile";
import type { AnalysisSpec } from "./analysis-spec";
import type { BusinessAnalysisConfig } from "./business-analysis";
import { assessQualityImpact, type QualityImpactSummary } from "./quality-impact.ts";

export function businessQualityReview(profile: DatasetProfile, config: BusinessAnalysisConfig, question: string, confirmed = false): QualityImpactSummary {
  const completeFields = Boolean(config.entityField && (config.analysisType === "trend" ? config.timeField : config.groupField)
    && (!["sum", "average"].includes(config.aggregation) || config.valueField)
    && (config.aggregation !== "ratio" || config.ratioNumerator?.field));
  if (!completeFields) return {
    affecting: 0, unrelated: 0, review: profile.qualityIssues.length,
    items: profile.qualityIssues.map(issue => ({ issueId: issue.id, level: "review", label: "待明确口径",
      reason: "尚未确定计算、分组或条件字段，无法判断此问题是否影响当前答案。", recommendedDecision: "manual_review", recommendedAction: "先明确分析字段；不要仅为减少问题数而删除记录。" })),
    statement: "分析字段尚未完整，需要先明确口径再判断质量问题的影响。",
  };
  const summary = assessQualityImpact(profile.qualityIssues, {
    metricName: question, decisionQuestion: question,
    metricType: config.aggregation === "count_distinct" ? "count" : config.aggregation === "sum" ? "amount" : config.aggregation,
    entityField: config.entityField, valueField: ["sum", "average"].includes(config.aggregation) ? config.valueField : null,
    timeField: config.analysisType === "trend" ? config.timeField : null,
    filterScope: "", grainConfirmed: confirmed,
    groupFields: config.analysisType === "trend" ? [] : [config.groupField],
    additionalScope: [config.analysisType === "trend" ? config.timeField : config.groupField,
      config.aggregation === "ratio" ? config.ratioNumerator?.field : "",
      config.aggregation === "ratio" && config.ratioDenominator?.enabled ? config.ratioDenominator.field : ""].filter(Boolean).join(" "),
  });
  if (!confirmed) return { ...summary, items: summary.items.map(item => ({ ...item,
    label: item.level === "unrelated" ? "按候选口径可保留" : item.label,
    reason: `${item.reason} 此判断基于当前候选字段，最终选择变化后须重新评估。` })) };
  return summary;
}

export function businessQualityConfigFromSpec(spec: AnalysisSpec): BusinessAnalysisConfig {
  return { analysisType: spec.analysisType === "trend" ? "trend" : spec.analysisType === "top_n" ? "top_n" : "group_compare",
    aggregation: spec.aggregation, entityField: spec.entityField, valueField: spec.valueField ?? "",
    groupField: spec.groupBy[0]?.field ?? "", timeField: spec.timeField?.field ?? "", timeGrain: spec.timeGrain ?? "month",
    sortDirection: spec.sort?.direction ?? "desc", limit: spec.limit ?? 5,
    ratioNumerator: spec.numerator?.filter ?? undefined, ratioDenominator: spec.denominator?.filter ?? undefined };
}
