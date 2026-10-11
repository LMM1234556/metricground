import type { AgentPlan, ModelPlanningDecision, PlanAdjustment } from "./agent-plan";

function comparablePlan(plan: AgentPlan) {
  return {
    analysisType: plan.analysisType, ...plan.fieldBindings,
    action: plan.action, clarification: plan.clarification,
    confidence: plan.confidence, limitations: [...plan.limitations],
    summary: plan.summary, tools: [...plan.tools], steps: [...plan.steps], nextView: plan.nextView,
  };
}

function changes(
  stage: PlanAdjustment["stage"],
  before: Record<string, PlanAdjustment["before"]>,
  after: Record<string, PlanAdjustment["after"]>,
): PlanAdjustment[] {
  return Object.keys(before).filter(field => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
    .map(field => ({ stage, field, before: before[field], after: after[field] }));
}

export function compileModelPlan(
  input: ModelPlanningDecision,
  compile: (input: ModelPlanningDecision) => AgentPlan,
  enforcePolicy: (plan: AgentPlan) => AgentPlan,
  validateFields: (plan: AgentPlan) => AgentPlan,
) {
  // Capture before any callback can normalize or mutate the submitted arguments.
  const modelDecision = structuredClone(input);
  const candidate = compile(structuredClone(modelDecision));
  const compiled = comparablePlan(candidate);
  const guardedPlan = enforcePolicy(candidate);
  const guarded = comparablePlan(guardedPlan);
  const plan = validateFields(guardedPlan);
  return {
    plan,
    modelDecision,
    planAdjustments: [
      ...changes("compile", modelDecision, compiled),
      ...changes("policy", compiled, guarded),
      ...changes("field-validation", guarded, comparablePlan(plan)),
    ],
  };
}
