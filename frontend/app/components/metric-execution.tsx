"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, Code2, DatabaseZap, Play, ShieldCheck } from "lucide-react";
import type { MetricContract } from "../lib/metric-contract";
import type { DatasetProfile } from "../lib/tabular-profile";
import type { ExecutionGate } from "../lib/execution-gate";
import {
  buildExecutionPlan, createExecutionConfig, executeMetricContract, FILTER_OPERATORS,
  type ExecutionConfig, type ExecutionResult, type FilterRule,
} from "../lib/metric-execution";

type Props = {
  contract: MetricContract | null;
  profile: DatasetProfile;
  qualityGate?: ExecutionGate;
  onExecution?: (event: MetricExecutionLifecycleEvent) => void;
  onReviewEvidence?: () => void;
};

export type MetricExecutionLifecycleEvent =
  | { type: "completed"; config: ExecutionConfig; result: ExecutionResult; contract: MetricContract }
  | { type: "failed"; config: ExecutionConfig; error: string; contract: MetricContract };

type CodeTab = "SQL" | "pandas";

export default function MetricExecution({ contract, profile, qualityGate, onExecution, onReviewEvidence }: Props) {
  const [config, setConfig] = useState<ExecutionConfig>(() => createExecutionConfig(profile));
  const [codeTab, setCodeTab] = useState<CodeTab>("SQL");
  const [result, setResult] = useState<ExecutionResult | null>(null);
  const [executionError, setExecutionError] = useState("");
  const [ratioRuleConfirmed, setRatioRuleConfirmed] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const plan = useMemo(() => contract ? buildExecutionPlan(contract, config) : null, [contract, config]);
  const amountReconciliationRisk = contract && ["amount", "average"].includes(contract.metricType) && contract.valueField
    ? profile.joinAmountReconciliations?.find((item) => item.qualifiedField === contract.valueField && item.status !== "balanced") ?? null
    : null;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void import("../lib/duckdb-verification")
        .then(({ prepareDuckDBVerification }) => prepareDuckDBVerification())
        .catch(() => undefined);
    }, 250);
    return () => window.clearTimeout(timer);
  }, []);

  function updateRule(ruleName: keyof ExecutionConfig, patch: Partial<FilterRule>) {
    setConfig((current) => ({ ...current, [ruleName]: { ...current[ruleName], ...patch } }));
    setResult(null);
    setExecutionError("");
    if (ruleName === "ratioNumerator") setRatioRuleConfirmed(false);
  }

  async function execute() {
    if (qualityGate && !qualityGate.ready) {
      setExecutionError(qualityGate.message);
      qualityGate.onReview?.();
      return;
    }
    if (!contract || !plan?.ready) {
      setExecutionError(plan?.errors.join("；") || "请先生成指标合同。");
      return;
    }
    if (contract.metricType === "ratio" && !ratioRuleConfirmed) {
      setExecutionError("请先确认结构化分子条件与指标合同中的分子定义一致。");
      return;
    }
    if (amountReconciliationRisk) {
      setExecutionError(`字段“${amountReconciliationRisk.qualifiedField}”未通过关联金额对账，不能直接${contract.metricType === "amount" ? "求和" : "求平均"}。请先回到多表关联调整粒度，或改用通过对账的数值字段。`);
      return;
    }
    try {
      const primary = executeMetricContract(contract, profile, config);
      setResult(primary);
      setExecutionError("");
      setVerifying(true);
      const { verifyMetricWithDuckDB } = await import("../lib/duckdb-verification");
      const independentVerification = await verifyMetricWithDuckDB(contract, profile, config, primary);
      const completed = { ...primary, independentVerification };
      setResult(completed);
      if (independentVerification.status === "passed") {
        onExecution?.({ type: "completed", config, result: completed, contract });
      } else {
        const message = independentVerification.status === "failed"
          ? "主计算结果与 DuckDB 独立复算不一致，任务已阻止完成。"
          : `DuckDB 独立复核未完成：${independentVerification.error ?? "未知错误"}`;
        setExecutionError(message);
        onExecution?.({ type: "failed", config, error: message, contract });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "执行失败，请检查计算条件。";
      setResult(null);
      setExecutionError(message);
      onExecution?.({ type: "failed", config, error: message, contract });
    } finally {
      setVerifying(false);
    }
  }

  if (!contract) {
    return (
      <div className="execution-locked">
        <ShieldCheck size={22} />
        <div><strong>计算执行尚未解锁</strong><p>请先在“指标口径”中完成定义并生成指标合同。系统不会绕过口径确认直接计算。</p></div>
      </div>
    );
  }

  const renderRule = (title: string, ruleName: keyof ExecutionConfig, optional: boolean) => {
    const rule = config[ruleName];
    return (
      <div className="execution-rule">
        <div className="execution-rule-heading">
          <strong>{title}</strong>
          {optional && (
            <label><input type="checkbox" checked={rule.enabled} onChange={(event) => updateRule(ruleName, { enabled: event.target.checked })} />启用</label>
          )}
        </div>
        <div className="execution-rule-grid">
          <select aria-label={`${title}字段`} value={rule.field} disabled={optional && !rule.enabled} onChange={(event) => updateRule(ruleName, { field: event.target.value })}>
            {profile.columns.map((column) => <option key={column.name}>{column.name}</option>)}
          </select>
          <select aria-label={`${title}运算符`} value={rule.operator} disabled={optional && !rule.enabled} onChange={(event) => updateRule(ruleName, { operator: event.target.value as FilterRule["operator"] })}>
            {FILTER_OPERATORS.map((operator) => <option value={operator.value} key={operator.value}>{operator.label}</option>)}
          </select>
          <input
            aria-label={`${title}比较值`}
            value={rule.value}
            disabled={(optional && !rule.enabled) || rule.operator === "not_empty"}
            onChange={(event) => updateRule(ruleName, { value: event.target.value })}
            placeholder={rule.operator === "not_empty" ? "无需填写" : "输入比较值"}
          />
        </div>
      </div>
    );
  };

  return (
    <div className="execution-workbench">
      <div className="execution-intro">
        <div><span>受控计算</span><h3>{contract.metricName}</h3><p>{contract.formula}</p></div>
        <span className="engine-badge"><DatabaseZap size={14} />主计算 + DuckDB 独立复核</span>
      </div>

      <section className="execution-config">
        <div className="execution-section-title"><strong>1. 设置结构化条件</strong><span>不执行任意自然语言代码</span></div>
        {renderRule("基础筛选（可选）", "baseFilter", true)}
        {contract.metricType === "ratio" && renderRule("比例分子条件", "ratioNumerator", false)}
        {contract.metricType === "ratio" && (
          <label className="execution-ratio-confirmation">
            <input type="checkbox" checked={ratioRuleConfirmed} onChange={(event) => { setRatioRuleConfirmed(event.target.checked); setResult(null); setExecutionError(""); }} />
            我已确认上方结构化分子条件与合同定义“{contract.formula}”一致。
          </label>
        )}
      </section>

      <section className="execution-plan">
        <div className="execution-section-title"><strong>2. 审核执行计划</strong><span>{plan?.ready ? "计划完整" : "需要补充"}</span></div>
        <ol>{plan?.steps.map((step) => <li key={step}>{step}</li>)}</ol>
        {plan && plan.errors.length > 0 && <p className="execution-plan-error"><AlertCircle size={14} />{plan.errors.join("；")}</p>}
      </section>

      {amountReconciliationRisk && (
        <div className="execution-blocker" role="alert">
          <AlertCircle size={15} />
          <div><strong>关联金额对账未通过，已阻止计算</strong><p>字段“{amountReconciliationRisk.qualifiedField}”源表合计为 {amountReconciliationRisk.sourceTotal.toLocaleString("zh-CN", { maximumFractionDigits: 4 })}，关联后为 {amountReconciliationRisk.outputTotal.toLocaleString("zh-CN", { maximumFractionDigits: 4 })}；重复 {amountReconciliationRisk.duplicatedSourceRows} 行，排除 {amountReconciliationRisk.excludedSourceRows} 行。</p></div>
        </div>
      )}

      {qualityGate && !qualityGate.ready && (
        <div className="execution-blocker quality-execution-blocker" role="alert">
          <AlertCircle size={15} /><div><strong>质量风险尚未完成判断，已阻止执行</strong><p>{qualityGate.message}</p><button type="button" onClick={qualityGate.onReview}>去处理质量风险</button></div>
        </div>
      )}

      <section className="execution-code">
        <div className="execution-code-heading">
          <div><Code2 size={15} /><strong>等价代码</strong><span>用于复核和迁移，当前预览由本地确定性引擎执行</span></div>
          <div className="execution-code-tabs">
            {(["SQL", "pandas"] as CodeTab[]).map((tab) => <button type="button" className={codeTab === tab ? "active" : ""} onClick={() => setCodeTab(tab)} key={tab}>{tab}</button>)}
          </div>
        </div>
        <pre>{codeTab === "SQL" ? plan?.sql : plan?.pandas}</pre>
      </section>

      {executionError && <div className="execution-error" role="alert"><AlertCircle size={15} />{executionError}</div>}
      <div className="execution-approval">
        <div><strong>执行范围：{profile.rowCount.toLocaleString("zh-CN")} 行本地数据</strong><span>只读计算，不修改或上传原文件；筛选参数不会拼接为任意 SQL。</span></div>
        <button type="button" onClick={execute} disabled={verifying || !plan?.ready || Boolean(amountReconciliationRisk) || Boolean(qualityGate && !qualityGate.ready) || (contract.metricType === "ratio" && !ratioRuleConfirmed)}><Play size={15} />{verifying ? "DuckDB 复核中…" : "批准并执行预览"}</button>
      </div>

      {result && (
        <section className="execution-result" id="metric-execution-result" aria-label="受控计算结果">
          <div className="execution-result-main">
            <span>计算结果</span><strong>{result.displayValue}</strong><small>{contract.metricName} · {result.eligibleRows} 行进入计算</small>
          </div>
          <div className="execution-result-details">
            <div><span>源数据行</span><strong>{result.sourceRows}</strong></div>
            <div><span>参与计算行</span><strong>{result.eligibleRows}</strong></div>
            <div><span>去重对象数</span><strong>{result.distinctEntities}</strong></div>
            <div><span>无效数值</span><strong>{result.excludedInvalidValues}</strong></div>
          </div>
          <div className="execution-checks">
            {result.checks.map((check) => (
              <div className={check.passed ? "passed" : "failed"} title={check.detail} key={check.label}>
                {check.passed ? <Check size={13} /> : <AlertCircle size={13} />}<span>{check.label}</span><strong>{check.passed ? "通过" : "失败"}</strong>
              </div>
            ))}
          </div>
          <div className={`independent-verification ${result.independentVerification?.status ?? (verifying ? "running" : "pending")}`}>
            <div>
              <DatabaseZap size={16} />
              <strong>DuckDB 独立 SQL 复核</strong>
              <span>{verifying ? "正在从同一数据版本独立复算…" : result.independentVerification?.status === "passed" ? "已通过" : result.independentVerification?.status === "failed" ? "结果不一致" : result.independentVerification?.status === "error" ? "复核失败" : "等待复核"}</span>
            </div>
            {result.independentVerification && (
              <>
                <small>DuckDB-WASM {result.independentVerification.engineVersion} · 数据版本 {result.independentVerification.datasetVersionId} · {result.independentVerification.durationMs}ms</small>
                {result.independentVerification.checks.map((check) => <p className={check.passed ? "passed" : "failed"} title={check.detail} key={check.label}>{check.passed ? <Check size={13} /> : <AlertCircle size={13} />}{check.label}</p>)}
                {result.independentVerification.error && <p className="failed"><AlertCircle size={13} />{result.independentVerification.error}</p>}
                <details><summary>查看独立复核 SQL</summary><pre>{result.independentVerification.query}</pre></details>
              </>
            )}
          </div>
          {result.warnings.map((warning) => <p className="execution-warning" key={warning}><AlertCircle size={13} />{warning}</p>)}
          <div className="execution-result-next">
            <div>
              <strong>{result.checks.every((check) => check.passed) && result.independentVerification?.status === "passed" ? "计算完成，基础校验与独立复核均已通过" : "计算完成，但验证尚未全部通过"}</strong>
              <span>下一步查看 Agent 任务轨迹，核对数据版本、人工确认、工具调用和验证结论。</span>
            </div>
            <button type="button" onClick={onReviewEvidence}>下一步：查看验证证据</button>
          </div>
        </section>
      )}
    </div>
  );
}
