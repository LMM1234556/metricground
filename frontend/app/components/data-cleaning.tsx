"use client";

import { useMemo, useState } from "react";
import { AlertCircle, Check, ChevronRight, FileDown, RefreshCcw, ShieldCheck, Sparkles } from "lucide-react";
import {
  applyCleaningPlan, CleaningReceipt, profileAsCsv,
} from "../lib/data-cleaning";
import type { DatasetProfile } from "../lib/tabular-profile";

type Props = {
  profile: DatasetProfile;
  originalProfile: DatasetProfile;
  decisions: Record<string, "approved" | "kept">;
  receipt: CleaningReceipt | null;
  onApply: (profile: DatasetProfile, receipt: CleaningReceipt) => void;
  onRestore: () => void;
  onSkip: () => void;
};

export default function DataCleaning({
  profile, originalProfile, decisions, receipt, onApply, onRestore, onSkip,
}: Props) {
  const repairableIssues = profile.qualityIssues.filter((issue) => issue.supportedRepair);
  const reviewOnlyIssues = profile.qualityIssues.filter((issue) => !issue.supportedRepair);
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    repairableIssues.filter((issue) => decisions[issue.id] === "approved").map((issue) => issue.id),
  );
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const preview = useMemo(() => {
    if (selectedIds.length === 0) return null;
    try {
      return applyCleaningPlan(profile, selectedIds);
    } catch {
      return null;
    }
  }, [profile, selectedIds]);
  const skippedOutlierRecheck = preview?.cleanedProfile.qualityChecksSkipped
    .filter((item) => item.check === "异常值") ?? [];

  function toggleIssue(issueId: string) {
    setSelectedIds((current) => current.includes(issueId)
      ? current.filter((id) => id !== issueId)
      : [...current, issueId]);
    setConfirmed(false);
    setError("");
  }

  function applyPlan() {
    if (!confirmed) return;
    try {
      const result = applyCleaningPlan(profile, selectedIds);
      onApply(result.cleanedProfile, result.receipt);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "清洗方案无法执行。");
    }
  }

  function downloadCleanedCopy() {
    const content = `\uFEFF${profileAsCsv(profile)}`;
    const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = profile.fileName.endsWith(".csv") ? profile.fileName : `${profile.fileName}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="cleaning-workbench">
      <div className="cleaning-intro">
        <div>
          <span>清洗方案与二次确认</span>
          <h3>先预览影响，再生成派生副本</h3>
          <p>这里只执行可解释、可复核的规则。异常值和疑似主键重复不会被自动删除，原始文件始终保留。</p>
        </div>
        <div className="cleaning-flow"><span className="done">检查</span><span className="active">确认</span><span>副本</span><span>复检</span></div>
      </div>

      {!receipt && selectedIds.length === 0 && (
        <section className="cleaning-skip-guide" role="status">
          <div>
            <Check size={16} />
            <span><strong>当前没有批准任何自动清洗规则</strong><small>“确认已核实”只记录字段粒度或异常解释，不代表授权删除数据。你可以直接进入指标口径。</small></span>
          </div>
          <button type="button" onClick={onSkip}>跳过清洗，进入指标口径<ChevronRight size={14} /></button>
        </section>
      )}

      {receipt && profile.fileName === receipt.derivedFileName && (
        <section className="cleaning-receipt" aria-label="清洗完成凭证">
          <div className="cleaning-receipt-heading">
            <div><Check size={15} /><span><strong>清洗副本已生成并复检</strong><small>{receipt.derivedFileName}</small></span></div>
            <div className="cleaning-receipt-actions">
              <button type="button" onClick={downloadCleanedCopy}><FileDown size={14} />下载清洗副本</button>
              <button type="button" onClick={onRestore}><RefreshCcw size={14} />恢复原始数据</button>
            </div>
          </div>
          <div className="cleaning-reconcile">
            <div><span>数据行</span><strong>{receipt.sourceRows} → {receipt.resultRows}</strong></div>
            <div><span>移除记录</span><strong>{receipt.removedRows}</strong></div>
            <div><span>已发现问题</span><strong>{receipt.issuesBefore} → {receipt.issuesAfter}</strong></div>
            <div><span>原文件</span><strong>未覆盖</strong></div>
          </div>
          <ul>{receipt.actions.map((action) => <li key={action.issueId}>{action.actionLabel}：移除 {action.affectedRows} 行</li>)}</ul>
        </section>
      )}

      {repairableIssues.length > 0 ? (
        <section className="cleaning-options">
          <div className="cleaning-section-heading"><strong>1. 选择可执行规则</strong><span>默认只勾选你在质量检查中批准的项目</span></div>
          {repairableIssues.map((issue) => (
            <label className="cleaning-option" key={issue.id}>
              <input type="checkbox" checked={selectedIds.includes(issue.id)} onChange={() => toggleIssue(issue.id)} />
              <span>
                <strong>{issue.title}</strong>
                <small>{issue.supportedRepair === "deduplicate_exact"
                  ? "移除完全重复副本，保留首次出现的记录"
                  : issue.supportedRepair === "drop_missing"
                    ? `删除“${issue.field}”缺失的记录`
                    : `删除“${issue.field}”无法识别为日期的记录`}</small>
              </span>
              <em>{issue.severity}风险</em>
            </label>
          ))}
        </section>
      ) : (
        <div className="quality-empty"><Check size={19} /><div><strong>没有待执行的标准清洗规则</strong><p>可以直接进入指标口径；仍需人工确认业务粒度和口径边界。</p></div></div>
      )}

      {reviewOnlyIssues.length > 0 && (
        <section className="cleaning-review-only">
          <div className="cleaning-section-heading"><strong>仅人工复核，不自动处理</strong><span>{reviewOnlyIssues.length} 项</span></div>
          {reviewOnlyIssues.map((issue) => <p key={issue.id}><AlertCircle size={14} /><span><strong>{issue.title}</strong>：{issue.recommendation}</span></p>)}
        </section>
      )}

      {repairableIssues.length > 0 && (
        <section className="cleaning-confirm">
          <div className="cleaning-section-heading"><strong>2. 核对预计影响</strong><span>执行后将自动重新运行质量检查</span></div>
          <div className="cleaning-preview-stats">
            <div><span>当前数据</span><strong>{profile.rowCount} 行</strong></div>
            <div><span>预计移除</span><strong>{preview?.receipt.removedRows ?? 0} 行</strong></div>
            <div><span>副本结果</span><strong>{preview?.receipt.resultRows ?? profile.rowCount} 行</strong></div>
            <div><span>预计发现问题</span><strong>{profile.qualityIssues.length} → {preview?.cleanedProfile.qualityIssues.length ?? profile.qualityIssues.length}</strong></div>
          </div>
          {skippedOutlierRecheck.length > 0 && (
            <div className="cleaning-preview-warning" role="status">
              <AlertCircle size={14} />清洗后“{skippedOutlierRecheck.map((item) => item.field).join("、")}”的 IQR 异常检查将不运行；问题数减少不代表异常值已解决。
            </div>
          )}
          <label className="cleaning-second-confirm">
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            <span><ShieldCheck size={15} /><strong>我确认按以上规则生成新的 CSV 派生副本，不覆盖“{originalProfile.fileName}”。</strong></span>
          </label>
          {error && <div className="cleaning-error"><AlertCircle size={15} />{error}</div>}
          <div className="cleaning-submit-row">
            <span>执行后，指标合同和受控计算会切换到清洗后的数据版本。</span>
            <button type="button" disabled={!confirmed || !preview} onClick={applyPlan}><Sparkles size={15} />二次确认并生成清洗副本</button>
          </div>
        </section>
      )}
    </div>
  );
}
