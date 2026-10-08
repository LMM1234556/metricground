import type { AnalysisSpec, DatasetVersion } from "./analysis-spec";

export type TaskRunState =
  | "IDLE"
  | "DATA_PROFILED"
  | "PLANNING"
  | "NEEDS_CLARIFICATION"
  | "NEEDS_APPROVAL"
  | "READY_TO_EXECUTE"
  | "EXECUTING"
  | "VALIDATING"
  | "COMPLETED"
  | "NEEDS_REVISION"
  | "NEEDS_JOIN_REVISION"
  | "DATA_VERSION_CHANGED"
  | "UNSUPPORTED"
  | "FAILED";

export type TaskRunEvent = {
  sequence: number;
  at: string;
  from: TaskRunState | null;
  to: TaskRunState;
  reason: string;
};

export type ToolCallRecord = {
  id: string;
  tool: string;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt: string | null;
  input: Record<string, unknown>;
  outputSummary: string | null;
  error: string | null;
};

export type ApprovalType = "grain" | "quality" | "metric" | "cleaning" | "join" | "execution";

export type ApprovalRecord = {
  id: string;
  type: ApprovalType;
  decision: "approved" | "rejected";
  statement: string;
  at: string;
};

export type TaskRunFailure = {
  code: string;
  message: string;
  recoverable: boolean;
  at: string;
};

export type TaskRun = {
  id: string;
  traceId: string;
  persistenceRevision: number;
  question: string;
  state: TaskRunState;
  createdAt: string;
  updatedAt: string;
  datasetVersions: DatasetVersion[];
  analysisSpec: AnalysisSpec | null;
  plan: string[];
  toolCalls: ToolCallRecord[];
  approvals: ApprovalRecord[];
  validationSummary: string | null;
  resultSummary: string | null;
  failure: TaskRunFailure | null;
  events: TaskRunEvent[];
};

const TRANSITIONS: Record<TaskRunState, readonly TaskRunState[]> = {
  IDLE: ["DATA_PROFILED", "FAILED"],
  DATA_PROFILED: ["PLANNING", "DATA_VERSION_CHANGED", "FAILED"],
  PLANNING: ["NEEDS_CLARIFICATION", "NEEDS_APPROVAL", "READY_TO_EXECUTE", "UNSUPPORTED", "FAILED", "DATA_VERSION_CHANGED"],
  NEEDS_CLARIFICATION: ["PLANNING", "UNSUPPORTED", "FAILED", "DATA_VERSION_CHANGED"],
  NEEDS_APPROVAL: ["READY_TO_EXECUTE", "NEEDS_REVISION", "NEEDS_JOIN_REVISION", "FAILED", "DATA_VERSION_CHANGED"],
  READY_TO_EXECUTE: ["EXECUTING", "NEEDS_REVISION", "NEEDS_JOIN_REVISION", "FAILED", "DATA_VERSION_CHANGED"],
  EXECUTING: ["VALIDATING", "FAILED", "DATA_VERSION_CHANGED"],
  VALIDATING: ["COMPLETED", "NEEDS_REVISION", "NEEDS_JOIN_REVISION", "FAILED", "DATA_VERSION_CHANGED"],
  COMPLETED: ["DATA_VERSION_CHANGED"],
  NEEDS_REVISION: ["PLANNING", "NEEDS_APPROVAL", "READY_TO_EXECUTE", "FAILED", "DATA_VERSION_CHANGED"],
  NEEDS_JOIN_REVISION: ["PLANNING", "NEEDS_APPROVAL", "FAILED", "DATA_VERSION_CHANGED"],
  DATA_VERSION_CHANGED: ["DATA_PROFILED", "FAILED"],
  UNSUPPORTED: ["PLANNING", "FAILED", "DATA_VERSION_CHANGED"],
  FAILED: ["PLANNING", "DATA_PROFILED", "DATA_VERSION_CHANGED"],
};

function timestamp(now?: string) {
  return now ?? new Date().toISOString();
}

function generatedId(prefix: string) {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${random}`;
}

export function createTaskRun(input: {
  id?: string;
  traceId?: string;
  question: string;
  datasetVersions?: DatasetVersion[];
  now?: string;
}): TaskRun {
  const at = timestamp(input.now);
  const initialState: TaskRunState = input.datasetVersions?.length ? "DATA_PROFILED" : "IDLE";
  return {
    id: input.id ?? generatedId("task"),
    traceId: input.traceId ?? generatedId("trace"),
    persistenceRevision: 0,
    question: input.question.trim(),
    state: initialState,
    createdAt: at,
    updatedAt: at,
    datasetVersions: input.datasetVersions ?? [],
    analysisSpec: null,
    plan: [],
    toolCalls: [],
    approvals: [],
    validationSummary: null,
    resultSummary: null,
    failure: null,
    events: [{ sequence: 1, at, from: null, to: initialState, reason: initialState === "IDLE" ? "任务已创建，等待数据" : "任务已创建并绑定数据版本" }],
  };
}

export function canTransition(from: TaskRunState, to: TaskRunState) {
  return TRANSITIONS[from].includes(to);
}

export function transitionTaskRun(run: TaskRun, to: TaskRunState, reason: string, now?: string): TaskRun {
  if (!canTransition(run.state, to)) {
    throw new Error(`非法 Agent 状态转换：${run.state} -> ${to}`);
  }
  const at = timestamp(now);
  return {
    ...run,
    state: to,
    updatedAt: at,
    events: [...run.events, { sequence: run.events.length + 1, at, from: run.state, to, reason }],
  };
}

export function bindDatasetVersions(run: TaskRun, versions: DatasetVersion[], now?: string): TaskRun {
  if (versions.length < 1 || versions.length > 3) throw new Error("TaskRun 只能绑定 1 至 3 个数据源");
  const next = run.state === "IDLE" || run.state === "DATA_VERSION_CHANGED"
    ? transitionTaskRun(run, "DATA_PROFILED", "已读取并绑定数据版本", now)
    : run;
  return { ...next, datasetVersions: versions, updatedAt: timestamp(now) };
}

export function setTaskPlan(run: TaskRun, plan: string[], spec: AnalysisSpec | null, now?: string): TaskRun {
  if (run.state !== "PLANNING") throw new Error("只有 PLANNING 状态可以写入执行计划");
  if (plan.length === 0) throw new Error("Agent 执行计划不能为空");
  return { ...run, plan: [...plan], analysisSpec: spec, updatedAt: timestamp(now), failure: null };
}

export function attachAnalysisSpec(run: TaskRun, spec: AnalysisSpec, now?: string): TaskRun {
  if (!["PLANNING", "NEEDS_CLARIFICATION", "NEEDS_APPROVAL", "NEEDS_REVISION"].includes(run.state)) {
    throw new Error(`当前状态不能绑定 AnalysisSpec：${run.state}`);
  }
  return { ...run, analysisSpec: spec, updatedAt: timestamp(now) };
}

export function startToolCall(
  run: TaskRun,
  tool: string,
  input: Record<string, unknown>,
  options: { id?: string; now?: string } = {},
) {
  const at = timestamp(options.now);
  const call: ToolCallRecord = {
    id: options.id ?? generatedId("tool"), tool, status: "running", startedAt: at, finishedAt: null, input, outputSummary: null, error: null,
  };
  return { run: { ...run, toolCalls: [...run.toolCalls, call], updatedAt: at }, callId: call.id };
}

function updateToolCall(run: TaskRun, callId: string, update: Partial<ToolCallRecord>, now?: string) {
  if (!run.toolCalls.some((call) => call.id === callId)) throw new Error(`找不到工具调用：${callId}`);
  const at = timestamp(now);
  return {
    ...run,
    updatedAt: at,
    toolCalls: run.toolCalls.map((call) => call.id === callId ? { ...call, ...update, finishedAt: at } : call),
  };
}

export function succeedToolCall(run: TaskRun, callId: string, outputSummary: string, now?: string) {
  return updateToolCall(run, callId, { status: "succeeded", outputSummary, error: null }, now);
}

export function failToolCall(run: TaskRun, callId: string, error: string, now?: string) {
  return updateToolCall(run, callId, { status: "failed", outputSummary: null, error }, now);
}

export function recordApproval(
  run: TaskRun,
  approval: Omit<ApprovalRecord, "id" | "at"> & { id?: string; at?: string },
): TaskRun {
  if (!approval.statement.trim()) throw new Error("人工确认必须保留确认内容");
  const at = timestamp(approval.at);
  const record: ApprovalRecord = {
    id: approval.id ?? generatedId("approval"), type: approval.type, decision: approval.decision, statement: approval.statement.trim(), at,
  };
  return { ...run, approvals: [...run.approvals, record], updatedAt: at };
}

export function completeValidation(run: TaskRun, summary: string, resultSummary: string, now?: string) {
  if (run.state !== "VALIDATING") throw new Error("只有 VALIDATING 状态可以完成结果验证");
  const withResult = { ...run, validationSummary: summary, resultSummary, updatedAt: timestamp(now) };
  return transitionTaskRun(withResult, "COMPLETED", "基础校验与独立复核通过，任务完成", now);
}

export function markTaskFailure(
  run: TaskRun,
  failure: Omit<TaskRunFailure, "at"> & { at?: string },
): TaskRun {
  const at = timestamp(failure.at);
  const transitioned = run.state === "FAILED" ? run : transitionTaskRun(run, "FAILED", failure.message, at);
  return { ...transitioned, failure: { ...failure, at }, updatedAt: at };
}

export function detectDataVersionChange(run: TaskRun, actual: DatasetVersion[], now?: string): TaskRun {
  const expected = new Set(run.datasetVersions.map((version) => version.versionId));
  const unchanged = actual.length === expected.size && actual.every((version) => expected.has(version.versionId));
  if (unchanged) return run;
  if (run.state === "DATA_VERSION_CHANGED") return { ...run, datasetVersions: actual, updatedAt: timestamp(now) };
  return transitionTaskRun(run, "DATA_VERSION_CHANGED", "当前数据版本与计划绑定版本不一致，已阻止继续执行", now);
}
