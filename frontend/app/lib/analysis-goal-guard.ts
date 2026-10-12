import { inferStrongAnalysisType, isDistinctCountQuestion } from "./agent-plan.ts";
import type { AnalysisSpec } from "./analysis-spec";

export function isRatioQuestion(question: string) {
  return /成功率|送达率|送货率|转化率|退款率|取消率|比例|占比|比率|率(?:[，。！？?]|$)/i.test(question.trim());
}

export function requestsOriginalScope(question: string) {
  return /原始(?:文件|数据|表)|原(?:文件|数据|表)(?:的|中|全部|所有)/.test(question);
}

// Conservative checks for explicit goals only, not a claim of general language understanding.
export function analysisGoalErrors(question: string, spec: Pick<AnalysisSpec, "analysisType" | "aggregation" | "groupBy" | "entityField">): string[] {
  const errors: string[] = [];
  const intent = inferStrongAnalysisType(question);
  if (intent === "join") {
    errors.push("原问题要求关联补充字段，请进入多表关联确认向导；不能用统计指标替代关联任务。关联后计算其他指标需要开始新的分析。");
  }
  if (intent === "unsupported") {
    errors.push("原问题超出当前受控工具能力，不能通过手动选择其他计算把它标记完成。");
  }
  if (isRatioQuestion(question) && spec.aggregation !== "ratio") {
    errors.push("原问题要求比例/成功率，当前公式却不是比例。不能用计数、金额合计或平均值替代；需要确认分子和分母。");
  }
  if (isRatioQuestion(question) && spec.groupBy.length > 0) {
    errors.push("当前版本尚不支持按分组计算比例指标；已阻止替代计算。请保留原问题，等待分组比例能力，或开始新的分析。");
  }
  if (isDistinctCountQuestion(question) && spec.aggregation !== "count_distinct") {
    errors.push("原问题要求不同业务对象数量，必须按确认的编号去重计数。");
  }
  if (intent === "metric" && spec.groupBy.length > 0) {
    errors.push("原问题是整体指标，当前配置却增加了分组。请回到指标口径；若要改变问题，请开始新的分析。");
  }
  if (["group_compare", "trend", "top_n"].includes(intent ?? "") && spec.analysisType !== intent) {
    errors.push("当前分析方式与原问题的分组、趋势或排名目标不一致；不能用另一种计算替代。");
  }
  if (/平均|均值|客单价|人均/.test(question) && !isRatioQuestion(question) && spec.aggregation !== "average") {
    errors.push("原问题要求平均指标，当前聚合方式不一致。");
  }
  if (/(?:订单|送达|送货|配送)/.test(question) && /^(?:.*\.)?(?:status|order_status)$|状态/.test(spec.entityField)) {
    errors.push("订单指标的统计对象不能是状态类别；请选择订单编号，状态应作为条件或分组字段。");
  }
  return errors;
}
