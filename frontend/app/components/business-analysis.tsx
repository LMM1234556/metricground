"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertCircle, BarChart3, Check, Code2, DatabaseZap, Play, ShieldCheck } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { AgentPlan } from "../lib/agent-plan";
import {
  AGGREGATIONS, ANALYSIS_TYPES, buildBusinessAnalysisPlan, createBusinessAnalysisConfig,
  executeBusinessAnalysis, type BusinessAnalysisConfig, type BusinessAnalysisResult,
  ratioConditionLabel,
} from "../lib/business-analysis";
import type { FilterRule } from "../lib/metric-execution";
import type { DatasetProfile } from "../lib/tabular-profile";
import type { ExecutionGate } from "../lib/execution-gate";

type Props = {
  profile: DatasetProfile;
  agentPlan: AgentPlan | null;
  question: string;
  qualityGate?: ExecutionGate;
  onExecution?: (event: BusinessAnalysisLifecycleEvent) => void;
  initialConfig?: BusinessAnalysisConfig;
  onConfigChange?: (config: BusinessAnalysisConfig, confirmed: boolean) => void;
};

export type BusinessAnalysisLifecycleEvent =
  | { type: "completed"; config: BusinessAnalysisConfig; result: BusinessAnalysisResult }
  | { type: "failed"; config: BusinessAnalysisConfig; error: string };

type CodeTab = "SQL" | "pandas";

function RatioFilter({ profile, label, rule, onChange }: { profile: DatasetProfile; label: string; rule: FilterRule; onChange: (rule: FilterRule) => void }) {
  const values = [...new Set(profile.records.map(row => row[rule.field]).filter((value): value is string => typeof value === "string" && !["", "null", "undefined", "__null__"].includes(value.trim().toLowerCase())).map(value => value.trim()))].slice(0, 100);
  return <>
    <label><span>{label}状态字段 *</span><select aria-label={`${label}状态字段`} value={rule.field} onChange={event => onChange({ ...rule, field: event.target.value, value: "" })}><option value="">请选择状态字段</option>{profile.columns.filter(column => column.inferredType === "文本").map(column => <option key={column.name}>{column.name}</option>)}</select></label>
    <label><span>{label}条件 *</span><select aria-label={`${label}条件`} value={rule.operator} onChange={event => onChange({ ...rule, operator: event.target.value as FilterRule["operator"] })}><option value="equals">等于</option><option value="not_equals">不等于</option><option value="not_empty">非空</option></select></label>
    {rule.operator !== "not_empty" && <label><span>{label}状态值 *</span><select aria-label={`${label}状态值`} value={rule.value} onChange={event => onChange({ ...rule, value: event.target.value })}><option value="">请选择并核实状态含义</option>{values.map(value => <option key={value}>{value}</option>)}</select></label>}
  </>;
}

export default function BusinessAnalysis({ profile, agentPlan, question, qualityGate, onExecution, initialConfig, onConfigChange }: Props) {
  const [config, setConfig] = useState<BusinessAnalysisConfig>(() => initialConfig ?? createBusinessAnalysisConfig(profile, agentPlan, question));
  const [confirmed, setConfirmed] = useState(false);
  const [result, setResult] = useState<BusinessAnalysisResult | null>(null);
  const [executionError, setExecutionError] = useState("");
  const [codeTab, setCodeTab] = useState<CodeTab>("SQL");
  const [verifying, setVerifying] = useState(false);
  const plan = useMemo(() => buildBusinessAnalysisPlan(profile, config, question), [profile, config, question]);
  const numericColumns = profile.columns.filter((column) => column.inferredType === "数值");
  const dateColumns = profile.columns.filter((column) => column.inferredType === "日期" || /date|time|日期|时间/i.test(column.name));
  const amountReconciliationRisk = ["sum", "average"].includes(config.aggregation) && config.valueField
    ? profile.joinAmountReconciliations?.find((item) => item.qualifiedField === config.valueField && item.status !== "balanced") ?? null
    : null;

  useEffect(() => { onConfigChange?.(config, confirmed); }, [config, confirmed, onConfigChange]);

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
      const primary = executeBusinessAnalysis(profile, config, question);
      if (primary.checks.some(check => !check.passed)) throw new Error(primary.checks.filter(check => !check.passed).map(check => check.detail).join("；"));
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
    : config.aggregation === "ratio" ? `成功率：${ratioConditionLabel(config.ratioNumerator)} / ${ratioConditionLabel(config.ratioDenominator)}`
    : config.aggregation === "sum" ? `${config.valueField} 合计`
      : `${config.valueField} / 去重 ${config.entityField}`;

  return (
    <div className="business-analysis-workbench">
      <div className="business-analysis-intro">
        <div><span>通用经营分析工具</span><h3>从分组、趋势到 Top N</h3><p>Agent 绑定候选字段；你确认业务含义后，由本地确定性引擎执行并验证。</p></div>
        <span className="engine-badge"><DatabaseZap size={14} />主计算 + DuckDB 独立复核</span>
      </div>

      <section className="business-analysis-config">
        <fieldset disabled={verifying} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
        <div className="analysis-draft-summary" role="status">
          <strong>本次准备回答：{question || "比较当前数据中的业务分组"}</strong>
          <p>{config.analysisType === "trend" ? `按 ${config.timeField || "待选时间字段"} 观察变化` : `按 ${config.groupField || "待选分组字段"} 分组比较`}，
            {config.aggregation === "ratio" ? `比较满足【${ratioConditionLabel(config.ratioNumerator)}】的去重 ${config.entityField || "统计编号"} 数 ÷ 满足【${ratioConditionLabel(config.ratioDenominator)}】的去重 ${config.entityField || "统计编号"} 数` : config.aggregation === "count_distinct" ? `比较不同 ${config.entityField || "统计编号"} 的数量` : config.aggregation === "sum" ? `比较 ${config.valueField || "待选数值"} 的合计` : `比较 ${config.valueField || "待选数值"} 合计除以不同 ${config.entityField || "统计编号"} 数的平均金额`}。</p>
          <small>使用 {profile.fileName} 的 {profile.rowCount} 行记录；“表现”需要你选择具体指标，系统不会自动定义为收入或利润。</small>
        </div>
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
          {["sum", "average"].includes(config.aggregation) && <label><span>数值字段 *</span><select aria-label="数值字段" value={config.valueField} onChange={(event) => update("valueField", event.target.value)}><option value="">请选择数值字段</option>{numericColumns.map((column) => <option key={column.name}>{column.name}</option>)}</select></label>}
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
        {config.aggregation === "ratio" && <div className="analysis-draft-summary">
          <strong>确认成功条件与比较范围</strong>
          <p>分子只在分母范围内计数，同一编号只计一次。请按业务定义选择成功状态；例如 delivered 是否代表成功送达，需要你核实。</p>
          <div className="business-analysis-fields">
            <RatioFilter profile={profile} label="分子" rule={config.ratioNumerator ?? { enabled: true, field: "", operator: "equals", value: "" }} onChange={rule => update("ratioNumerator", rule)} />
            <label><span>分母范围 *</span><select aria-label="分母范围" value={config.ratioDenominator?.enabled ? "filtered" : "all"} onChange={event => update("ratioDenominator", { enabled: event.target.value === "filtered", field: config.ratioNumerator?.field ?? "", operator: "not_equals", value: "" })}><option value="all">全部状态的去重订单</option><option value="filtered">按状态条件限定分母</option></select></label>
            {config.ratioDenominator?.enabled && <RatioFilter profile={profile} label="分母" rule={config.ratioDenominator} onChange={rule => update("ratioDenominator", rule)} />}
          </div>
          <p>当前分母：{ratioConditionLabel(config.ratioDenominator)}。选择全部状态时，取消、在途及未知状态的订单也计入分母；空编号不计入，空地区不进入分组。同一订单的地区或成功状态冲突时需先核实。分母为零表示无法计算。</p>
        </div>}
        <label className="business-analysis-confirmation">
          <input type="checkbox" checked={confirmed} onChange={(event) => { setConfirmed(event.target.checked); setResult(null); setExecutionError(""); }} />
          <ShieldCheck size={15} /><span><strong>我已确认分析口径</strong>：一行数据的含义、统计对象、聚合方式及分组/时间字段符合本次业务问题。{config.aggregation === "ratio" ? ` 分子为【${ratioConditionLabel(config.ratioNumerator)}】，分母为【${ratioConditionLabel(config.ratioDenominator)}】；本次按已确认状态统计。` : ""}</span>
        </label>
        </fieldset>
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
            {config.aggregation === "ratio" && <div><span>排除分母范围</span><strong>{result.excludedScopeRows ?? 0}</strong></div>}
          </div>
          <div className="business-result-chart">
            <ResponsiveContainer width="100%" height="100%">
              {config.analysisType === "trend" ? (
                <LineChart data={result.rows} margin={{ top: 12, right: 12, left: 0, bottom: 6 }}><CartesianGrid stroke="#e7edf5" vertical={false} /><XAxis dataKey="key" tick={{ fontSize: 10 }} /><YAxis tick={{ fontSize: 10 }} width={48} /><Tooltip /><Line type="monotone" dataKey="value" stroke="#2563eb" strokeWidth={2.5} dot={{ r: 3 }} /></LineChart>
              ) : (
                <BarChart data={result.rows} margin={{ top: 12, right: 12, left: 0, bottom: 6 }}><CartesianGrid stroke="#e7edf5" vertical={false} /><XAxis dataKey="key" tick={{ fontSize: 10 }} /><YAxis tick={{ fontSize: 10 }} width={48} domain={config.aggregation === "ratio" ? [0, 1] : [0, "auto"]} tickFormatter={config.aggregation === "ratio" ? value => `${Math.round(Number(value) * 100)}%` : undefined} /><Tooltip formatter={config.aggregation === "ratio" ? value => `${(Number(value) * 100).toFixed(2)}%` : undefined} /><Bar dataKey="value" name={config.aggregation === "ratio" ? "成功率" : "指标值"} fill="#2563eb" radius={[5, 5, 0, 0]} /></BarChart>
              )}
            </ResponsiveContainer>
          </div>
          <div className="business-result-table-wrap"><table className="business-result-table"><thead><tr><th>{config.analysisType === "trend" ? "时间" : "分组"}</th><th>{config.aggregation === "ratio" ? "成功率" : "指标值"}</th>{config.aggregation === "ratio" && <><th>成功订单数（分子）</th><th>范围内订单数（分母）</th></>}<th>源行数</th><th>去重对象</th><th>无效数值</th></tr></thead><tbody>{result.rows.map((row) => <tr key={row.key}><td><strong>{row.key}</strong></td><td>{config.aggregation === "ratio" ? `${(row.value * 100).toFixed(2)}%` : row.value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}</td>{config.aggregation === "ratio" && <><td>{row.numerator}</td><td>{row.denominator}</td></>}<td>{row.sourceRows}</td><td>{row.distinctEntities}</td><td>{row.excludedInvalidValues}</td></tr>)}</tbody></table></div>
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
