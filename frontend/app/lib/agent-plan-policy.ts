import {
  inferStrongAnalysisType, isDistinctCountQuestion, keepRelevantFieldBindings,
  type AgentPlan,
} from "./agent-plan.ts";

// Safety and clarification preserve the identified task; they never promote an
// unsupported task or change a ranking/trend into a scalar amount calculation.
export function enforcePolicyGuards(plan: AgentPlan, question: string): AgentPlan {
  if (inferStrongAnalysisType(question) === "unsupported" || plan.analysisType === "unsupported") {
    return {
      ...plan,
      action: "unsupported",
      analysisType: "unsupported",
      summary: inferStrongAnalysisType(question) === "unsupported"
        ? "当前 MVP 不执行预测或机器学习建模。"
        : "当前受控分析工具不支持这项需求，请调整分析目标或补充所需能力。",
      clarification: null,
      fieldBindings: keepRelevantFieldBindings("unsupported", plan.fieldBindings),
      tools: ["profile_dataset"],
      steps: ["说明能力边界和所需扩展"],
      nextView: null,
    };
  }
  if (!["metric", "group_compare", "trend", "top_n"].includes(plan.analysisType)) return plan;

  const asksAmbiguousAmount = /销售金额|销售额|\bgmv\b|收入|营收|金额/i.test(question);
  const valueField = plan.fieldBindings.valueField?.split(".").at(-1);
  const namesConcreteField = Boolean(valueField && (
    /^[A-Za-z_][\w]*$/.test(valueField)
      ? new RegExp(`\\b${valueField}\\b`, "i").test(question)
      : question.includes(valueField)
  ));
  const statesAmountScope = /不含运费|包含运费|含运费|不含退款|包含退款|扣除退款|含税|不含税/i.test(question);
  if (asksAmbiguousAmount && !isDistinctCountQuestion(question) && !namesConcreteField && !statesAmountScope) {
    const businessAnalysis = ["group_compare", "trend", "top_n"].includes(plan.analysisType);
    const scopeQuestion = businessAnalysis
      ? "请在经营分析页确认金额字段，以及是否包含退款、税费或运费；确认前 Agent 不会执行计算。"
      : "请确认金额使用哪个字段，以及是否包含退款、税费或运费；确认前 Agent 不会执行计算。";
    return {
      ...plan,
      action: "clarify",
      clarification: [plan.action === "clarify" ? plan.clarification : null, scopeQuestion].filter(Boolean).join(" "),
      limitations: [...new Set([...plan.limitations, "金额口径未确认，执行前必须人工选择数值字段并确认概念边界。"])],
      confidence: Math.min(plan.confidence, 0.78),
    };
  }
  const namesExplicitMeasure = isDistinctCountQuestion(question)
    || /订单(?:量|数)|客户数|用户数|商品数|数量|金额|销售额|gmv|收入|营收|平均|均值|客单价|\b(?:amount|price|sales|revenue|count)\b/i.test(question);
  if (["group_compare", "trend", "top_n"].includes(plan.analysisType) && !namesExplicitMeasure) {
    return {
      ...plan,
      action: "clarify",
      clarification: [
        plan.action === "clarify" ? plan.clarification : null,
        "请确认本次比较使用去重计数、数值求和还是按去重对象平均，并核对对应字段；“销售表现”本身不是唯一指标。",
      ].filter(Boolean).join(" "),
      confidence: Math.min(plan.confidence, 0.75),
      limitations: [...new Set([...plan.limitations, "问题未指定唯一分析指标，Agent 只预填候选字段，不会自动把“销售表现”定义为销售额。"])],
    };
  }
  return plan;
}
