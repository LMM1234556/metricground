import type { AgentPlanResponse } from "./agent-plan";
import { createDatasetVersion } from "./analysis-spec.ts";
import type { DatasetProfile, QualityIssue } from "./tabular-profile";
import type { TaskRun } from "./task-run";

export type PlanningEvidence = {
  capturedAt: string;
  source: AgentPlanResponse["source"];
  provider: AgentPlanResponse["provider"] | null;
  model: string | null;
  stepsExecuted: number;
  attempts: number | null;
  latencyMs: number;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
};

export type QualityEvidence = {
  datasetVersionId: string;
  capturedAt: string;
  issues: Array<Pick<QualityIssue, "id" | "check" | "severity" | "title" | "field" | "evidence" | "impact" | "recommendation" | "supportedRepair"> & {
    decision: "pending" | "kept" | "approved";
  }>;
  checksSkipped: DatasetProfile["qualityChecksSkipped"];
};

export type ResultEvidence = {
  engine: "browser-deterministic";
  sourceRows: number;
  eligibleRows: number;
  excludedMissingEntities: number;
  excludedInvalidValues: number;
  excludedGroupingRows?: number;
  distinctEntities?: number;
  value?: number;
  numerator?: number | null;
  denominator?: number | null;
  fullGroupCount?: number;
  groups?: Array<{ key: string; value: number; sourceRows: number; distinctEntities: number; excludedInvalidValues: number }>;
  groupsTruncated?: boolean;
};

export function capturePlanningEvidence(response: AgentPlanResponse, capturedAt: string): PlanningEvidence {
  return {
    capturedAt, source: response.source, provider: response.provider ?? null, model: response.model,
    stepsExecuted: response.stepsExecuted, attempts: response.attempts ?? null, latencyMs: response.latencyMs,
    usage: response.usage ? { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens } : null,
  };
}

export function captureQualityEvidence(profile: DatasetProfile, decisions: Record<string, "approved" | "kept"> = {}, capturedAt = new Date().toISOString()): QualityEvidence {
  return {
    datasetVersionId: createDatasetVersion(profile).versionId,
    capturedAt,
    issues: profile.qualityIssues.map((issue) => ({
      id: issue.id, check: issue.check, severity: issue.severity, title: issue.title,
      ...(issue.field ? { field: issue.field } : {}),
      // Mixed-type evidence contains example cell values; retain the finding, not those values.
      evidence: issue.id.startsWith("mixed-type-") ? "字段类型检查发现混合类型；原始样例值不进入证据包。" : issue.evidence,
      impact: issue.impact, recommendation: issue.recommendation,
      ...(issue.supportedRepair ? { supportedRepair: issue.supportedRepair } : {}),
      decision: decisions[issue.id] ?? "pending",
    })),
    checksSkipped: profile.qualityChecksSkipped.map((check) => ({ ...check })),
  };
}

export function bindQualityEvidence(run: TaskRun, profile: DatasetProfile, decisions: Record<string, "approved" | "kept">, capturedAt = new Date().toISOString()): TaskRun {
  const evidence = captureQualityEvidence(profile, decisions, capturedAt);
  if (!run.datasetVersions.some((version) => version.versionId === evidence.datasetVersionId)) {
    throw new Error("质量证据与任务数据版本不一致，不能混入当前任务。");
  }
  return { ...run, qualityEvidence: evidence };
}
