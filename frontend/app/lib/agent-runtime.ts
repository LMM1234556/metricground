import type { AgentPlanResponse, AgentToolName } from "./agent-plan";
import type { AnalysisSpec } from "./analysis-spec";
import { createDatasetVersion, validateAnalysisSpec } from "./analysis-spec.ts";
import type { DatasetProfile } from "./tabular-profile";
import { capturePlanningEvidence, captureQualityEvidence, type ResultEvidence } from "./task-evidence.ts";
import {
  attachAnalysisSpec,
  completeValidation,
  createTaskRun,
  failToolCall,
  markTaskFailure,
  recordApproval,
  setTaskPlan,
  startToolCall,
  succeedToolCall,
  transitionTaskRun,
  type ApprovalType,
  type TaskRun,
} from "./task-run.ts";

function executeRecordedTool(run: TaskRun, tool: AgentToolName, input: Record<string, unknown>, output: string, now?: string) {
  const started = startToolCall(run, tool, input, { now });
  return succeedToolCall(started.run, started.callId, output, now);
}

function completeReadOnlyTask(run: TaskRun, validationSummary: string, resultSummary: string, now?: string) {
  let next = transitionTaskRun(run, "READY_TO_EXECUTE", "只读检查无需额外业务口径审批", now);
  next = transitionTaskRun(next, "EXECUTING", "执行确定性只读工具", now);
  const validation = startToolCall(next, "validate_result", { taskRunId: next.id }, { now });
  next = succeedToolCall(validation.run, validation.callId, validationSummary, now);
  next = transitionTaskRun(next, "VALIDATING", "开始验证只读检查结果", now);
  return completeValidation(next, validationSummary, resultSummary, now);
}

export function createTaskRunFromPlan(
  profile: DatasetProfile,
  question: string,
  response: AgentPlanResponse,
  options: { id?: string; now?: string; qualityDecisions?: Record<string, "approved" | "kept"> } = {},
) {
  const version = createDatasetVersion(profile);
  let run = createTaskRun({ id: options.id, question, datasetVersions: [version], now: options.now });
  run = {
    ...run,
    planningEvidence: capturePlanningEvidence(response, run.createdAt),
    qualityEvidence: captureQualityEvidence(profile, options.qualityDecisions, run.createdAt),
  };
  run = transitionTaskRun(run, "PLANNING", "Agent 开始根据问题和数据画像制定计划", options.now);
  run = setTaskPlan(run, response.plan.steps, null, options.now);
  if (response.plan.tools.includes("profile_dataset")) {
    run = executeRecordedTool(run, "profile_dataset", { versionId: version.versionId }, `${profile.rowCount} 行、${profile.columnCount} 列，候选键 ${profile.candidateKeys.length} 个`, options.now);
  }
  if (response.plan.tools.includes("run_quality_checks")) {
    run = executeRecordedTool(run, "run_quality_checks", { versionId: version.versionId }, `完成 5 类基础检查，发现 ${profile.qualityIssues.length} 项风险`, options.now);
  }
  if (response.plan.action === "unsupported") {
    return transitionTaskRun(run, "UNSUPPORTED", response.plan.clarification ?? response.plan.summary, options.now);
  }
  if (response.plan.action === "clarify") {
    return transitionTaskRun(run, "NEEDS_CLARIFICATION", response.plan.clarification ?? "需要补充业务定义", options.now);
  }
  if (response.plan.analysisType === "profile") {
    return completeReadOnlyTask(run, "数据版本、行列数和字段画像已核对", `已生成 ${profile.columnCount} 个字段的数据画像`, options.now);
  }
  if (response.plan.analysisType === "quality") {
    return completeReadOnlyTask(run, "质量规则均完成且问题证据可定位", `发现 ${profile.qualityIssues.length} 项质量风险，未修改原始数据`, options.now);
  }
  return transitionTaskRun(run, "NEEDS_APPROVAL", "执行前等待用户确认字段含义、数据粒度和业务口径", options.now);
}

export function approveTaskRun(
  run: TaskRun,
  input: { type: ApprovalType; statement: string; spec?: AnalysisSpec; now?: string },
) {
  if (input.spec) {
    const validation = validateAnalysisSpec(input.spec, run.datasetVersions);
    if (!validation.valid) throw new Error(`AnalysisSpec 未通过校验：${validation.errors.join("；")}`);
  }
  let next = run;
  if (next.state === "NEEDS_CLARIFICATION") {
    next = transitionTaskRun(next, "PLANNING", "用户已补充业务定义，重新编译执行计划", input.now);
    if (input.spec) next = setTaskPlan(next, next.plan, input.spec, input.now);
    next = transitionTaskRun(next, "NEEDS_APPROVAL", "澄清完成，等待最终执行批准", input.now);
  } else if (input.spec) {
    next = attachAnalysisSpec(next, input.spec, input.now);
  }
  if (next.state !== "NEEDS_APPROVAL") throw new Error(`当前任务不处于待审批状态：${next.state}`);
  next = recordApproval(next, { type: input.type, decision: "approved", statement: input.statement, at: input.now });
  return transitionTaskRun(next, "READY_TO_EXECUTE", "人工确认已记录，允许进入确定性执行", input.now);
}

export function rejectTaskRun(run: TaskRun, input: { type: ApprovalType; statement: string; now?: string }) {
  if (run.state !== "NEEDS_APPROVAL") throw new Error(`当前任务不处于待审批状态：${run.state}`);
  const recorded = recordApproval(run, { type: input.type, decision: "rejected", statement: input.statement, at: input.now });
  return transitionTaskRun(recorded, "NEEDS_REVISION", "用户拒绝当前方案，需要重新制定", input.now);
}

export function startTaskTool(
  run: TaskRun,
  tool: AgentToolName,
  input: Record<string, unknown>,
  options: { now?: string; callId?: string } = {},
) {
  if (run.state !== "READY_TO_EXECUTE") throw new Error(`当前任务尚未获准执行：${run.state}`);
  const executing = transitionTaskRun(run, "EXECUTING", `调用确定性工具 ${tool}`, options.now);
  return startToolCall(executing, tool, input, { id: options.callId, now: options.now });
}

export function completeTaskTool(
  run: TaskRun,
  input: {
    callId: string;
    outputSummary: string;
    validationSummary: string;
    resultSummary: string;
    validationEvidence?: Record<string, unknown>;
    resultEvidence?: ResultEvidence;
    now?: string;
  },
) {
  if (run.state !== "EXECUTING") throw new Error(`当前任务不在执行状态：${run.state}`);
  let next = succeedToolCall(run, input.callId, input.outputSummary, input.now);
  if (input.resultEvidence) next = { ...next, resultEvidence: input.resultEvidence };
  next = transitionTaskRun(next, "VALIDATING", "工具执行完成，开始基础校验与 DuckDB 独立复核", input.now);
  const validation = startToolCall(next, "validate_result", {
    taskRunId: next.id,
    ...(input.validationEvidence ?? {}),
  }, { now: input.now });
  next = succeedToolCall(validation.run, validation.callId, input.validationSummary, input.now);
  return completeValidation(next, input.validationSummary, input.resultSummary, input.now);
}

export function failTaskTool(
  run: TaskRun,
  input: { callId: string; code: string; message: string; recoverable?: boolean; now?: string },
) {
  let next = run;
  if (next.toolCalls.some((call) => call.id === input.callId && call.status === "running")) {
    next = failToolCall(next, input.callId, input.message, input.now);
  }
  return markTaskFailure(next, { code: input.code, message: input.message, recoverable: input.recoverable ?? true, at: input.now });
}

export function recordEvidenceExport(run: TaskRun, now?: string, format: "json" | "markdown" = "json") {
  const started = startToolCall(run, "export_evidence", { taskRunId: run.id, format }, { now });
  return succeedToolCall(started.run, started.callId, `已导出不含原始数据行的${format === "markdown" ? "分析报告" : "审计证据包"}`, now);
}
