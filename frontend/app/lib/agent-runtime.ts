import type { AgentPlanResponse, AgentToolName } from "./agent-plan";
import type { AnalysisSpec } from "./analysis-spec";
import { createDatasetVersion, validateAnalysisSpec } from "./analysis-spec.ts";
import { requestsOriginalScope } from "./analysis-goal-guard.ts";
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
  options: { id?: string; now?: string; qualityDecisions?: Record<string, "approved" | "kept">; relatedProfiles?: DatasetProfile[] } = {},
) {
  const version = createDatasetVersion(profile);
  let run = createTaskRun({ id: options.id, question, datasetVersions: [version, ...(response.plan.analysisType === "join" ? (options.relatedProfiles ?? []).map(createDatasetVersion) : [])], now: options.now });
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
  if (run.dataScopeEvidence && requestsOriginalScope(run.question)) {
    throw new Error("原问题要求原始数据范围，不能仅勾选清洗范围后继续。请恢复原始数据，或开始新的分析明确使用清洗副本。");
  }
  if (run.dataScopeEvidence && !run.dataScopeEvidence.confirmedAt) throw new Error("清洗后的分析范围尚未确认，不能批准执行。");
  if (input.spec && run.dataScopeEvidence && input.spec.sources.find(source => source.role === "primary")?.versionId !== run.dataScopeEvidence.derived.versionId) {
    throw new Error("执行口径与已确认的清洗数据版本不一致。");
  }
  if (input.spec) {
    if (input.spec.question !== run.question) throw new Error("执行口径必须保留当前任务原问题；改变目标需要开始新的分析。");
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
  if (run.analysisSpec) {
    if (run.analysisSpec.question !== run.question) throw new Error("执行口径必须保留当前任务原问题。");
    const validation = validateAnalysisSpec(run.analysisSpec, run.datasetVersions);
    if (!validation.valid) throw new Error(`执行口径与原问题不一致：${validation.errors.join("；")}`);
  }
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
  if (run.analysisSpec) {
    if (run.analysisSpec.question !== run.question) throw new Error("执行口径必须保留当前任务原问题。");
    const validation = validateAnalysisSpec(run.analysisSpec, run.datasetVersions);
    if (!validation.valid) throw new Error(`不能将偏离原问题的任务标记完成：${validation.errors.join("；")}`);
  }
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

export function completeJoinTaskRun(run: TaskRun, derivedProfile: DatasetProfile, now?: string) {
  const derivation = derivedProfile.joinDerivationEvidence;
  if (!derivation) throw new Error("派生数据缺少关联预聚合证据，不能把关联任务标记完成");
  if (run.planningEvidence?.proposal?.analysisType !== "join") throw new Error("当前 TaskRun 不是多表关联任务，不能接收关联结果");
  const taskSourceVersionIds = [...new Set(run.datasetVersions.map((version) => version.versionId))];
  const derivationSourceVersionIds = [...new Set(derivation.sourceVersionIds)];
  if (
    taskSourceVersionIds.length !== 2
    || derivationSourceVersionIds.length !== 2
    || !taskSourceVersionIds.every((versionId) => derivationSourceVersionIds.includes(versionId))
  ) {
    throw new Error("关联结果绑定的源数据版本与当前 TaskRun 不一致");
  }
  if (derivation.selectedRightFields.length === 0) throw new Error("关联结果没有记录右表补充字段");
  if (derivation.outputRows !== derivation.leftSourceRows) throw new Error("关联结果没有保持左表粒度，不能把关联任务标记完成");
  const reconciliations = derivedProfile.joinAmountReconciliations ?? [];
  if (reconciliations.some((item) => item.status !== "balanced")) throw new Error("左表金额未守恒，不能把关联任务标记完成");

  let next = run;
  if (next.state === "NEEDS_CLARIFICATION") {
    next = transitionTaskRun(next, "PLANNING", "用户已在受控关联向导中补充键、关系、粒度和预聚合字段", now);
    next = setTaskPlan(next, next.plan, null, now);
    next = transitionTaskRun(next, "NEEDS_APPROVAL", "关联定义完整，等待最终执行批准", now);
  }
  if (next.state !== "NEEDS_APPROVAL") throw new Error(`当前任务不能接收关联完成记录：${next.state}`);
  next = recordApproval(next, {
    type: "join",
    decision: "approved",
    statement: `已确认左右键、1:N关系、Left join、左表输出粒度，以及右表字段 ${derivation.selectedRightFields.join("、")} 按键生成去重列表。`,
    at: now,
  });
  next = transitionTaskRun(next, "READY_TO_EXECUTE", "人工确认已记录，允许执行粒度保持关联", now);
  next = transitionTaskRun(next, "EXECUTING", "调用确定性工具 execute_grain_preserving_join", now);
  const execution = startToolCall(next, "execute_grain_preserving_join", {
    operation: derivation.operation,
    sourceVersionIds: derivation.sourceVersionIds,
    leftKeys: derivation.leftKeys,
    rightKeys: derivation.rightKeys,
    selectedRightFields: derivation.selectedRightFields,
    grainDescription: derivation.grainDescription,
  }, { now });
  next = succeedToolCall(execution.run, execution.callId, `${derivation.rightSourceRows} 行右表明细预聚合后，生成 ${derivation.outputRows} 行左表粒度结果`, now);
  next = transitionTaskRun(next, "VALIDATING", "关联执行完成，开始验证粒度、孤儿记录和金额守恒", now);
  const validation = startToolCall(next, "validate_join_result", {
    operation: derivation.operation,
    leftSourceRows: derivation.leftSourceRows,
    rightSourceRows: derivation.rightSourceRows,
    groupedRightKeys: derivation.groupedRightKeys,
    matchedRightKeys: derivation.matchedRightKeys,
    unmatchedLeftRows: derivation.unmatchedLeftRows,
    rightOrphanRows: derivation.rightOrphanRows,
    outputRows: derivation.outputRows,
    amountReconciliations: reconciliations,
  }, { now });
  next = succeedToolCall(validation.run, validation.callId, "输出保持左表粒度，未匹配左表记录已保留，左表金额字段对账通过", now);
  const derivedVersion = createDatasetVersion(derivedProfile);
  const datasetVersions = [...next.datasetVersions.filter((version) => version.versionId !== derivedVersion.versionId), derivedVersion];
  if (datasetVersions.length > 3) throw new Error("关联任务证据最多绑定两张源表和一张派生表");
  next = {
    ...next,
    datasetVersions,
    validationSummary: "粒度保持、孤儿记录处置、数据版本和左表金额守恒均已通过确定性校验",
    resultSummary: `已把 ${derivation.selectedRightFields.join("、")} 按关联键汇总为去重列表，并补充到 ${derivation.outputRows} 行左表记录；未匹配左表 ${derivation.unmatchedLeftRows} 行保留为空。`,
  };
  return transitionTaskRun(next, "COMPLETED", "受控关联和结构校验完成，派生数据版本已保存", now);
}

export function recordEvidenceExport(run: TaskRun, now?: string, format: "json" | "markdown" = "json") {
  const started = startToolCall(run, "export_evidence", { taskRunId: run.id, format }, { now });
  return succeedToolCall(started.run, started.callId, `已导出不含原始数据行的${format === "markdown" ? "分析报告" : "审计证据包"}`, now);
}
