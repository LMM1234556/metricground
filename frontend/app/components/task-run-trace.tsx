"use client";

import { AlertCircle, Check, CircleHelp, Download, ListChecks, LoaderCircle, ShieldCheck, Wrench } from "lucide-react";
import { buildEvidencePackage, evidenceAsJson, evidenceAsMarkdown } from "../lib/evidence-package";
import type { TaskRun, TaskRunState } from "../lib/task-run";

export type EvidenceExportFormat = "markdown" | "json";
export type EvidenceExportStatus = { taskId: string; at: string; format: EvidenceExportFormat };

const STATE_LABELS: Record<TaskRunState, string> = {
  IDLE: "等待数据",
  DATA_PROFILED: "数据已画像",
  PLANNING: "制定计划",
  NEEDS_CLARIFICATION: "等待澄清",
  NEEDS_APPROVAL: "等待批准",
  READY_TO_EXECUTE: "已批准",
  EXECUTING: "执行中",
  VALIDATING: "验证中",
  COMPLETED: "已完成",
  NEEDS_REVISION: "需要修订",
  NEEDS_JOIN_REVISION: "关联需修订",
  DATA_VERSION_CHANGED: "数据版本变化",
  UNSUPPORTED: "能力未覆盖",
  FAILED: "执行失败",
};

function stateIcon(state: TaskRunState) {
  if (state === "COMPLETED") return <Check size={14} />;
  if (["FAILED", "DATA_VERSION_CHANGED", "NEEDS_REVISION", "NEEDS_JOIN_REVISION", "UNSUPPORTED"].includes(state)) return <AlertCircle size={14} />;
  if (["EXECUTING", "VALIDATING", "PLANNING"].includes(state)) return <LoaderCircle className="spin" size={14} />;
  if (["NEEDS_APPROVAL", "NEEDS_CLARIFICATION"].includes(state)) return <CircleHelp size={14} />;
  return <ShieldCheck size={14} />;
}

type Props = {
  run: TaskRun | null;
  exportStatus?: EvidenceExportStatus | null;
  onExport?: (format: EvidenceExportFormat, at: string) => TaskRun;
  onStartNewAnalysis?: () => void;
};

function exportTimeLabel(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
}

export default function TaskRunTrace({ run, exportStatus = null, onExport, onStartNewAnalysis }: Props) {
  if (!run) return null;
  const completedTools = run.toolCalls.filter((call) => call.status !== "running");
  const currentExport = exportStatus?.taskId === run.id ? exportStatus : null;
  function downloadEvidence(format: EvidenceExportFormat) {
    const exportedAt = new Date().toISOString();
    const exportRun = onExport?.(format, exportedAt) ?? run!;
    const evidence = buildEvidencePackage(exportRun, exportedAt);
    const isMarkdown = format === "markdown";
    const content = isMarkdown ? evidenceAsMarkdown(evidence) : evidenceAsJson(evidence);
    const blob = new Blob([content], { type: `${isMarkdown ? "text/markdown" : "application/json"};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `MetricGround-${exportRun.id}-${isMarkdown ? "analysis-report.md" : "audit-evidence.json"}`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
  return (
    <section className={`task-run-trace state-${run.state.toLowerCase()}`} aria-label="Agent 任务追踪">
      <div className="task-run-heading">
        <div><ListChecks size={17} /><span><small>TaskRun · {run.id.slice(0, 18)}</small><strong>真实执行轨迹</strong></span></div>
        <div className="task-run-actions">
          <span className="task-state">{stateIcon(run.state)}{STATE_LABELS[run.state]}</span>
          {run.state !== "COMPLETED" && <button type="button" onClick={() => downloadEvidence("json")}><Download size={12} />导出当前证据</button>}
        </div>
      </div>
      <div className="task-run-stats">
        <div><span>数据版本</span><strong>{run.datasetVersions.length}</strong></div>
        <div><span>计划步骤</span><strong>{run.plan.length}</strong></div>
        <div><span>工具调用</span><strong>{run.toolCalls.length}</strong></div>
        <div><span>人工确认</span><strong>{run.approvals.length}</strong></div>
      </div>
      {completedTools.length > 0 && (
        <div className="task-tool-trace">
          {completedTools.map((call) => (
            <span className={call.status} data-tool={call.tool} data-status={call.status} key={call.id} title={call.error ?? call.outputSummary ?? ""}>
              <Wrench size={11} />{call.tool}<b>{call.status === "succeeded" ? "通过" : "失败"}</b>
            </span>
          ))}
        </div>
      )}
      {run.state === "NEEDS_CLARIFICATION" && <p className="task-run-message">需要补充业务定义；此时模型不能直接执行计算。</p>}
      {run.state === "NEEDS_APPROVAL" && <p className="task-run-message">字段含义、粒度或指标口径尚未获人工批准。</p>}
      {run.validationSummary && <p className="task-run-validation"><Check size={12} />{run.validationSummary}</p>}
      {run.failure && <p className="task-run-failure"><AlertCircle size={12} />{run.failure.code}：{run.failure.message}</p>}
      {run.state === "COMPLETED" && (
        <div className={`task-run-complete-guide${currentExport ? " exported" : ""}`} role="status">
          <div><Check size={17} /><span>
            <strong>{currentExport ? "交付文件已下载，本次分析已完成" : "验证完成，请下载交付文件"}</strong>
            <small>
              {currentExport
                ? `${currentExport.format === "markdown" ? "分析报告" : "审计证据"}已于 ${exportTimeLabel(currentExport.at)} 下载。当前任务不会自动保存到历史记录。`
                : `${run.resultSummary ?? "结果已通过验证"}。建议先下载便于阅读的分析报告，再结束或开始新的分析。`}
            </small>
          </span></div>
          <div className="task-run-complete-actions">
            <button type="button" onClick={() => downloadEvidence("markdown")}><Download size={13} />{currentExport ? "再次下载报告" : "下载报告并完成"}</button>
            <button type="button" className="secondary" onClick={() => downloadEvidence("json")}><Download size={13} />审计 JSON</button>
            {currentExport && onStartNewAnalysis && <button type="button" className="next-analysis" onClick={onStartNewAnalysis}>开始新的分析</button>}
          </div>
        </div>
      )}
    </section>
  );
}
