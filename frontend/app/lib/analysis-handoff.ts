import type { AgentPlan, AgentPlanResponse } from "./agent-plan";
import type { DatasetProfile } from "./tabular-profile";
import type { MetricDraft } from "./metric-contract";
import type { CleaningReceipt } from "./data-cleaning";
import type { TaskRun } from "./task-run";
import { createDatasetVersion } from "./analysis-spec.ts";
import { createTaskRunFromPlan } from "./agent-runtime.ts";

export function analysisConfirmationView(plan: AgentPlan | null, question = "") {
  if (plan && ["group_compare", "trend", "top_n"].includes(plan.analysisType)) return "经营分析" as const;
  if (/(?:比较|对比).{0,12}(?:地区|区域|渠道|品类)|按.{0,10}(?:分组|月|周|季度)/i.test(question)) return "经营分析" as const;
  return "指标口径" as const;
}

export function rebindMetricDraft(draft: MetricDraft, profile: DatasetProfile): MetricDraft {
  const exists = (field: string) => profile.columns.some(column => column.name === field) ? field : "";
  return { ...draft, entityField: exists(draft.entityField), valueField: exists(draft.valueField), timeField: exists(draft.timeField),
    grainConfirmed: false, qualityAcknowledged: false, definitionConfirmed: false };
}

export type DataScopeEvidence = {
  source: ReturnType<typeof createDatasetVersion>;
  derived: ReturnType<typeof createDatasetVersion>;
  sourceTaskId: string | null;
  capturedAt: string;
  confirmedAt: string | null;
  entityField: string | null;
  sourceDistinctEntities: number | null;
  derivedDistinctEntities: number | null;
  receipt: CleaningReceipt;
};

export function createDataScopeEvidence(source: DatasetProfile, derived: DatasetProfile, receipt: CleaningReceipt, entityField: string | null, sourceTaskId: string | null): DataScopeEvidence {
  return { source: createDatasetVersion(source), derived: createDatasetVersion(derived), sourceTaskId,
    capturedAt: new Date().toISOString(), confirmedAt: null, entityField,
    sourceDistinctEntities: source.columns.find(column => column.name === entityField)?.uniqueCount ?? null,
    derivedDistinctEntities: derived.columns.find(column => column.name === entityField)?.uniqueCount ?? null,
    receipt: structuredClone(receipt) };
}

export function rebindTaskAfterCleaning(profile: DatasetProfile, question: string, response: AgentPlanResponse, previous: TaskRun | null, scope: DataScopeEvidence) {
  const next = createTaskRunFromPlan(profile, question, response);
  return { ...next, datasetVersions: [scope.source, scope.derived], dataScopeEvidence: structuredClone(scope),
    planningEvidence: { ...structuredClone(previous?.planningEvidence ?? next.planningEvidence!),
      reusedFrom: { taskId: previous?.id ?? null, datasetVersionId: scope.source.versionId, reason: "数据清洗后沿用原候选计划；未重新调用模型，字段和口径必须重新确认。" } },
  };
}
