"use client";

import { useMemo, useState } from "react";
import { AlertCircle, Check, ChevronRight, FileDown, RefreshCcw, ShieldCheck, Sparkles } from "lucide-react";
import {
  applyCleaningPlan, CleaningReceipt, profileAsCsv,
} from "../lib/data-cleaning";
import type { DatasetProfile } from "../lib/tabular-profile";
import type { QualityImpactSummary } from "../lib/quality-impact";

type Props = {
  profile: DatasetProfile;
  originalProfile: DatasetProfile;
  decisions: Record<string, "approved" | "kept">;
  receipt: CleaningReceipt | null;
  onApply: (profile: DatasetProfile, receipt: CleaningReceipt) => void;
  onRestore: () => void;
  onSkip: () => void;
  nextLabel?: string;
  qualityImpact?: QualityImpactSummary | null;
  entityField?: string;
  scopeConfirmed?: boolean;
  analysisQuestion?: string;
};

export default function DataCleaning({
  profile, originalProfile, decisions, receipt, onApply, onRestore, onSkip, nextLabel = "指标口径", qualityImpact, entityField, scopeConfirmed = false, analysisQuestion = "",
}: Props) {
  const repairableIssues = profile.qualityIssues.filter((issue) => issue.supportedRepair);
  const reviewOnlyIssues = profile.qualityIssues.filter((issue) => !issue.supportedRepair);
  const defaultSelectedIds = repairableIssues
    .filter((issue) => decisions[issue.id] === "approved" && qualityImpact?.items.find(item => item.issueId === issue.id)?.level !== "unrelated")
    .map((issue) => issue.id);
  const reviewScope = JSON.stringify([
    profile.fileName,
    profile.fileSize,
    profile.rowCount,
    profile.columnCount,
    profile.qualityIssues.map(issue => [issue.id, issue.supportedRepair]),
    analysisQuestion,
    entityField,
    qualityImpact?.items.map(item => [item.issueId, item.level]),
  ]);
  const [selection, setSelection] = useState<{ scope: string; ids: string[] }>(() => ({ scope: reviewScope, ids: defaultSelectedIds }));
  const selectedIds = selection.scope === reviewScope ? selection.ids : defaultSelectedIds;
  const selectionKey = selectedIds.join("\u001f");
  const [confirmation, setConfirmation] = useState<{ scope: string; selectionKey: string } | null>(null);
  const confirmed = confirmation?.scope === reviewScope && confirmation.selectionKey === selectionKey;
  const [errorState, setErrorState] = useState<{ scope: string; message: string } | null>(null);
  const error = errorState?.scope === reviewScope ? errorState.message : "";
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
  const impactById = new Map(qualityImpact?.items.map(item => [item.issueId, item]) ?? []);
  const selectedUnrelated = selectedIds.map(id => impactById.get(id)).filter(item => item?.level === "unrelated");
  const excludedDefaults = repairableIssues.filter(issue => decisions[issue.id] === "approved" && impactById.get(issue.id)?.level === "unrelated");
  const beforeEntities = profile.columns.find(column => column.name === entityField)?.uniqueCount;
  const afterEntities = preview?.cleanedProfile.columns.find(column => column.name === entityField)?.uniqueCount ?? beforeEntities;
  function toggleIssue(issueId: string) {
    setSelection({
      scope: reviewScope,
      ids: selectedIds.includes(issueId)
        ? selectedIds.filter((id) => id !== issueId)
        : [...selectedIds, issueId],
    });
    setConfirmation(null);
    setErrorState(null);
  }

  function applyPlan() {
    if (!confirmed) return;
    try {
      const result = applyCleaningPlan(profile, selectedIds);
      onApply(result.cleanedProfile, result.receipt);
    } catch (caught) {
      setErrorState({ scope: reviewScope, message: caught instanceof Error ? caught.message : "清洗方案无法执行。" });
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
          <p>先看问题是否影响当前指标，再决定处理。通用建议不是必选项；格式转换或核实补全应优先于删行。这里只提供下面列出的删行规则，原始文件始终保留。</p>
        </div>
        <div className="cleaning-flow"><span className="done">检查</span><span className="active">确认</span><span>副本</span><span>复检</span></div>
      </div>

      {!receipt && (
        <section className="cleaning-skip-guide" role="status">
          <div>
            <Check size={16} />
            <span><strong>{selectedIds.length ? "你仍可以保留当前数据" : "当前未选择执行清洗规则"}</strong><small>质量检查需要记录判断；是否删行取决于当前指标。此入口会把已批准的可执行清洗项改为保留原样，并继续确认原分析任务。</small></span>
          </div>
          <button type="button" onClick={onSkip}>保留当前数据，进入{nextLabel}<ChevronRight size={14} /></button>
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
          <div className="cleaning-section-heading"><strong>1. 选择可执行规则</strong><span>已批准且与当前口径有关的规则才默认勾选</span></div>
          {excludedDefaults.length > 0 && <p className="cleaning-preview-warning" role="status"><AlertCircle size={14} />{excludedDefaults.length} 项已批准规则按当前{scopeConfirmed ? "口径" : "候选口径"}可保留，本页未默认勾选。请核对字段与业务目的后决定。</p>}
          {repairableIssues.map((issue) => (
            <label className="cleaning-option" key={issue.id}>
              <input type="checkbox" checked={selectedIds.includes(issue.id)} onChange={() => toggleIssue(issue.id)} />
              <span>
                <strong>{issue.title}</strong>
                {impactById.get(issue.id) && <small><span className={`quality-impact-badge ${impactById.get(issue.id)!.level}`}>{impactById.get(issue.id)!.label}</span> {impactById.get(issue.id)!.reason}</small>}
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
            {beforeEntities !== undefined && <div><span>{entityField} 非空去重数量</span><strong>{beforeEntities} → {afterEntities}</strong></div>}
          </div>
          {selectedUnrelated.length > 0 && <p className="cleaning-preview-warning" role="alert"><AlertCircle size={14} />已选 {selectedUnrelated.length} 项按当前口径可保留的删行规则。它们可能删除仍可参与统计的订单；例如客户编号缺失或日期无法识别，不一定影响不含时间筛选的订单成功率。</p>}
          {preview && <p className="cleaning-preview-warning" role="status"><AlertCircle size={14} />删行会改变“全部订单”的范围。问题数减少不等于答案更可靠；请核对业务对象数量及分子分母，而不只看剩余行数。</p>}
          {skippedOutlierRecheck.length > 0 && (
            <div className="cleaning-preview-warning" role="status">
              <AlertCircle size={14} />清洗后“{skippedOutlierRecheck.map((item) => item.field).join("、")}”的 IQR 异常检查将不运行；问题数减少不代表异常值已解决。
            </div>
          )}
          <label className="cleaning-second-confirm">
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmation(event.target.checked ? { scope: reviewScope, selectionKey } : null)} />
            <span><ShieldCheck size={15} /><strong>我确认这些处理适合当前分析；预计移除 {preview?.receipt.removedRows ?? 0} 行，后续统计使用清洗后的范围，并生成副本保留“{originalProfile.fileName}”。</strong></span>
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
