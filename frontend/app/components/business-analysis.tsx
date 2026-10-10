"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertCircle, BarChart3, Check, Code2, DatabaseZap, Play, ShieldCheck } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { AgentPlan } from "../lib/agent-plan";
import {
  AGGREGATIONS, ANALYSIS_TYPES, buildBusinessAnalysisPlan, createBusinessAnalysisConfig,
  executeBusinessAnalysis, type BusinessAnalysisConfig, type BusinessAnalysisResult,
} from "../lib/business-analysis";
import type { DatasetProfile } from "../lib/tabular-profile";
import type { ExecutionGate } from "../lib/execution-gate";

type Props = {
  profile: DatasetProfile;
  agentPlan: AgentPlan | null;
  question: string;
  qualityGate?: ExecutionGate;
  onExecution?: (event: BusinessAnalysisLifecycleEvent) => void;
};

export type BusinessAnalysisLifecycleEvent =
  | { type: "completed"; config: BusinessAnalysisConfig; result: BusinessAnalysisResult }
  | { type: "failed"; config: BusinessAnalysisConfig; error: string };

type CodeTab = "SQL" | "pandas";

export default function BusinessAnalysis({ profile, agentPlan, question, qualityGate, onExecution }: Props) {
  const [config, setConfig] = useState<BusinessAnalysisConfig>(() => createBusinessAnalysisConfig(profile, agentPlan, question));
  const [confirmed, setConfirmed] = useState(false);
  const [result, setResult] = useState<BusinessAnalysisResult | null>(null);
  const [executionError, setExecutionError] = useState("");
  const [codeTab, setCodeTab] = useState<CodeTab>("SQL");
  const [verifying, setVerifying] = useState(false);
  const plan = useMemo(() => buildBusinessAnalysisPlan(profile, config), [profile, config]);
  const numericColumns = profile.columns.filter((column) => column.inferredType === "数值");
  const dateColumns = profile.columns.filter((column) => column.inferredType === "日期" || /date|time|日期|时间/i.test(column.name));
  const amountReconciliationRisk = config.aggregation !== "count_distinct" && config.valueField
    ? profile.joinAmountReconciliations?.find((item) => item.qualifiedField === config.valueField && item.status !== "balanced") ?? null
    : null;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void import("../lib/duckdb-verification")
        .then(({ prepareDuckDBVerification }) => prepareDuckDBVerification())
        .catch(() => undefined);
    }, 250);
    return () => window.clearTimeout(timer);
  }, []);

  function update<K extends keyof BusinessAnalysisConfig>(key: K, value: BusinessAnalysisConfig[K]) {
    setConfig((current) => ({ ...current, [key]: value }));
    setConfirmed(false);
    setResult(null);
    setExecutionError("");
  }

  async function execute() {
    if (qualityGate && !qualityGate.ready) {
      setExecutionError(qualityGate.message);
      qualityGate.onReview?.();
      return;
    }
    if (!confirmed) {
      setExecutionError("请先确认字段业务含义、统计对象和聚合口径。");
      return;
    }
    if (!plan.ready) {
      setExecutionError(plan.errors.join("；"));
      return;
    }
    if (amountReconciliationRisk) {
      setExecutionError(`字段“${amountReconciliationRisk.qualifiedField}”未通过关联金额对账，不能直接聚合。请调整关联粒度或选择通过对账的数值字段。`);
      return;
    }
    try {
      const primary = executeBusinessAnalysis(profile, config);
      setResult(primary);
      setExecutionError("");
      setVerifying(true);
      const { verifyBusinessAnalysisWithDuckDB } = await import("../lib/duckdb-verification");
      const independentVerification = await verifyBusinessAnalysisWithDuckDB(profile, config, primary);
      const completed = { ...primary, independentVerification };
      setResult(completed);
      if (independentVerification.status === "passed") {
        onExecution?.({ type: "completed", config, result: completed });
      } else {
        const message = independentVerification.status === "failed"
          ? "经营分析结果与 DuckDB 独立复算不一致，任务已阻止完成。"
          : `DuckDB 独立复核未完成：${independentVerification.error ?? "未知错误"}`;
        setExecutionError(message);
        onExecution?.({ type: "failed", config, error: message });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "执行失败，请检查字段和口径。 ";
      setResult(null);
      setExecutionError(message);
      onExecution?.({ type: "failed", config, error: message });
    } finally {
      setVerifying(false);
    }
  }

  const resultLabel = config.aggregation === "count_distinct" ? `去重 ${config.entityField}`
    : config.aggregation === "sum" ? `${config.valueField} 合计`
      : `${config.valueField} / 去重 ${config.entityField}`;

  return (
    <div className="business-analysis-workbench">
      <div className="business-analysis-intro">
        <div><span>通用经营分析工具</span><h3>从分组、趋势到 Top N</h3><p>Agent 绑定候选字段；你确认业务含义后，由本地确定性引擎执行并验证。</p></div>
        <span className="engine-badge"><DatabaseZap size={14} />主计算 + DuckDB 独立复核</span>
      </div>

      <section className="business-analysis-config">
        <div className="execution-section-title"><strong>1. 确认分析任务</strong><span>字段变化后需要重新确认</span></div>
        <div className="business-analysis-types">
          {ANALYSIS_TYPES.map((item) => (
            <button type="button" key={item.value} className={config.analysisType === item.value ? "active" : ""} onClick={() => update("analysisType", item.value)}>
              <strong>{item.label}</strong><span>{item.description}</span>
            </button>
          ))}
        </div>
        <div className="business-analysis-fields">
          <label><span>聚合口径 *</span><select aria-label="聚合口径" value={config.aggregation} onChange={(event) => update("aggregation", event.target.value as BusinessAnalysisConfig["aggregation"])}>{AGGREGATIONS.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label>
          <label><span>统计对象/去重字段 *</span><select aria-label="统计对象字段" value={config.entityField} onChange={(event) => update("entityField", event.target.value)}><option value="">请选择字段</option>{profile.columns.map((column) => <option key={column.name}>{column.name}</option>)}</select></label>
          {config.aggregation !== "count_distinct" && <label><span>数值字段 *</span><select aria-label="数值字段" value={config.valueField} onChange={(event) => update("valueField", event.target.value)}><option value="">请选择数值字段</option>{numericColumns.map((column) => <option key={column.name}>{column.name}</option>)}</select></label>}
          {config.analysisType === "trend" ? (
            <>
              <label><span>时间字段 *</span><select aria-label="时间字段" value={config.timeField} onChange={(event) => update("timeField", event.target.value)}><option value="">请选择时间字段</option>{dateColumns.map((column) => <option key={column.name}>{column.name}</option>)}</select></label>
              <label><span>时间粒度 *</span><select aria-label="时间粒度" value={config.timeGrain} onChange={(event) => update("timeGrain", event.target.value as BusinessAnalysisConfig["timeGrain"])}><option value="day">日</option><option value="week">周</option><option value="month">月</option><option value="quarter">季度</option></select></label>
            </>
          ) : (
            <label><span>分组字段 *</span><select aria-label="分组字段" value={config.groupField} onChange={(event) => update("groupField", event.target.value)}><option value="">请选择分组字段</option>{profile.columns.map((column) => <option key={column.name}>{column.name}</option>)}</select></label>
          )}
          {config.analysisType === "top_n" && <label><span>排名数量 N *</span><input aria-label="排名数量" type="number" min={1} max={50} value={config.limit} onChange={(event) => update("limit", Number(event.target.value))} /></label>}
          {config.analysisType !== "trend" && <label><span>排序方向</span><select aria-label="排序方向" value={config.sortDirection} onChange={(event) => update("sortDirection", event.target.value as BusinessAnalysisConfig["sortDirection"])}><option value="desc">从高到低</option><option value="asc">从低到高</option></select></label>}
        </div>
        <label className="business-analysis-confirmation">
          <input type="checkbox" checked={confirmed} onChange={(event) => { setConfirmed(event.target.checked); setResult(null); setExecutionError(""); }} />
          <ShieldCheck size={15} /><span><strong>我已确认分析口径</strong>：一行数据的含义、统计对象、聚合方式及分组/时间字段符合本次业务问题。</span>
        </label>
      </section>

      <section className="execution-plan">
        <div className="execution-section-title"><strong>2. 审核 Agent 执行计划</strong><span>{plan.ready ? "计划完整" : "需要补充"}</span></div>
        <ol>{plan.steps.map((step) => <li key={step}>{step}</li>)}</ol>
        {plan.errors.length > 0 && <p className="execution-plan-error"><AlertCircle size={14} />{plan.errors.join("；")}</p>}
      </section>

      {amountReconciliationRisk && (
        <div className="execution-blocker" role="alert">
          <AlertCircle size={15} /><div><strong>关联金额对账未通过，已阻止分析</strong><p>“{amountReconciliationRisk.qualifiedField}”源表合计 {amountReconciliationRisk.sourceTotal.toLocaleString("zh-CN", { maximumFractionDigits: 4 })}，关联后 {amountReconciliationRisk.outputTotal.toLocaleString("zh-CN", { maximumFractionDigits: 4 })}；请先修正粒度或改用安全字段。</p></div>
        </div>
      )}

      {qualityGate && !qualityGate.ready && (
        <div className="execution-blocker quality-execution-blocker" role="alert">
          <AlertCircle size={15} /><div><strong>质量风险尚未完成判断，已阻止执行</strong><p>{qualityGate.message}</p><button type="button" onClick={qualityGate.onReview}>去处理质量风险</button></div>
        </div>
      )}

      <section className="execution-code">
        <div className="execution-code-heading">
          <div><Code2 size={15} /><strong>等价代码</strong><span>用于复核与迁移；页面不执行任意自然语言代码</span></div>
          <div className="execution-code-tabs">{(["SQL", "pandas"] as CodeTab[]).map((tab) => <button type="button" className={codeTab === tab ? "active" : ""} onClick={() => setCodeTab(tab)} key={tab}>{tab}</button>)}</div>
        </div>
        <pre>{codeTab === "SQL" ? plan.sql : plan.pandas}</pre>
      </section>

      {executionError && <div className="execution-error" role="alert"><AlertCircle size={15} />{executionError}</div>}
      <div className="execution-approval">
        <div><strong>执行范围：{profile.rowCount.toLocaleString("zh-CN")} 行本地数据</strong><span>只读分析；无效值会被排除并计数，不会静默当作 0。</span></div>
        <button type="button" onClick={execute} disabled={verifying || !plan.ready || !confirmed || Boolean(amountReconciliationRisk) || Boolean(qualityGate && !qualityGate.ready)}><Play size={15} />{verifying ? "DuckDB 复核中…" : "批准并执行分析"}</button>
      </div>

      {result && (
        <section className="business-analysis-result" aria-label="经营分析结果">
          <div className="business-result-heading"><div><span>确定性计算结果</span><h3>{resultLabel}</h3></div><div><BarChart3 size={16} />{result.rows.length} 个结果</div></div>
          <div className="business-result-stats">
            <div><span>源数据行</span><strong>{result.sourceRows}</strong></div>
            <div><span>进入分组</span><strong>{result.eligibleRows}</strong></div>
            <div><span>排除分组/日期</span><strong>{result.excludedGroupingRows}</strong></div>
            <div><span>无效数值</span><strong>{result.excludedInvalidValues}</strong></div>
          </div>
          <div className="business-result-chart">
            <ResponsiveContainer width="100%" height="100%">
              {config.analysisType === "trend" ? (
                <LineChart data={result.rows} margin={{ top: 12, right: 12, left: 0, bottom: 6 }}><CartesianGrid stroke="#e7edf5" vertical={false} /><XAxis dataKey="key" tick={{ fontSize: 10 }} /><YAxis tick={{ fontSize: 10 }} width={48} /><Tooltip /><Line type="monotone" dataKey="value" stroke="#2563eb" strokeWidth={2.5} dot={{ r: 3 }} /></LineChart>
              ) : (
                <BarChart data={result.rows} margin={{ top: 12, right: 12, left: 0, bottom: 6 }}><CartesianGrid stroke="#e7edf5" vertical={false} /><XAxis dataKey="key" tick={{ fontSize: 10 }} /><YAxis tick={{ fontSize: 10 }} width={48} /><Tooltip /><Bar dataKey="value" fill="#2563eb" radius={[5, 5, 0, 0]} /></BarChart>
              )}
            </ResponsiveContainer>
          </div>
          <div className="business-result-table-wrap"><table className="business-result-table"><thead><tr><th>{config.analysisType === "trend" ? "时间" : "分组"}</th><th>指标值</th><th>源行数</th><th>去重对象</th><th>无效数值</th></tr></thead><tbody>{result.rows.map((row) => <tr key={row.key}><td><strong>{row.key}</strong></td><td>{row.value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}</td><td>{row.sourceRows}</td><td>{row.distinctEntities}</td><td>{row.excludedInvalidValues}</td></tr>)}</tbody></table></div>
          <div className="execution-checks">{result.checks.map((check) => <div className={check.passed ? "passed" : "failed"} title={check.detail} key={check.label}>{check.passed ? <Check size={13} /> : <AlertCircle size={13} />}<span>{check.label}</span><strong>{check.passed ? "通过" : "失败"}</strong></div>)}</div>
          <div className={`independent-verification ${result.independentVerification?.status ?? (verifying ? "running" : "pending")}`}>
            <div><DatabaseZap size={16} /><strong>DuckDB 独立 SQL 复核</strong><span>{verifying ? "独立复算中…" : result.independentVerification?.status === "passed" ? "已通过" : result.independentVerification?.status === "failed" ? "结果不一致" : result.independentVerification?.status === "error" ? "复核失败" : "等待复核"}</span></div>
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
        </section>
      )}
    </div>
  );
}
