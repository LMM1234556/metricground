"use client";

import { AlertCircle, Bot, Check, ChevronRight, CircleHelp, LoaderCircle, ShieldCheck, Wrench } from "lucide-react";
import type { AgentPlan, AgentPlanResponse } from "../lib/agent-plan";

type Props = {
  response: AgentPlanResponse | null;
  loading: boolean;
  completed?: boolean;
  resultSummary?: string | null;
  onNavigate: (view: NonNullable<AgentPlan["nextView"]>, plan: AgentPlan) => void;
};

const TOOL_LABELS = {
  profile_dataset: "读取数据画像",
  run_quality_checks: "质量检查",
  preview_cleaning: "清洗预览",
  request_metric_contract: "指标口径确认",
  execute_metric: "确定性计算",
  execute_group_compare: "分组比较",
  execute_trend: "时间趋势",
  execute_top_n: "Top N 排名",
  validate_result: "结果验证",
};

export default function AgentPlanCard({ response, loading, completed = false, resultSummary, onNavigate }: Props) {
  if (loading) return (
    <section className="agent-plan-card loading" aria-live="polite">
      <LoaderCircle className="spin" size={20} />
      <div><strong>Agent 正在检查数据并制定计划</strong><p>先调用数据画像工具，再检查字段、口径和可用工具。</p></div>
    </section>
  );
  if (!response) return (
    <section className="agent-plan-card empty">
      <Bot size={20} />
      <div><strong>通用数据 Agent 已就绪</strong><p>请直接描述业务问题。Agent 会读取当前文件画像，必要时先向你澄清，不会返回 Olist 默认答案。</p></div>
    </section>
  );
  const { plan } = response;
  const completedNavigationAllowed = completed
    && Boolean(plan.nextView)
    && ["profile", "quality"].includes(plan.analysisType);
  const showNavigation = Boolean(plan.nextView) && (!completed || completedNavigationAllowed);
  return (
    <section className={`agent-plan-card ${plan.action}${completed ? " completed" : ""}`} aria-label="Agent 分析计划" data-fallback-reason={response.fallbackReason}>
      <div className="agent-plan-heading">
        <div className="agent-plan-title"><Bot size={20} /><span><small>MetricGround Agent</small><strong>{plan.summary}</strong></span></div>
        <div className="agent-source"><ShieldCheck size={14} />{response.source === "ollama-agent" ? `本地 ${response.model} · ${response.stepsExecuted} 步` : response.source === "cloud-agent" ? `${response.provider ?? "云模型"} / ${response.model} · ${response.stepsExecuted} 步` : response.source === "policy-router" ? "确定性策略路由" : "规则安全降级"}</div>
      </div>

      {plan.action === "clarify" && !completed && <div className="agent-clarification"><CircleHelp size={17} /><div><strong>执行前需要你确认</strong><p>{plan.clarification}</p></div></div>}
      {plan.action === "unsupported" && <div className="agent-unsupported"><AlertCircle size={17} /><div><strong>已识别需求，但当前工具不足</strong><p>{plan.clarification ?? plan.summary}</p></div></div>}
      {completed && (
        <div className="agent-plan-completion" role="status">
          <Check size={17} />
          <div><strong>本次 Agent 任务已完成</strong><p>{resultSummary ?? "确定性计算和结果验证均已完成。"}，无需返回指标口径重复执行。</p></div>
        </div>
      )}

      <div className="agent-plan-body">
        <div>
          <h3>Agent 执行计划</h3>
          <ol>{plan.steps.map((step) => <li key={step}>{step}</li>)}</ol>
        </div>
        <div>
          <h3>计划调用工具</h3>
          <div className="agent-tool-list">{plan.tools.map((name) => <span key={name}><Wrench size={12} />{TOOL_LABELS[name]}</span>)}</div>
          <h3 className="agent-binding-title">字段绑定</h3>
          <div className="agent-bindings">
            {Object.entries(plan.fieldBindings).map(([key, value]) => value && <span key={key}><b>{key}</b>{value}</span>)}
            {!Object.values(plan.fieldBindings).some(Boolean) && <em>当前步骤不需要绑定字段</em>}
          </div>
        </div>
      </div>

      <div className="agent-plan-footer">
        <span><Check size={13} />只传递字段画像与质量摘要，不向模型发送原始数据行</span>
        {showNavigation && plan.nextView && (
          <button type="button" onClick={() => onNavigate(plan.nextView!, plan)}>
            {completedNavigationAllowed
              ? `查看${plan.nextView}`
              : plan.action === "clarify"
                ? `前往${plan.nextView}确认`
                : plan.action === "unsupported"
                  ? "查看当前数据"
                  : `按计划继续：${plan.nextView}`}<ChevronRight size={14} />
          </button>
        )}
        {completed && !completedNavigationAllowed && <span className="agent-plan-done"><Check size={13} />计划已执行并完成验证</span>}
      </div>
      {plan.limitations.map((item) => <p className="agent-limitation" key={item}><AlertCircle size={12} />{item}</p>)}
    </section>
  );
}
