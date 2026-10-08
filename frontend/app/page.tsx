"use client";

import { ChangeEvent, FormEvent, useRef, useState } from "react";
import {
  AlertCircle, Check, ChevronRight, CircleHelp, FileCheck2, FileSpreadsheet, Gauge,
  LoaderCircle, MessageSquareText, Plus, Send,
  ShieldCheck, Sparkles, Trash2, Upload, FileDown, ClipboardCheck, GitMerge,
} from "lucide-react";
import {
  Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from "recharts";
import snapshot from "./data/olist_snapshot.json";
import { DatasetProfile, parseTabularFile } from "./lib/tabular-profile";
import {
  buildMetricContract, contractAsText, createMetricDraft, METRIC_TYPES, validateMetricDraft,
  MetricContract, MetricDraft,
} from "./lib/metric-contract";
import MetricExecution, { type MetricExecutionLifecycleEvent } from "./components/metric-execution";
import DataCleaning from "./components/data-cleaning";
import type { CleaningReceipt } from "./lib/data-cleaning";
import AgentPlanCard from "./components/agent-plan-card";
import BusinessAnalysis, { type BusinessAnalysisLifecycleEvent } from "./components/business-analysis";
import TaskRunTrace, { type EvidenceExportFormat, type EvidenceExportStatus } from "./components/task-run-trace";
import MultiTableJoin from "./components/multi-table-join";
import NoviceGuide, { type GuideStep } from "./components/novice-guide";
import { createDatasetAgentContext, type AgentPlan, type AgentPlanResponse } from "./lib/agent-plan";
import { analysisSpecFromBusinessConfig, analysisSpecFromMetricContract } from "./lib/analysis-spec";
import { approveTaskRun, completeTaskTool, createTaskRunFromPlan, failTaskTool, recordEvidenceExport, startTaskTool } from "./lib/agent-runtime";
import type { TaskRun } from "./lib/task-run";
import { businessFieldLabel, fieldDisplayName, rawFieldName } from "./lib/field-label";
import { assessQualityImpact, type QualityImpactSummary } from "./lib/quality-impact";

const trendData = snapshot.monthly.map((row) => ({
  month: row.month.slice(2),
  gmv: row.productGmvThousands,
}));

const metricCards = [
  { label: "总订单量", value: snapshot.kpis.totalOrders.toLocaleString("en-US"), note: "按 order_id 去重" },
  {
    label: "已送达订单",
    value: snapshot.kpis.deliveredOrders.toLocaleString("en-US"),
    note: `占全部订单 ${(snapshot.kpis.deliveredRate * 100).toFixed(1)}%`,
  },
  {
    label: "商品 GMV",
    value: `R$ ${(snapshot.kpis.productGmv / 1_000_000).toFixed(2)}M`,
    note: "已送达 · 不含运费",
  },
  {
    label: "平均客单价",
    value: `R$ ${snapshot.kpis.averageOrderValue.toFixed(2)}`,
    note: "GMV / 已送达订单",
  },
];

const categoryData = snapshot.topCategories.map((row) => ({
  category: row.category,
  gmv: Number((row.productGmv / 1000).toFixed(1)),
  share: row.gmvShare,
  orders: row.deliveredOrders,
}));

const deliveryData = snapshot.deliveryReview.groups.map((row) => ({
  status: row.status,
  rate: Number((row.negativeReviewRate * 100).toFixed(2)),
  orders: row.reviewedOrders,
}));
const topFiveShare = snapshot.topCategories.reduce((sum, row) => sum + row.gmvShare, 0);
const lateDelivery = snapshot.deliveryReview.groups.find((row) => row.status === "延迟送达")!;
const onTimeDelivery = snapshot.deliveryReview.groups.find((row) => row.status === "按时或提前")!;

type EvidenceTab = "口径" | "SQL" | "校验";
type AnalysisMode = "overview" | "trend" | "combined" | "category" | "delivery" | "unsupported";
type ProfileView = "画像" | "质量检查" | "清洗方案" | "多表关联" | "指标口径" | "计算执行" | "经营分析";
type QualityDecision = "approved" | "kept";

function findProfileField(profile: DatasetProfile, patterns: RegExp[]) {
  return profile.columns.find((column) => patterns.some((pattern) => pattern.test(rawFieldName(column.name))))?.name ?? "";
}

function buildGuidedTemplates(profile: DatasetProfile) {
  const orderField = findProfileField(profile, [/order.*id/i, /订单.*(编号|id)/i]);
  const amountField = findProfileField(profile, [/amount/i, /gmv/i, /sales.*amount/i, /金额|销售额/i]);
  const regionField = findProfileField(profile, [/region/i, /地区|区域/i]);
  const timeField = findProfileField(profile, [/order.*date/i, /purchase.*date/i, /日期|时间/i]);
  const templates = ["检查这份数据的质量问题，并解释对分析结果的影响"];
  if (orderField) templates.push(`统计 ${orderField} 去重后的订单数量`);
  if (amountField && regionField) templates.push(`按 ${regionField} 分组比较 ${amountField} 合计，不含运费、税费和退款`);
  else if (amountField && timeField) templates.push(`按月比较 ${amountField} 合计，不含运费、税费和退款`);
  else if (amountField) templates.push(`计算 ${amountField} 合计，不含运费、税费和退款`);
  return templates.slice(0, 3);
}

type MetricQuickTemplate = {
  id: "count" | "amount" | "average";
  label: string;
  description: string;
  fields: Partial<MetricDraft>;
};

function buildMetricQuickTemplates(profile: DatasetProfile): MetricQuickTemplate[] {
  const entityField = findProfileField(profile, [/order.*id/i, /订单.*(编号|id)/i])
    || profile.candidateKeys[0]
    || findProfileField(profile, [/(^|[_-])(id|key|code|no)$/i, /编号|编码|单号/i]);
  const valueField = findProfileField(profile, [/amount/i, /gmv/i, /sales.*amount/i, /金额|销售额/i])
    || profile.columns.find((column) => column.inferredType === "数值")?.name
    || "";
  const timeField = findProfileField(profile, [/order.*date/i, /purchase.*date/i, /日期|时间/i]);
  if (!entityField) return [];
  const entityLabel = businessFieldLabel(entityField);
  const valueLabel = valueField ? businessFieldLabel(valueField) : "数值字段";
  const grainDescription = `一行代表一条业务记录；同一${entityLabel}可能出现多行，计算时按 ${entityField} 去重。`;
  const templates: MetricQuickTemplate[] = [{
    id: "count",
    label: entityLabel.includes("订单") ? "去重订单量" : `去重${entityLabel}数量`,
    description: `回答“有多少个${entityLabel}”，重复编号只计算一次。`,
    fields: {
      metricType: "count",
      metricName: entityLabel.includes("订单") ? "去重订单量" : `去重${entityLabel}数量`,
      decisionQuestion: `判断${entityLabel}的总体规模和变化情况`,
      entityField,
      timeField,
      filterScope: `${entityField} 非空的全部记录`,
      grainDescription,
    },
  }];
  if (valueField) {
    templates.push({
      id: "amount",
      label: `${valueLabel}总额`,
      description: `回答“总金额是多少”；只汇总可转换为数值的 ${valueField}。`,
      fields: {
        metricType: "amount",
        metricName: `${valueLabel}总额`,
        decisionQuestion: `判断${valueLabel}的总体规模；该指标不直接等同于收入或利润`,
        entityField,
        valueField,
        timeField,
        filterScope: `${entityField} 非空且 ${valueField} 可转换为数值的全部记录`,
        grainDescription,
      },
    }, {
      id: "average",
      label: `平均每${entityLabel.replace("编号", "")}金额`,
      description: `回答“平均每个${entityLabel}多少钱”，分母按 ${entityField} 去重。`,
      fields: {
        metricType: "average",
        metricName: `平均每${entityLabel.replace("编号", "")}金额`,
        decisionQuestion: `判断每个${entityLabel}对应的平均金额水平`,
        entityField,
        valueField,
        timeField,
        filterScope: `${entityField} 非空且 ${valueField} 可转换为数值的全部记录`,
        grainDescription,
      },
    });
  }
  return templates;
}

function buildManualMetricAgentResponse(contract: MetricContract): AgentPlanResponse {
  return {
    plan: {
      action: "ready",
      analysisType: "metric",
      summary: `按已确认的指标合同计算“${contract.metricName}”。`,
      clarification: null,
      tools: ["profile_dataset", "run_quality_checks", "request_metric_contract", "execute_metric", "validate_result"],
      steps: [
        "读取并绑定当前数据版本",
        "复核质量风险与指标合同",
        "等待人工批准后调用确定性计算工具",
        "校验参与行数、去重对象与结果边界",
      ],
      fieldBindings: {
        entityField: contract.statisticalUnit,
        valueField: contract.valueField,
        groupField: null,
        timeField: contract.timeField,
      },
      nextView: "指标口径",
      confidence: 1,
      limitations: contract.warnings,
    },
    source: "policy-router",
    model: null,
    provider: null,
    stepsExecuted: 0,
    latencyMs: 0,
  };
}

function resolveAnalysisMode(question: string): AnalysisMode {
  if (/延迟|晚到|配送|送达时间|差评|评价|评论/i.test(question)) return "delivery";
  if (/品类|类别|类目|商品类|排名|前五|top\s*5/i.test(question)) return "category";
  const asksForTrend = /月度|趋势|变化|增长|高点|月份/i.test(question);
  const asksForOverview = /核心|经营指标|总订单|订单量|送达率|客单价/i.test(question)
    || (!asksForTrend && /GMV/i.test(question));

  if (asksForTrend && asksForOverview) return "combined";
  if (asksForTrend) return "trend";
  if (asksForOverview) return "overview";
  return "unsupported";
}

const peakMonth = snapshot.monthly.reduce((peak, row) =>
  row.productGmv > peak.productGmv ? row : peak
);

export default function Home() {
  const [query, setQuery] = useState("分析 Olist 的核心经营指标和月度 GMV 趋势");
  const [submittedQuery, setSubmittedQuery] = useState(query);
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>("combined");
  const [activeTab, setActiveTab] = useState<EvidenceTab>("口径");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [routingSource, setRoutingSource] = useState<"preset" | "ollama" | "rule-fallback">("preset");
  const [routingLatency, setRoutingLatency] = useState<number | null>(null);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [datasetProfile, setDatasetProfile] = useState<DatasetProfile | null>(null);
  const [relatedProfiles, setRelatedProfiles] = useState<DatasetProfile[]>([]);
  const [originalProfile, setOriginalProfile] = useState<DatasetProfile | null>(null);
  const [cleaningReceipt, setCleaningReceipt] = useState<CleaningReceipt | null>(null);
  const [isReadingFile, setIsReadingFile] = useState(false);
  const [fileError, setFileError] = useState("");
  const [profileView, setProfileView] = useState<ProfileView>("画像");
  const [qualityDecisions, setQualityDecisions] = useState<Record<string, QualityDecision>>({});
  const [metricDraft, setMetricDraft] = useState<MetricDraft | null>(null);
  const [metricContract, setMetricContract] = useState<MetricContract | null>(null);
  const [executionQualityImpact, setExecutionQualityImpact] = useState<QualityImpactSummary | null>(null);
  const [contractErrors, setContractErrors] = useState<string[]>([]);
  const [agentResponse, setAgentResponse] = useState<AgentPlanResponse | null>(null);
  const [businessAnalysisPlan, setBusinessAnalysisPlan] = useState<AgentPlan | null>(null);
  const [agentNavigationNotice, setAgentNavigationNotice] = useState("");
  const [taskRun, setTaskRun] = useState<TaskRun | null>(null);
  const [guidanceMode, setGuidanceMode] = useState<"guided" | "expert">("guided");
  const [evidenceExport, setEvidenceExport] = useState<EvidenceExportStatus | null>(null);
  const [hasJoinedDataset, setHasJoinedDataset] = useState(false);
  const profileCardRef = useRef<HTMLElement | null>(null);
  const queryInputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const taskRunRef = useRef<HTMLDivElement | null>(null);

  async function loadFile(file: File, sheetName?: string) {
    setIsReadingFile(true);
    setFileError("");
    try {
      const profile = await parseTabularFile(file, sheetName);
      setUploadedFile(file);
      setDatasetProfile(profile);
      setRelatedProfiles([]);
      setOriginalProfile(profile);
      setCleaningReceipt(null);
      setQualityDecisions({});
      setMetricDraft(createMetricDraft(profile));
      setMetricContract(null);
      setExecutionQualityImpact(null);
      setContractErrors([]);
      setAgentResponse(null);
      setTaskRun(null);
      setBusinessAnalysisPlan(null);
      if (!sheetName) {
        setHasJoinedDataset(false);
        setEvidenceExport(null);
        setQuery("");
        setSubmittedQuery("");
        setProfileView("画像");
      }
    } catch (error) {
      setFileError(error instanceof Error ? error.message : "文件读取失败，请检查文件格式。");
      if (!sheetName) {
        setUploadedFile(null);
        setDatasetProfile(null);
        setOriginalProfile(null);
        setCleaningReceipt(null);
        setMetricDraft(null);
        setAgentResponse(null);
        setTaskRun(null);
        setBusinessAnalysisPlan(null);
      }
    } finally {
      setIsReadingFile(false);
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) loadFile(file);
    event.target.value = "";
  }

  async function handleRelatedFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !datasetProfile || relatedProfiles.length >= 2) return;
    setIsReadingFile(true);
    setFileError("");
    try {
      const profile = await parseTabularFile(file);
      const names = new Set([datasetProfile.fileName, ...relatedProfiles.map((item) => item.fileName)]);
      if (names.has(profile.fileName)) throw new Error(`已存在同名数据源“${profile.fileName}”，请先重命名或移除旧表。`);
      setRelatedProfiles((current) => [...current, profile]);
      setProfileView("多表关联");
    } catch (error) {
      setFileError(error instanceof Error ? error.message : "关联表读取失败。");
    } finally {
      setIsReadingFile(false);
    }
  }

  function clearUploadedFile() {
    setUploadedFile(null);
    setDatasetProfile(null);
    setRelatedProfiles([]);
    setOriginalProfile(null);
    setCleaningReceipt(null);
    setFileError("");
    setQualityDecisions({});
    setMetricDraft(null);
    setMetricContract(null);
    setExecutionQualityImpact(null);
    setContractErrors([]);
    setAgentResponse(null);
    setTaskRun(null);
    setBusinessAnalysisPlan(null);
    setProfileView("画像");
    setHasJoinedDataset(false);
    setEvidenceExport(null);
    setQuery("分析 Olist 的核心经营指标和月度 GMV 趋势");
    setSubmittedQuery("分析 Olist 的核心经营指标和月度 GMV 趋势");
  }

  function applyCleanedProfile(profile: DatasetProfile, receipt: CleaningReceipt) {
    setDatasetProfile(profile);
    setCleaningReceipt(receipt);
    setQualityDecisions({});
    setMetricDraft(createMetricDraft(profile));
    setMetricContract(null);
    setExecutionQualityImpact(null);
    setContractErrors([]);
    setAgentResponse(null);
    setBusinessAnalysisPlan(null);
    setProfileView("质量检查");
  }

  function applyJoinedProfile(profile: DatasetProfile) {
    setDatasetProfile(profile);
    setOriginalProfile(profile);
    setRelatedProfiles([]);
    setCleaningReceipt(null);
    setQualityDecisions({});
    setMetricDraft(createMetricDraft(profile));
    setMetricContract(null);
    setExecutionQualityImpact(null);
    setContractErrors([]);
    setAgentResponse(null);
    setTaskRun(null);
    setBusinessAnalysisPlan(null);
    setHasJoinedDataset(true);
    setEvidenceExport(null);
    setAgentNavigationNotice("关联结果已作为新的派生数据版本载入，请先核对字段画像与输出粒度。");
    setQuery("");
    setSubmittedQuery("");
    setProfileView("画像");
  }

  function restoreOriginalProfile() {
    if (!originalProfile) return;
    setDatasetProfile(originalProfile);
    setCleaningReceipt(null);
    setQualityDecisions({});
    setMetricDraft(createMetricDraft(originalProfile));
    setMetricContract(null);
    setExecutionQualityImpact(null);
    setContractErrors([]);
    setAgentResponse(null);
    setTaskRun(null);
    setBusinessAnalysisPlan(null);
    setProfileView("质量检查");
  }

  function updateMetricDraft<K extends keyof MetricDraft>(key: K, value: MetricDraft[K]) {
    setMetricDraft((current) => current ? { ...current, [key]: value } : current);
    setMetricContract(null);
    setExecutionQualityImpact(null);
    setContractErrors([]);
    invalidateCompletedAnalysis("指标定义已变化，旧计算证据已失效；请按新口径重新确认并执行。");
  }

  function applyMetricQuickTemplate(template: MetricQuickTemplate) {
    setMetricDraft((current) => current ? {
      ...current,
      ...template.fields,
      numeratorDefinition: "",
      denominatorDefinition: "",
      grainConfirmed: false,
      qualityAcknowledged: false,
      definitionConfirmed: false,
    } : current);
    setMetricContract(null);
    setExecutionQualityImpact(null);
    setContractErrors([]);
    invalidateCompletedAnalysis("指标模板已变化，旧计算证据已失效；请按新口径重新确认并执行。");
  }

  function invalidateCompletedAnalysis(message: string) {
    if (taskRun?.state !== "COMPLETED") return;
    setTaskRun(null);
    setAgentResponse(null);
    setBusinessAnalysisPlan(null);
    setAgentNavigationNotice(message);
  }

  function recordQualityDecision(issueId: string, decision: QualityDecision) {
    setQualityDecisions((current) => ({ ...current, [issueId]: decision }));
    setMetricContract(null);
    setExecutionQualityImpact(null);
    invalidateCompletedAnalysis("质量判断已变化，旧计算证据已失效；请完成质量判断后重新确认指标口径。");
  }

  function confirmMetricContract() {
    if (!datasetProfile || !metricDraft) return;
    const errors = validateMetricDraft(metricDraft, datasetProfile.qualityIssues.length + datasetProfile.qualityChecksSkipped.length);
    setContractErrors(errors);
    if (errors.length > 0) return;
    setMetricContract(buildMetricContract(metricDraft, datasetProfile, qualityDecisions));
    setExecutionQualityImpact(null);
  }

  function downloadMetricContract() {
    if (!metricContract) return;
    const content = `${contractAsText(metricContract)}\n\nJSON：\n${JSON.stringify(metricContract, null, 2)}`;
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${metricContract.metricName.replace(/[\\/:*?\"<>|]/g, "-")}-指标口径合同.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function continueToMetricExecution() {
    if (datasetProfile && metricContract && !agentResponse) {
      const response = buildManualMetricAgentResponse(metricContract);
      setAgentResponse(response);
      setTaskRun(createTaskRunFromPlan(datasetProfile, metricContract.metricName, response));
      if (!submittedQuery) setSubmittedQuery(metricContract.metricName);
    }
    setProfileView("计算执行");
    setAgentNavigationNotice("指标口径已确认。下一步请审核计算计划，再批准执行预览。");
    window.requestAnimationFrame(() => profileCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  async function runAnalysis(question: string) {
    const normalized = question.trim();
    if (!normalized) return;
    setEvidenceExport(null);
    setSubmittedQuery(normalized);
    setAnalysisMode("unsupported");
    setIsAnalyzing(true);
    if (datasetProfile) {
      try {
        const response = await fetch("/api/agent/plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: normalized, dataset: createDatasetAgentContext(datasetProfile) }),
        });
        if (!response.ok) throw new Error("Agent planning failed");
        const planned = await response.json() as AgentPlanResponse;
        setAgentResponse(planned);
        setTaskRun(createTaskRunFromPlan(datasetProfile, normalized, planned));
      } catch {
        const fallback: AgentPlanResponse = {
          plan: {
            action: "unsupported", analysisType: "unsupported", summary: "Agent 编排服务暂时不可用。",
            clarification: "请确认本地 Ollama 服务和 qwen3:8b 模型正在运行。", tools: [], steps: ["检查本地模型服务后重试"],
            fieldBindings: { entityField: null, valueField: null, groupField: null, timeField: null },
            nextView: "画像", confidence: 0, limitations: ["本次没有执行任何分析工具。"],
          },
          source: "rule-fallback", model: null, stepsExecuted: 0, latencyMs: 0,
        };
        setAgentResponse(fallback);
        setTaskRun(createTaskRunFromPlan(datasetProfile, normalized, fallback));
      } finally {
        setIsAnalyzing(false);
      }
      return;
    }
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: normalized }),
      });
      if (!response.ok) throw new Error("Intent routing failed");
      const result = await response.json() as {
        intent: AnalysisMode;
        source: "ollama" | "rule-fallback";
        latencyMs: number | null;
      };
      setAnalysisMode(result.intent);
      setRoutingSource(result.source);
      setRoutingLatency(result.latencyMs);
    } catch {
      setAnalysisMode(resolveAnalysisMode(normalized));
      setRoutingSource("rule-fallback");
      setRoutingLatency(null);
    } finally {
      setIsAnalyzing(false);
    }
  }

  function submitQuestion(event: FormEvent) {
    event.preventDefault();
    runAnalysis(query);
  }

  function navigateFromAgent(view: "画像" | "质量检查" | "清洗方案" | "指标口径" | "经营分析", plan: AgentPlan) {
    if (view === "指标口径" && plan.analysisType === "metric" && datasetProfile) {
      const bindings = plan.fieldBindings;
      const validField = (field: string | null) => field && datasetProfile.columns.some((column) => column.name === field) ? field : "";
      const metricType = /平均|均值|客单价/i.test(submittedQuery)
        ? "average"
        : /比例|占比|转化率|送达率|率$/i.test(submittedQuery)
          ? "ratio"
          : /总额|合计|销售额|金额|gmv|收入|营收/i.test(submittedQuery)
            ? "amount"
            : "count";
      const metricName = metricType === "count"
        ? /客户|用户|会员/i.test(submittedQuery) ? "去重客户数" : /商品|产品|sku|item/i.test(submittedQuery) ? "去重商品数" : "去重业务对象数量"
        : metricType === "average" ? "平均业务指标" : metricType === "ratio" ? "业务比例指标" : "金额总额";
      setMetricDraft((current) => current ? {
        ...current,
        metricName,
        decisionQuestion: submittedQuery,
        metricType,
        entityField: validField(bindings.entityField) || current.entityField,
        valueField: validField(bindings.valueField) || current.valueField,
        timeField: validField(bindings.timeField) || current.timeField,
        grainDescription: `一行代表一条业务记录，按 ${validField(bindings.entityField) || current.entityField} 识别统计对象。`,
        grainConfirmed: false,
        definitionConfirmed: false,
      } : current);
      setMetricContract(null);
      setContractErrors([]);
    }
    if (view === "经营分析" && ["group_compare", "trend", "top_n"].includes(plan.analysisType)) {
      setBusinessAnalysisPlan(plan);
    }
    setProfileView(view);
    setAgentNavigationNotice(`Agent 已进入“${view}”，请在这里继续操作。`);
    window.requestAnimationFrame(() => {
      profileCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function freshInteractiveRun(responseOverride?: AgentPlanResponse) {
    const response = agentResponse ?? responseOverride;
    if (!datasetProfile || !response) return null;
    if (taskRun && ["NEEDS_CLARIFICATION", "NEEDS_APPROVAL", "READY_TO_EXECUTE"].includes(taskRun.state)) return taskRun;
    return createTaskRunFromPlan(datasetProfile, submittedQuery || metricContract?.metricName || "受控指标计算", response);
  }

  function handleBusinessExecution(event: BusinessAnalysisLifecycleEvent) {
    if (!datasetProfile || !agentResponse) return;
    try {
      let next = freshInteractiveRun();
      if (!next) return;
      const spec = analysisSpecFromBusinessConfig(event.config, datasetProfile, submittedQuery);
      if (next.state !== "READY_TO_EXECUTE") {
        next = approveTaskRun(next, {
          type: "metric",
          statement: `已确认${event.config.analysisType === "trend" ? "时间" : "分组"}字段、统计对象、聚合口径和数据粒度。`,
          spec,
        });
      }
      const tool = event.config.analysisType === "trend" ? "execute_trend"
        : event.config.analysisType === "top_n" ? "execute_top_n"
          : "execute_group_compare";
      const started = startTaskTool(next, tool, { analysisSpecId: spec.id });
      if (event.type === "failed") {
        setTaskRun(failTaskTool(started.run, { callId: started.callId, code: "BUSINESS_ANALYSIS_FAILED", message: event.error }));
        return;
      }
      const passed = event.result.checks.filter((check) => check.passed).length;
      const independent = event.result.independentVerification;
      const validation = `${passed}/${event.result.checks.length} 项基础检查通过；DuckDB-WASM ${independent?.engineVersion ?? "未知版本"} 独立复核${independent?.status === "passed" ? "通过" : "未通过"}；排除 ${event.result.excludedGroupingRows} 行无效分组/日期和 ${event.result.excludedInvalidValues} 个无效数值。`;
      const summary = event.result.rows.slice(0, 5).map((row) => `${row.key}=${row.value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`).join("，");
      setTaskRun(completeTaskTool(started.run, {
        callId: started.callId,
        outputSummary: `生成 ${event.result.rows.length} 个分析结果`,
        validationSummary: validation,
        resultSummary: summary,
        validationEvidence: independent ? {
          engine: independent.engine,
          engineVersion: independent.engineVersion,
          status: independent.status,
          datasetVersionId: independent.datasetVersionId,
          durationMs: independent.durationMs,
          checks: independent.checks,
          sql: independent.query,
        } : undefined,
      }));
    } catch (error) {
      setAgentNavigationNotice(error instanceof Error ? error.message : "Agent 任务记录失败。");
    }
  }

  function handleMetricExecution(event: MetricExecutionLifecycleEvent) {
    if (!datasetProfile) return;
    try {
      const response = agentResponse ?? buildManualMetricAgentResponse(event.contract);
      if (!agentResponse) setAgentResponse(response);
      let next = freshInteractiveRun(response);
      if (!next) return;
      const base = analysisSpecFromMetricContract(
        event.contract,
        datasetProfile,
        event.config.baseFilter.enabled ? [event.config.baseFilter] : [],
      );
      const spec = event.contract.metricType === "ratio" ? {
        ...base,
        numerator: { description: event.contract.formula, filter: event.config.ratioNumerator },
        denominator: { description: `基础筛选范围内的去重 ${event.contract.statisticalUnit}`, filter: event.config.baseFilter.enabled ? event.config.baseFilter : null },
        unresolvedQuestions: [],
        status: "confirmed" as const,
      } : base;
      if (next.state !== "READY_TO_EXECUTE") {
        next = approveTaskRun(next, {
          type: "metric",
          statement: `已确认指标合同“${event.contract.metricName}”、统计对象、筛选范围与数据粒度。`,
          spec,
        });
      }
      const started = startTaskTool(next, "execute_metric", { analysisSpecId: spec.id });
      if (event.type === "failed") {
        setTaskRun(failTaskTool(started.run, { callId: started.callId, code: "METRIC_EXECUTION_FAILED", message: event.error }));
        return;
      }
      const passed = event.result.checks.filter((check) => check.passed).length;
      const independent = event.result.independentVerification;
      const validation = `${passed}/${event.result.checks.length} 项基础检查通过；DuckDB-WASM ${independent?.engineVersion ?? "未知版本"} 独立复核${independent?.status === "passed" ? "通过" : "未通过"}；${event.result.eligibleRows}/${event.result.sourceRows} 行进入计算；质量相关性：${event.result.qualityImpact.statement}`;
      setTaskRun(completeTaskTool(started.run, {
        callId: started.callId,
        outputSummary: `${event.contract.metricName}=${event.result.displayValue}`,
        validationSummary: validation,
        resultSummary: `${event.contract.metricName}：${event.result.displayValue}`,
        validationEvidence: independent ? {
          engine: independent.engine,
          engineVersion: independent.engineVersion,
          status: independent.status,
          datasetVersionId: independent.datasetVersionId,
          durationMs: independent.durationMs,
          checks: independent.checks,
          sql: independent.query,
        } : undefined,
      }));
      setExecutionQualityImpact(event.result.qualityImpact);
      setAgentNavigationNotice(`计算、基础校验与 DuckDB 独立复核已完成：${event.contract.metricName}=${event.result.displayValue}。请查看 TaskRun 证据，确认后即可结束本次分析。`);
    } catch (error) {
      setAgentNavigationNotice(error instanceof Error ? error.message : "Agent 任务记录失败。");
    }
  }

  function handleEvidenceExport(format: EvidenceExportFormat, at: string) {
    if (!taskRun) throw new Error("当前没有可导出的 Agent 任务。");
    const next = recordEvidenceExport(taskRun, at, format);
    setTaskRun(next);
    setEvidenceExport({ taskId: taskRun.id, at, format });
    return next;
  }

  function startNewAnalysis() {
    if (!datasetProfile) return;
    setQuery("");
    setSubmittedQuery("");
    setMetricDraft(createMetricDraft(datasetProfile));
    setMetricContract(null);
    setExecutionQualityImpact(null);
    setContractErrors([]);
    setAgentResponse(null);
    setTaskRun(null);
    setBusinessAnalysisPlan(null);
    setEvidenceExport(null);
    setProfileView("画像");
    setAgentNavigationNotice("已保留当前数据和质量判断。请描述下一项业务问题，系统会重新确认指标口径。");
    window.requestAnimationFrame(() => {
      queryInputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      queryInputRef.current?.focus();
    });
  }

  const activeSql = analysisMode === "category"
    ? snapshot.queries.category.text
    : analysisMode === "delivery"
      ? snapshot.queries.delivery.text
      : snapshot.query.text;
  const validationIds = analysisMode === "category"
    ? ["items-composite-key", "delivered-item-join", "category-gmv-reconciliation"]
    : analysisMode === "delivery"
      ? ["orders-primary-key", "review-order-grain", "negative-review-rate-range"]
      : ["orders-primary-key", "items-composite-key", "gmv-reconciliation", "purchase-time"];
  const visibleValidation = snapshot.validation.filter((item) => validationIds.includes(item.id));
  const metricQualityImpact = datasetProfile && metricDraft
    ? executionQualityImpact ?? metricContract?.qualityImpact ?? assessQualityImpact(datasetProfile.qualityIssues, {
      metricName: metricDraft.metricName || "当前口径草案",
      metricType: metricDraft.metricType,
      entityField: metricDraft.entityField,
      valueField: metricDraft.metricType === "amount" || metricDraft.metricType === "average" ? metricDraft.valueField : null,
      timeField: metricDraft.timeField || null,
      filterScope: metricDraft.filterScope,
      decisionQuestion: metricDraft.decisionQuestion,
      grainConfirmed: metricDraft.grainConfirmed,
      additionalScope: `${metricDraft.numeratorDefinition} ${metricDraft.denominatorDefinition}`,
    })
    : null;
  const qualityImpactByIssue = new Map(metricQualityImpact?.items.map((item) => [item.issueId, item]) ?? []);
  const pendingUnrelatedSuggestions = metricQualityImpact?.items.filter((item) =>
    item.level === "unrelated" && !qualityDecisions[item.issueId]
  ).length ?? 0;
  const decidedQualityIssues = datasetProfile
    ? datasetProfile.qualityIssues.filter((issue) => Boolean(qualityDecisions[issue.id])).length
    : 0;
  const approvedRepairableQualityIssues = datasetProfile
    ? datasetProfile.qualityIssues.filter((issue) =>
      qualityDecisions[issue.id] === "approved" && Boolean(issue.supportedRepair)
    ).length
    : 0;
  const confirmedReviewQualityIssues = datasetProfile
    ? datasetProfile.qualityIssues.filter((issue) =>
      qualityDecisions[issue.id] === "approved" && !issue.supportedRepair
    ).length
    : 0;
  const needsCleaningConfirmation = approvedRepairableQualityIssues > 0
    && (!cleaningReceipt || cleaningReceipt.derivedFileName !== datasetProfile?.fileName);
  const qualityReviewComplete = Boolean(datasetProfile)
    && (datasetProfile!.qualityIssues.length === 0
      || (decidedQualityIssues === datasetProfile!.qualityIssues.length && !needsCleaningConfirmation));
  const analysisCompleted = taskRun?.state === "COMPLETED";
  const currentEvidenceExport = evidenceExport?.taskId === taskRun?.id ? evidenceExport : null;
  const guideCompleted = analysisCompleted && Boolean(currentEvidenceExport);
  const guideStep: GuideStep = !datasetProfile
    ? "upload"
    : relatedProfiles.length > 0
      ? "join"
    : taskRun?.state === "COMPLETED"
      ? "verify"
      : !qualityReviewComplete
        ? "quality"
        : !metricContract && !businessAnalysisPlan
          ? "define"
          : "execute";
  const guidedTemplates = datasetProfile ? buildGuidedTemplates(datasetProfile) : [];
  const metricQuickTemplates = datasetProfile ? buildMetricQuickTemplates(datasetProfile) : [];
  const guideCopy = guideCompleted ? {
    title: "本次分析已完成",
    description: "交付文件已经下载。你可以继续查看当前证据，也可以基于同一份数据开始新的分析。",
    detail: "当前原型不会自动保存历史任务；刷新或关闭页面前，请确认文件已经保存到本地。",
    actionLabel: "开始新的分析",
  } : guideStep === "upload" ? {
    title: "先上传一份 Excel 或 CSV",
    description: "Agent 会先读取字段、类型和数据粒度，不会修改原文件。",
    detail: "建议先用 1 张主表练习；需要跨表分析时再添加关联表。",
    actionLabel: "上传数据",
  } : guideStep === "join" ? {
    title: "先确认表关系和输出粒度",
    description: "检查关联键、关系类型、未匹配记录与行数膨胀，再生成新的派生数据版本。",
    detail: `已添加 ${relatedProfiles.length} 张关联表；完成关联后，系统会重新检查合并结果的字段与质量。`,
    actionLabel: "配置多表关联",
  } : guideStep === "quality" ? {
    title: "逐项判断数据风险",
    description: "先看证据和影响，再决定保留原样、核实或进入清洗方案。测试流程可以暂不处理；正式工作不能机械地全部暂不处理。",
    detail: `已判断 ${decidedQualityIssues}/${datasetProfile!.qualityIssues.length} 项；“暂不处理”只表示保留原始数据和风险说明，不代表问题已经解决。`,
    actionLabel: "查看质量问题",
  } : guideStep === "define" ? {
    title: "用一句话说清业务问题",
    description: "至少说明统计对象、指标、分组或时间，以及金额是否包含运费、税费、退款。",
    detail: "下方模板会使用当前文件中的真实字段，点击只会填入，不会立即计算。",
    actionLabel: "填写分析问题",
  } : guideStep === "execute" ? {
    title: "确认口径后再执行",
    description: "模型负责拆解问题和推荐字段；程序按照已确认的结构化规则计算。",
    detail: "执行前请核对统计对象、数据粒度、筛选范围和金额边界。",
    actionLabel: "前往受控执行",
  } : {
    title: "核对结果和证据链",
    description: "不要只看最终数字，还要检查参与行数、排除记录、边界校验和数据版本。",
    detail: "只有结果检查通过，且风险说明完整，结论才适合交付。",
    actionLabel: "查看验证证据",
  };

  function handleGuideAction() {
    if (guideCompleted) {
      startNewAnalysis();
      return;
    }
    if (guideStep === "upload") {
      fileInputRef.current?.click();
      return;
    }
    if (guideStep === "join") setProfileView("多表关联");
    if (guideStep === "quality") setProfileView("质量检查");
    if (guideStep === "define") {
      queryInputRef.current?.focus();
      queryInputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (guideStep === "execute") setProfileView(businessAnalysisPlan ? "经营分析" : "计算执行");
    if (guideStep === "verify") {
      taskRunRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    window.requestAnimationFrame(() => profileCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  function useGuidedTemplate(template: string) {
    setQuery(template);
    window.requestAnimationFrame(() => queryInputRef.current?.focus());
  }

  function handleQualityGuideAction() {
    if (!datasetProfile) return;
    if (analysisCompleted && decidedQualityIssues === datasetProfile.qualityIssues.length) {
      taskRunRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const firstUndecided = datasetProfile.qualityIssues.find((issue) => !qualityDecisions[issue.id]);
    if (firstUndecided) {
      document.getElementById(`quality-issue-${firstUndecided.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    setProfileView(needsCleaningConfirmation ? "清洗方案" : "指标口径");
    window.requestAnimationFrame(() => profileCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  function applyUnaffectedQualityRecommendations() {
    if (!metricQualityImpact) return;
    setQualityDecisions((current) => {
      const next = { ...current };
      metricQualityImpact.items.forEach((item) => {
        if (item.level === "unrelated" && !next[item.issueId]) next[item.issueId] = "kept";
      });
      return next;
    });
    setMetricContract(null);
    setExecutionQualityImpact(null);
    invalidateCompletedAnalysis("质量判断已变化，旧计算证据已失效；请完成剩余人工确认后重新执行。");
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true"><Gauge size={20} strokeWidth={2.2} /></div>
          <div>
            <div className="brand-name">MetricGround</div>
            <div className="brand-subtitle">可信经营分析</div>
          </div>
        </div>
        <div className="dataset-status">
          <span className="status-dot" />{datasetProfile ? `${datasetProfile.fileName} 已本地读取${relatedProfiles.length ? ` · 共 ${relatedProfiles.length + 1} 张表` : ""}` : "Olist 演示数据已连接"}
          <span className="status-separator" />
          {datasetProfile
            ? `${datasetProfile.rowCount.toLocaleString("zh-CN")} 行 · ${datasetProfile.columnCount} 列`
            : `${snapshot.scope.start.slice(0, 7)} 至 ${snapshot.scope.endInclusive.slice(0, 7)}`}
        </div>
      </header>

      <div className="workspace">
        <aside className="left-sidebar">
          <nav aria-label="主导航" className="primary-nav">
            <div className="nav-item active" aria-current="page"><MessageSquareText size={18} /><span><strong>分析工作台</strong><small>当前可用工作区</small></span></div>
          </nav>

          <section className="sidebar-section">
            <div className="section-heading">
              <span>数据源</span>
              <small>{1 + relatedProfiles.length}/3 张表</small>
            </div>
            <div className="source-card">
              <div className="source-icon"><FileSpreadsheet size={18} /></div>
              <div className="source-copy">
                <strong>{datasetProfile?.fileName ?? "Olist 原始数据集"}</strong>
                <span>
                  {datasetProfile
                    ? `${datasetProfile.fileType} · ${datasetProfile.rowCount.toLocaleString("zh-CN")} 行`
                    : `${snapshot.source.fileCount} 张表 · ${snapshot.source.totalRows.toLocaleString("en-US")} 行`}
                </span>
              </div>
              <span className="source-ready"><Check size={13} /></span>
            </div>
            {relatedProfiles.map((profile, index) => (
              <div className="source-card related" key={profile.fileName}>
                <div className="source-icon"><GitMerge size={18} /></div>
                <div className="source-copy"><strong>{profile.fileName}</strong><span>{profile.fileType} · {profile.rowCount.toLocaleString("zh-CN")} 行</span></div>
                <button className="source-remove" type="button" aria-label={`移除关联表 ${profile.fileName}`} onClick={() => setRelatedProfiles((current) => current.filter((_, currentIndex) => currentIndex !== index))}><Trash2 size={12} /></button>
              </div>
            ))}
            <label className={`upload-button${isReadingFile ? " disabled" : ""}`}>
              {isReadingFile ? <LoaderCircle className="spin" size={16} /> : <Upload size={16} />}
              {isReadingFile ? "正在本地读取" : "上传 Excel / CSV"}
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.xlsx"
                disabled={isReadingFile}
                onChange={handleFileChange}
              />
            </label>
            {datasetProfile && (
              <button className="remove-file-button" onClick={clearUploadedFile}>
                <Trash2 size={14} />移除当前文件
              </button>
            )}
            {datasetProfile && relatedProfiles.length < 2 && (
              <label className={`upload-button related-upload${isReadingFile ? " disabled" : ""}`}>
                <Plus size={15} />{isReadingFile ? "正在读取" : "添加关联表"}
                <input type="file" accept=".csv,.xlsx" disabled={isReadingFile} onChange={handleRelatedFileChange} />
              </label>
            )}
            {fileError && <p className="file-error"><AlertCircle size={14} />{fileError}</p>}
          </section>

          <section className="sidebar-section recent-section">
            <div className="section-heading">{guidanceMode === "expert" ? "分析快捷入口" : datasetProfile ? "当前数据模板" : "演示案例"}</div>
            {(datasetProfile
              ? guidedTemplates
              : ["核心经营指标", "延迟配送与差评", "品类 GMV 排名"]).map((item) => (
              <button
                className="recent-item"
                key={item}
                disabled={isAnalyzing}
                onClick={() => {
                  setQuery(item);
                  runAnalysis(item);
                }}
              >
                <span>{item}</span><ChevronRight size={15} />
              </button>
            ))}
          </section>
        </aside>

        <section className="analysis-column">
          <div className="page-heading">
            <div><p className="eyebrow">{guidanceMode === "expert" ? "自主分析工作台" : "经营分析工作台"}</p><h1>{guidanceMode === "expert" ? "自主分析与受控执行" : "从业务问题到可信结论"}</h1></div>
            <div className="page-heading-actions">
              <div className="mode-switch" aria-label="工作模式">
                <button type="button" className={guidanceMode === "guided" ? "active" : ""} onClick={() => setGuidanceMode("guided")}>新手引导</button>
                <button type="button" className={guidanceMode === "expert" ? "active" : ""} onClick={() => setGuidanceMode("expert")}>自主模式</button>
              </div>
              <span className="readonly-badge"><ShieldCheck size={15} />原文件保护模式</span>
            </div>
          </div>

          {guidanceMode === "guided" && (
            <NoviceGuide
              step={guideStep}
              title={guideCopy.title}
              description={guideCopy.description}
              detail={guideCopy.detail}
              actionLabel={guideCopy.actionLabel}
              templates={guideStep === "define" ? guidedTemplates : []}
              includeJoinStep={relatedProfiles.length > 0 || hasJoinedDataset}
              completed={guideCompleted}
              onAction={handleGuideAction}
              onUseTemplate={useGuidedTemplate}
            />
          )}

          {guidanceMode === "expert" && (
            <div className="expert-mode-note" role="status">
              <div><ShieldCheck size={16} /><span><strong>自主模式</strong>直接使用下方工作流页签；质量检查、指标合同、清洗二次确认和结果校验仍然生效。</span></div>
              <span>不会绕过安全门槛</span>
            </div>
          )}

          <form className="query-box" onSubmit={submitQuestion}>
            <div className="query-leading"><Sparkles size={18} /></div>
            <textarea
              ref={queryInputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="请输入想了解的业务问题"
              rows={2}
              placeholder={guidanceMode === "expert"
                ? "描述业务问题，并尽量写明指标、统计对象、分组、时间范围和筛选条件"
                : datasetProfile
                ? `请输入业务问题，例如：${guidedTemplates.find((item) => !item.startsWith("检查")) ?? guidedTemplates[0] ?? "统计当前数据的业务对象数量"}`
                : "请输入想了解的业务问题，例如：2018 年 GMV 是否增长？"}
            />
            <button className="send-button" type="submit" aria-label="开始分析" disabled={isAnalyzing}>
              {isAnalyzing ? <LoaderCircle className="spin" size={18} /> : <Send size={18} />}
            </button>
          </form>

          {guidanceMode === "guided" && <div className="suggestion-row" aria-label="示例问题">
            <span>试试：</span>
            {(datasetProfile
              ? guidedTemplates
              : ["核心经营指标", "月度 GMV 趋势", "品类 GMV 排名", "延迟配送与差评"]).map((item) => (
              <button
                type="button"
                key={item}
                disabled={isAnalyzing}
                onClick={() => {
                  setQuery(item);
                  runAnalysis(item);
                }}
              >{item}</button>
            ))}
          </div>}

          {datasetProfile && (
            <>
              <AgentPlanCard
                response={agentResponse}
                loading={isAnalyzing}
                completed={taskRun?.state === "COMPLETED"}
                resultSummary={taskRun?.resultSummary}
                onNavigate={navigateFromAgent}
              />
              <div ref={taskRunRef}>
                <TaskRunTrace
                  run={taskRun}
                  exportStatus={currentEvidenceExport}
                  onExport={handleEvidenceExport}
                  onStartNewAnalysis={startNewAnalysis}
                />
              </div>
            </>
          )}

          {datasetProfile && (
            <section ref={profileCardRef} className="profile-card" aria-label="上传数据字段画像">
              <div className="profile-header">
                <div className="profile-title">
                  <span className="profile-icon"><FileCheck2 size={18} /></span>
                  <div><h2>数据画像与质量体检</h2><p>文件只在当前浏览器中解析，尚未修改原始数据</p></div>
                </div>
                <div className="profile-tools">
                  <div className="profile-tabs" role="tablist" aria-label="数据检查视图">
                    {(["画像", "质量检查", "清洗方案", "多表关联", "指标口径", "经营分析", "计算执行"] as ProfileView[]).map((view) => (
                      <button
                        type="button"
                        role="tab"
                        aria-selected={profileView === view}
                        className={profileView === view ? "active" : ""}
                        onClick={() => setProfileView(view)}
                        key={view}
                      >
                        {view}{view === "质量检查" && datasetProfile.qualityIssues.length > 0 ? ` ${datasetProfile.qualityIssues.length}` : ""}
                      </button>
                    ))}
                  </div>
                  {datasetProfile.sheetNames.length > 1 && uploadedFile && (
                    <label className="sheet-selector">
                      <span>工作表</span>
                      <select
                        value={datasetProfile.activeSheet}
                        disabled={isReadingFile}
                        onChange={(event) => loadFile(uploadedFile, event.target.value)}
                      >
                        {datasetProfile.sheetNames.map((sheet) => <option key={sheet}>{sheet}</option>)}
                      </select>
                    </label>
                  )}
                </div>
              </div>

              {agentNavigationNotice && (
                <div className="agent-navigation-notice" role="status">
                  <Check size={14} />{agentNavigationNotice}
                </div>
              )}

              {profileView === "画像" ? (
                <>
                  <div className="profile-stats">
                    <div><span>数据行</span><strong>{datasetProfile.rowCount.toLocaleString("zh-CN")}</strong></div>
                    <div><span>字段数</span><strong>{datasetProfile.columnCount}</strong></div>
                    <div><span>缺失单元格</span><strong>{datasetProfile.missingCellCount.toLocaleString("zh-CN")}</strong></div>
                    <div><span>候选唯一键</span><strong>{datasetProfile.candidateKeys.length}</strong></div>
                  </div>

                  <div className="grain-card">
                    <strong>候选数据粒度</strong>
                    <p>{datasetProfile.grainSuggestion}</p>
                    <span>自动识别第 {datasetProfile.headerRowNumber} 行为表头；粒度是基于唯一性的初步判断，进入分析前仍需人工确认。</span>
                  </div>

                  <div className="profile-table-wrap">
                    <table className="profile-table">
                      <thead><tr><th>字段</th><th>推断类型</th><th>缺失率</th><th>唯一值</th><th>样例</th></tr></thead>
                      <tbody>
                        {datasetProfile.columns.map((column) => (
                          <tr key={column.name}>
                            <td><strong>{businessFieldLabel(column.name)}</strong>{businessFieldLabel(column.name) !== rawFieldName(column.name) && <small className="raw-field-name">{column.name}</small>}{column.isCandidateKey && <span className="key-badge">候选键</span>}</td>
                            <td><span className={`type-badge${column.inferredType === "混合" ? " warning" : ""}`}>{column.inferredType}</span></td>
                            <td>{(column.missingRate * 100).toFixed(1)}%</td>
                            <td>{column.uniqueCount.toLocaleString("zh-CN")}</td>
                            <td>{column.examples.join("、") || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="profile-next-note">
                    <AlertCircle size={15} />字段画像只描述数据形状，不代表数据可以直接使用；请继续查看“质量检查”。
                  </div>
                </>
              ) : profileView === "质量检查" ? (
                <>
                  {cleaningReceipt && datasetProfile.fileName === cleaningReceipt.derivedFileName && (
                    <div className="cleaned-version-banner">
                      <ShieldCheck size={16} />
                      <div>
                        <strong>当前使用清洗副本：{cleaningReceipt.sourceRows} → {cleaningReceipt.resultRows} 行</strong>
                        <span>已发现问题 {cleaningReceipt.issuesBefore} → {cleaningReceipt.issuesAfter}
                          {cleaningReceipt.checksSkippedAfter > 0 ? `，另有 ${cleaningReceipt.checksSkippedAfter} 项检查因样本不足未运行` : ""}；后续指标口径与计算均绑定“{cleaningReceipt.derivedFileName}”。</span>
                      </div>
                    </div>
                  )}
                  <div className="quality-summary">
                    <div><span>检查规则</span><strong>{datasetProfile.qualitySummary.checksRun}</strong></div>
                    <div className="issues"><span>发现问题</span><strong>{datasetProfile.qualityIssues.length}</strong></div>
                    <div className="passed"><span>无异常规则</span><strong>{datasetProfile.qualitySummary.passedChecks}</strong></div>
                    <div className="high"><span>高风险</span><strong>{datasetProfile.qualitySummary.highIssues}</strong></div>
                    <div className="medium"><span>中风险</span><strong>{datasetProfile.qualitySummary.mediumIssues}</strong></div>
                  </div>

                  <div className="approval-note">
                    <ShieldCheck size={16} />处理按钮只记录你的决定，不会修改或覆盖原始文件；实际转换必须在下一步再次确认。
                  </div>

                  {datasetProfile.qualityChecksSkipped.length > 0 && (
                    <div className="quality-skipped-note" role="status">
                      <AlertCircle size={15} />
                      <div><strong>{datasetProfile.qualityChecksSkipped.length} 项检查未运行，不能视为通过</strong>
                        {datasetProfile.qualityChecksSkipped.map((item) => <span key={`${item.check}-${item.field}`}>“{item.field}”{item.check}：{item.reason}</span>)}
                      </div>
                    </div>
                  )}

                  {metricQualityImpact && (
                    <section className="quality-impact-summary" aria-label="质量风险与当前指标的相关性">
                      <div className="quality-impact-copy">
                        <span>按当前口径草案判断</span>
                        <strong>{metricDraft?.metricName || `按 ${metricDraft?.entityField || "统计对象"} 计算`}</strong>
                        <p>{metricQualityImpact.statement}</p>
                        <small>此判断只适用于当前公式、筛选和粒度；更换指标后会自动重新评估。</small>
                      </div>
                      <div className="quality-impact-counts">
                        <div className="affecting"><span>影响本指标</span><strong>{metricQualityImpact.affecting}</strong></div>
                        <div className="review"><span>需要确认</span><strong>{metricQualityImpact.review}</strong></div>
                        <div className="unrelated"><span>本指标无关</span><strong>{metricQualityImpact.unrelated}</strong></div>
                      </div>
                      {pendingUnrelatedSuggestions > 0 && (
                        <button type="button" onClick={applyUnaffectedQualityRecommendations}>
                          记录 {pendingUnrelatedSuggestions} 项“保留原样”建议<ChevronRight size={14} />
                        </button>
                      )}
                    </section>
                  )}

                  {guidanceMode === "guided" && datasetProfile.qualityIssues.length > 0 && (
                    <div className={`quality-step-guide${decidedQualityIssues === datasetProfile.qualityIssues.length ? " complete" : ""}`} role="status">
                      <div className="quality-step-copy">
                        <strong>{analysisCompleted && decidedQualityIssues === datasetProfile.qualityIssues.length
                          ? "质量判断已纳入本次结果"
                          : decidedQualityIssues === datasetProfile.qualityIssues.length ? "本步判断已完成" : "当前任务：逐项判断风险"}</strong>
                        <span>
                          {analysisCompleted && decidedQualityIssues === datasetProfile.qualityIssues.length
                            ? "计算与验证已经完成，无需重新定义指标；下一步只需核对 TaskRun 证据。"
                            : decidedQualityIssues === datasetProfile.qualityIssues.length
                            ? needsCleaningConfirmation
                              ? `你批准了 ${approvedRepairableQualityIssues} 项可执行清洗规则，下一步需要预览并确认清洗副本。`
                              : confirmedReviewQualityIssues > 0
                                ? `已记录 ${confirmedReviewQualityIssues} 项人工核实结论；你没有批准自动删除规则，下一步直接明确指标口径。`
                              : metricQualityImpact && metricQualityImpact.affecting === 0 && metricQualityImpact.review === 0
                                ? "所有问题均已记录；按当前指标口径，它们不会改变计算结果。更换口径后会重新评估。"
                                : "所有问题均已记录为保留原样；其中与当前指标相关的问题仍会进入结果风险说明。"
                            : `已完成 ${decidedQualityIssues}/${datasetProfile.qualityIssues.length} 项，还剩 ${datasetProfile.qualityIssues.length - decidedQualityIssues} 项。每项都要明确选择后才能继续。`}
                        </span>
                        <div className="quality-step-progress" aria-label={`质量判断进度 ${decidedQualityIssues}/${datasetProfile.qualityIssues.length}`}>
                          <span style={{ width: `${(decidedQualityIssues / datasetProfile.qualityIssues.length) * 100}%` }} />
                        </div>
                      </div>
                      <button type="button" onClick={handleQualityGuideAction}>
                        {analysisCompleted && decidedQualityIssues === datasetProfile.qualityIssues.length
                          ? "查看验证证据"
                          : decidedQualityIssues < datasetProfile.qualityIssues.length
                          ? "定位下一项"
                          : needsCleaningConfirmation
                            ? "下一步：确认清洗方案"
                            : "下一步：明确分析口径"}
                        <ChevronRight size={14} />
                      </button>
                    </div>
                  )}

                  {datasetProfile.qualityIssues.length === 0 ? (
                    <div className="quality-empty">
                      <Check size={19} /><div><strong>{datasetProfile.qualityChecksSkipped.length > 0 ? "已运行的基础检查未发现明显问题" : "基础检查未发现明显问题"}</strong><p>{datasetProfile.qualityChecksSkipped.length > 0
                        ? "仍有检查因样本不足未运行；这不代表相关风险已经消失。"
                        : "这不代表业务口径已经正确，仍需确认数据粒度、字段含义和分析目标。"}</p></div>
                    </div>
                  ) : (
                    <div className="quality-list">
                      {datasetProfile.qualityIssues.map((issue) => {
                        const decision = qualityDecisions[issue.id];
                        const impact = qualityImpactByIssue.get(issue.id);
                        return (
                          <article className="quality-issue" id={`quality-issue-${issue.id}`} key={issue.id}>
                            <div className="quality-issue-heading">
                              <span className={`severity ${issue.severity === "高" ? "high" : issue.severity === "中" ? "medium" : "low"}`}>
                                {issue.severity}风险
                              </span>
                              <span className="check-name">{issue.check}</span>
                              {impact && <span className={`quality-impact-badge ${impact.level}`}>{impact.label}</span>}
                              <h3>{issue.title}</h3>
                            </div>
                            <dl>
                              <div><dt>证据</dt><dd>{issue.evidence}</dd></div>
                              <div><dt>影响</dt><dd>{issue.impact}</dd></div>
                              <div><dt>建议</dt><dd>{issue.recommendation}</dd></div>
                              {impact && <div className="quality-impact-detail"><dt>本次指标</dt><dd><strong>{impact.reason}</strong><span>Agent 建议：{impact.recommendedAction}</span></dd></div>}
                            </dl>
                            <div className="quality-actions">
                              <button
                                type="button"
                                className={decision === "kept" ? "active kept" : ""}
                                onClick={() => recordQualityDecision(issue.id, "kept")}
                              >暂不处理</button>
                              <button
                                type="button"
                                className={decision === "approved" ? "active approved" : ""}
                                onClick={() => recordQualityDecision(issue.id, "approved")}
                              >{issue.supportedRepair ? "批准清洗建议" : "确认已核实"}</button>
                              {decision && <span><Check size={13} />已记录：{decision === "approved"
                                ? issue.supportedRepair ? "批准清洗" : "人工核实"
                                : "保留原样"}</span>}
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  )}

                  {analysisCompleted ? (
                    <div className="profile-next-note success">
                      <Check size={15} />质量判断已纳入本次计算与验证；无需重新清洗或定义口径，请查看 TaskRun 证据完成交付。
                    </div>
                  ) : cleaningReceipt && datasetProfile.fileName === cleaningReceipt.derivedFileName ? (
                    <div className="profile-next-note success">
                      <Check size={15} />清洗副本已生成并复检；下一步请进入“指标口径”，确认统计对象、公式和筛选范围。
                    </div>
                  ) : needsCleaningConfirmation ? (
                    <div className="profile-next-note">
                      <AlertCircle size={15} />质量页只记录判断；需要进入“清洗方案”二次确认，才能生成派生副本并重新检查。
                    </div>
                  ) : (
                    <div className="profile-next-note success">
                      <Check size={15} />人工核实只记录业务结论，不会删除数据；当前没有批准清洗规则，可直接进入“指标口径”。
                    </div>
                  )}
                </>
              ) : profileView === "清洗方案" && originalProfile ? (
                <DataCleaning
                  profile={datasetProfile}
                  originalProfile={originalProfile}
                  decisions={qualityDecisions}
                  receipt={cleaningReceipt}
                  onApply={applyCleanedProfile}
                  onRestore={restoreOriginalProfile}
                  onSkip={() => {
                    setProfileView("指标口径");
                    setAgentNavigationNotice("未生成清洗副本；当前数据保持不变，人工核实结论与质量风险会保留在结果证据中。");
                    window.requestAnimationFrame(() => profileCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
                  }}
                />
              ) : profileView === "多表关联" ? (
                <MultiTableJoin
                  key={[datasetProfile.fileName, ...relatedProfiles.map((profile) => profile.fileName)].join("|")}
                  profiles={[datasetProfile, ...relatedProfiles]}
                  onUseJoinedProfile={applyJoinedProfile}
                />
              ) : profileView === "指标口径" && metricDraft ? (
                <div className="metric-builder">
                  <div className="contract-intro">
                    <div>
                      <span className="contract-kicker">指标口径确认器</span>
                      <h3>先定义清楚，再允许计算</h3>
                      <p>系统不会根据字段名猜业务口径。补齐统计对象、公式、范围和风险确认后，才能生成指标合同。</p>
                    </div>
                    <div className="contract-progress" aria-label="口径确认步骤">
                      <span className="done">1 数据</span><span className="done">2 质量</span><span className="active">3 口径</span>
                    </div>
                  </div>

                  {guidanceMode === "guided" && metricQuickTemplates.length > 0 && (
                    <section className="metric-quick-start" aria-label="新手快速填写指标口径">
                      <div className="metric-quick-heading">
                        <div><span>新手先做这一步</span><strong>选择你真正想计算的指标</strong></div>
                        <small>系统会预填字段和业务说明，但不会替你勾选人工确认。</small>
                      </div>
                      <div className="metric-quick-grid">
                        {metricQuickTemplates.map((template, index) => (
                          <button
                            type="button"
                            className={metricDraft.metricName === template.fields.metricName ? "active" : ""}
                            onClick={() => applyMetricQuickTemplate(template)}
                            key={template.id}
                          >
                            <span>{index === 0 ? "推荐入门" : "常用指标"}</span>
                            <strong>{template.label}</strong>
                            <small>{template.description}</small>
                          </button>
                        ))}
                      </div>
                      <p><CircleHelp size={14} />选择后请向下核对预填内容；不确定字段含义时，不要勾选“人工确认”。</p>
                    </section>
                  )}

                  <fieldset className="metric-type-fieldset">
                    <legend>1. 选择指标类型</legend>
                    <div className="metric-type-grid">
                      {METRIC_TYPES.map((item) => (
                        <button
                          type="button"
                          className={metricDraft.metricType === item.value ? "active" : ""}
                          aria-pressed={metricDraft.metricType === item.value}
                          onClick={() => updateMetricDraft("metricType", item.value)}
                          key={item.value}
                        >
                          <strong>{item.label}</strong><span>{item.description}</span>
                        </button>
                      ))}
                    </div>
                  </fieldset>

                  <div className="contract-form">
                    <div className="contract-section-heading"><strong>2. 补齐业务定义</strong><span>* 为生成合同必填</span></div>
                    <div className="contract-form-grid">
                      <label>
                        <span>指标名称 *</span>
                        <input
                          name="metricName"
                          value={metricDraft.metricName}
                          onChange={(event) => updateMetricDraft("metricName", event.target.value)}
                          placeholder="例如：有效订单量"
                        />
                      </label>
                      <label>
                        <span>支持的业务判断 *</span>
                        <input
                          name="decisionQuestion"
                          value={metricDraft.decisionQuestion}
                          onChange={(event) => updateMetricDraft("decisionQuestion", event.target.value)}
                          placeholder="例如：判断各地区订单规模"
                        />
                      </label>
                      <label>
                        <span>统计对象/去重字段 *</span>
                        <select
                          name="entityField"
                          value={metricDraft.entityField}
                          onChange={(event) => updateMetricDraft("entityField", event.target.value)}
                        >
                          <option value="">请选择字段</option>
                          {datasetProfile.columns.map((column) => <option value={column.name} key={column.name}>{fieldDisplayName(column.name)}</option>)}
                        </select>
                        <small>计数和平均指标会按该字段去重，避免一对多明细重复统计。</small>
                      </label>
                      {(metricDraft.metricType === "amount" || metricDraft.metricType === "average") && (
                        <label>
                          <span>数值字段 *</span>
                          <select
                            name="valueField"
                            value={metricDraft.valueField}
                            onChange={(event) => updateMetricDraft("valueField", event.target.value)}
                          >
                            <option value="">请选择数值字段</option>
                            {datasetProfile.columns.filter((column) => column.inferredType === "数值").map((column) => (
                              <option value={column.name} key={column.name}>{fieldDisplayName(column.name)}</option>
                            ))}
                          </select>
                        </label>
                      )}
                      <label>
                        <span>时间字段</span>
                        <select
                          name="timeField"
                          value={metricDraft.timeField}
                          onChange={(event) => updateMetricDraft("timeField", event.target.value)}
                        >
                          <option value="">不使用时间字段</option>
                          {datasetProfile.columns.map((column) => <option value={column.name} key={column.name}>{fieldDisplayName(column.name)}</option>)}
                        </select>
                      </label>
                      <label>
                        <span>数据范围/筛选条件 *</span>
                        <input
                          name="filterScope"
                          value={metricDraft.filterScope}
                          onChange={(event) => updateMetricDraft("filterScope", event.target.value)}
                          placeholder="例如：状态为 delivered 的记录"
                        />
                      </label>
                    </div>

                    {metricDraft.metricType === "ratio" && (
                      <div className="ratio-definition">
                        <label>
                          <span>分子定义 *</span>
                          <input
                            name="numeratorDefinition"
                            value={metricDraft.numeratorDefinition}
                            onChange={(event) => updateMetricDraft("numeratorDefinition", event.target.value)}
                            placeholder="例如：状态为 delivered 的去重订单"
                          />
                        </label>
                        <div className="ratio-symbol">÷</div>
                        <label>
                          <span>分母定义 *</span>
                          <input
                            name="denominatorDefinition"
                            value={metricDraft.denominatorDefinition}
                            onChange={(event) => updateMetricDraft("denominatorDefinition", event.target.value)}
                            placeholder="例如：全部状态的去重订单"
                          />
                        </label>
                      </div>
                    )}

                    <label className="grain-definition">
                      <span>数据粒度说明 *</span>
                      <textarea
                        name="grainDescription"
                        rows={2}
                        value={metricDraft.grainDescription}
                        onChange={(event) => updateMetricDraft("grainDescription", event.target.value)}
                        placeholder="说明一行数据代表一笔订单、一件商品还是一位客户"
                      />
                    </label>
                  </div>

                  <div className="contract-confirmations">
                    <div className="contract-section-heading"><strong>3. 人工确认</strong><span>确认不代表数据已经被清洗</span></div>
                    <label>
                      <input
                        type="checkbox"
                        checked={metricDraft.grainConfirmed}
                        onChange={(event) => updateMetricDraft("grainConfirmed", event.target.checked)}
                      />
                      <span><strong>我已确认数据粒度</strong>，所选去重字段符合业务对象定义。</span>
                    </label>
                    {(datasetProfile.qualityIssues.length > 0 || datasetProfile.qualityChecksSkipped.length > 0) && (
                      <label>
                        <input
                          type="checkbox"
                          checked={metricDraft.qualityAcknowledged}
                          onChange={(event) => updateMetricDraft("qualityAcknowledged", event.target.checked)}
                        />
                        <span><strong>我已查看质量相关性判断</strong>：{metricQualityImpact?.statement ?? `共 ${datasetProfile.qualityIssues.length} 项已发现风险`}
                          {datasetProfile.qualityChecksSkipped.length > 0 ? `；另有 ${datasetProfile.qualityChecksSkipped.length} 项检查未运行` : ""}。</span>
                      </label>
                    )}
                    <label>
                      <input
                        type="checkbox"
                        checked={metricDraft.definitionConfirmed}
                        onChange={(event) => updateMetricDraft("definitionConfirmed", event.target.checked)}
                      />
                      <span><strong>我已确认概念边界</strong>，该指标不自动等同于收入、利润、转化效果等其他概念。</span>
                    </label>
                  </div>

                  {contractErrors.length > 0 && (
                    <div className="contract-errors" role="alert">
                      <AlertCircle size={16} />
                      <div><strong>还不能生成合同</strong><p>{contractErrors.join("；")}。</p></div>
                    </div>
                  )}

                  <div className="contract-submit-row">
                    <div><strong>输出内容</strong><span>公式、统计单位、时间字段、筛选范围、质量处置和风险提示</span></div>
                    <button type="button" onClick={confirmMetricContract}><ClipboardCheck size={16} />生成并确认指标合同</button>
                  </div>

                  {metricContract && (
                    <section className="metric-contract-output" aria-label="已生成的指标口径合同">
                      <div className="contract-output-heading">
                        <div><span><Check size={14} />口径已确认</span><h3>{metricContract.metricName}</h3></div>
                        <button type="button" onClick={downloadMetricContract}><FileDown size={15} />下载合同</button>
                      </div>
                      <dl>
                        <div><dt>业务用途</dt><dd>{metricContract.decisionQuestion}</dd></div>
                        <div><dt>指标类型</dt><dd>{metricContract.metricTypeLabel}</dd></div>
                        <div className="formula-row"><dt>计算公式</dt><dd><code>{metricContract.formula}</code></dd></div>
                        <div><dt>统计单位</dt><dd>{metricContract.statisticalUnit}</dd></div>
                        <div><dt>时间字段</dt><dd>{metricContract.timeField ?? "未指定"}</dd></div>
                        <div><dt>筛选范围</dt><dd>{metricContract.filterScope}</dd></div>
                        <div><dt>质量处置</dt><dd>{metricContract.qualityDisposition.statement}</dd></div>
                        <div><dt>指标相关性</dt><dd>{metricContract.qualityImpact.statement}</dd></div>
                      </dl>
                      {metricContract.warnings.map((warning) => <p className="contract-warning" key={warning}><AlertCircle size={14} />{warning}</p>)}
                      <div className="contract-next-step">
                        <div><strong>口径确认完成</strong><span>下一步先预览计算计划、参与行数和等价代码，再决定是否执行。</span></div>
                        <button type="button" onClick={continueToMetricExecution}>下一步：预览并执行计算<ChevronRight size={15} /></button>
                      </div>
                    </section>
                  )}
                </div>
              ) : profileView === "经营分析" ? (
                <BusinessAnalysis
                  key={`${datasetProfile.fileName}-${businessAnalysisPlan?.analysisType ?? "manual"}-${submittedQuery}`}
                  profile={datasetProfile}
                  agentPlan={businessAnalysisPlan}
                  question={submittedQuery}
                  onExecution={handleBusinessExecution}
                />
              ) : (
                <MetricExecution
                  key={metricContract ? `${metricContract.metricName}-${metricContract.formula}` : "locked"}
                  contract={metricContract}
                  profile={datasetProfile}
                  onExecution={handleMetricExecution}
                  onReviewEvidence={() => taskRunRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })}
                />
              )}
            </section>
          )}

          {!datasetProfile && <article className="answer-card">
            <div className="answer-header">
              <div className="assistant-icon"><Sparkles size={17} /></div>
              <div>
                <span>分析结论</span>
                <small>
                  {isAnalyzing
                    ? "本地 Qwen3:8b 正在识别问题意图"
                    : routingSource === "ollama"
                      ? `本地模型选择分析工具${routingLatency ? ` · ${routingLatency}ms` : ""}`
                      : routingSource === "rule-fallback"
                        ? "本地模型不可用，已使用规则兜底"
                        : "基于当前数据与固定业务口径"}
                </small>
              </div>
              <div className="confidence">
                {isAnalyzing ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />}
                {isAnalyzing ? "分析中" : analysisMode === "unsupported" ? "待接入" : "已校验"}
              </div>
            </div>

            <div className="question-context"><span>当前问题</span><strong>{submittedQuery}</strong></div>

            {isAnalyzing && (
              <p className="answer-summary">
                正在理解你的问题并选择相应的只读分析工具。指标计算仍使用已校验的数据快照，不由大模型直接编造。
              </p>
            )}

            {!isAnalyzing && (analysisMode === "overview" || analysisMode === "combined") && (
              <p className="answer-summary">
                数据范围内共有 <strong>{snapshot.kpis.totalOrders.toLocaleString("en-US")}</strong> 笔订单，其中
                <strong> {snapshot.kpis.deliveredOrders.toLocaleString("en-US")}</strong> 笔已送达；已送达订单商品 GMV 为
                <strong> R${(snapshot.kpis.productGmv / 1_000_000).toFixed(2)}M</strong>，平均客单价为
                <strong> R$ {snapshot.kpis.averageOrderValue.toFixed(2)}</strong>。商品 GMV 不含运费，也不等于企业收入或利润。
              </p>
            )}

            {!isAnalyzing && analysisMode === "trend" && (
              <p className="answer-summary">
                月度商品 GMV 在 <strong>{peakMonth.month}</strong> 达到范围内高点
                <strong> R$ {(peakMonth.productGmv / 1000).toFixed(1)}K</strong>。2018 年数据仅覆盖 1—8 月，
                因此不能据此判断 2018 全年是否高于 2017 全年；年度增长应改用同期月份比较。
              </p>
            )}

            {!isAnalyzing && analysisMode === "category" && (
              <p className="answer-summary">
                商品 GMV 前五品类依次为 <strong>{snapshot.topCategories.map((row) => row.category).join("、")}</strong>，
                合计贡献 <strong>{(topFiveShare * 100).toFixed(1)}%</strong> 的已送达订单商品 GMV。
                其中第一名 <strong>{snapshot.topCategories[0].category}</strong> 为
                <strong> R$ {(snapshot.topCategories[0].productGmv / 1_000_000).toFixed(2)}M</strong>。
              </p>
            )}

            {!isAnalyzing && analysisMode === "delivery" && (
              <p className="answer-summary">
                延迟送达订单的负面评价率为 <strong>{(lateDelivery.negativeReviewRate * 100).toFixed(2)}%</strong>，
                按时或提前送达订单为 <strong>{(onTimeDelivery.negativeReviewRate * 100).toFixed(2)}%</strong>，
                相差 <strong>{(snapshot.deliveryReview.rateGap * 100).toFixed(2)} 个百分点</strong>。
                该结果为观察性关联，不能单独证明配送延迟导致负面评价。
              </p>
            )}

            {!isAnalyzing && analysisMode === "unsupported" && (
              <p className="answer-summary">
                当前真实数据链路支持<strong>核心经营指标、月度 GMV 趋势、品类 GMV 排名、配送延迟与差评关系</strong>。
                你提出的问题尚未接入对应指标，
                因此本原型不会用默认答案代替分析结果。
              </p>
            )}

            {!isAnalyzing && (analysisMode === "overview" || analysisMode === "combined") && (
              <div className="metric-grid">
                {metricCards.map((metric) => (
                  <section className="metric-card" key={metric.label}>
                    <div className="metric-label">{metric.label}<CircleHelp size={14} /></div>
                    <strong>{metric.value}</strong><small>{metric.note}</small>
                  </section>
                ))}
              </div>
            )}

            {!isAnalyzing && (analysisMode === "trend" || analysisMode === "combined") && <section className="chart-card">
              <div className="chart-heading">
                <div><h2>月度商品 GMV 趋势</h2><p>单位：千巴西雷亚尔（R$ K）</p></div>
                <span className="chart-range">2017-01 — 2018-08</span>
              </div>
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 800, height: 220 }}>
                  <LineChart data={trendData} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
                    <CartesianGrid stroke="#e8edf5" vertical={false} />
                    <XAxis dataKey="month" interval={1} axisLine={false} tickLine={false} tick={{ fill: "#697386", fontSize: 12 }} />
                    <YAxis axisLine={false} tickLine={false} tick={{ fill: "#697386", fontSize: 12 }} />
                    <Tooltip
                      contentStyle={{ borderRadius: 10, border: "1px solid #dbe3ef", boxShadow: "0 8px 24px rgba(28,45,74,.08)" }}
                      formatter={(value) => ["R$ " + value + "K", "商品 GMV"]}
                    />
                    <Line type="monotone" dataKey="gmv" stroke="#2563eb" strokeWidth={2.5} dot={false} activeDot={{ r: 5, fill: "#2563eb" }} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </section>}

            {!isAnalyzing && analysisMode === "category" && <section className="chart-card">
              <div className="chart-heading">
                <div><h2>商品品类 GMV 前五名</h2><p>已送达订单商品金额；单位：千巴西雷亚尔（R$ K）</p></div>
                <span className="chart-range">Top 5</span>
              </div>
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 800, height: 220 }}>
                  <BarChart data={categoryData} layout="vertical" margin={{ top: 4, right: 22, left: 16, bottom: 0 }}>
                    <CartesianGrid stroke="#e8edf5" horizontal={false} />
                    <XAxis type="number" axisLine={false} tickLine={false} tick={{ fill: "#697386", fontSize: 12 }} />
                    <YAxis type="category" dataKey="category" width={142} axisLine={false} tickLine={false} tick={{ fill: "#526078", fontSize: 12 }} />
                    <Tooltip
                      contentStyle={{ borderRadius: 10, border: "1px solid #dbe3ef", boxShadow: "0 8px 24px rgba(28,45,74,.08)" }}
                      formatter={(value) => [`R$ ${value}K`, "商品 GMV"]}
                    />
                    <Bar dataKey="gmv" fill="#2563eb" radius={[0, 6, 6, 0]} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>}

            {!isAnalyzing && analysisMode === "delivery" && <section className="chart-card">
              <div className="chart-heading">
                <div><h2>配送状态与负面评价率</h2><p>负面评价：订单存在 review_score ≤ 2</p></div>
                <span className="chart-range">已送达且有评价</span>
              </div>
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 800, height: 220 }}>
                  <BarChart data={deliveryData} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
                    <CartesianGrid stroke="#e8edf5" vertical={false} />
                    <XAxis dataKey="status" axisLine={false} tickLine={false} tick={{ fill: "#526078", fontSize: 12 }} />
                    <YAxis domain={[0, 60]} unit="%" axisLine={false} tickLine={false} tick={{ fill: "#697386", fontSize: 12 }} />
                    <Tooltip
                      contentStyle={{ borderRadius: 10, border: "1px solid #dbe3ef", boxShadow: "0 8px 24px rgba(28,45,74,.08)" }}
                      formatter={(value) => [`${value}%`, "负面评价率"]}
                    />
                    <Bar dataKey="rate" radius={[7, 7, 0, 0]} isAnimationActive={false}>
                      {deliveryData.map((row) => <Cell key={row.status} fill={row.status === "延迟送达" ? "#f59e0b" : "#2563eb"} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>}
          </article>}
        </section>

        <aside className="evidence-panel">
          {datasetProfile ? (
            <>
              <div className="evidence-heading">
                <div><p className="eyebrow">Agent 依据</p><h2>计划从哪里来</h2></div>
                <ShieldCheck size={21} />
              </div>
              <div className="evidence-content agent-evidence-content">
                <div className="definition-card"><span>当前数据版本</span><p>{datasetProfile.fileName} · {datasetProfile.rowCount.toLocaleString("zh-CN")} 行 · {datasetProfile.columnCount} 列</p></div>
                <div className="definition-card"><span>候选数据粒度</span><p>{datasetProfile.grainSuggestion}</p></div>
                <div className={metricQualityImpact && (metricQualityImpact.affecting > 0 || metricQualityImpact.review > 0) ? "notice warning" : "notice"}>
                  <strong>质量检查</strong><p>{datasetProfile.qualityIssues.length
                    ? metricQualityImpact?.statement ?? `数据集记录 ${datasetProfile.qualityIssues.length} 项风险，需结合当前指标判断影响。`
                    : datasetProfile.qualityChecksSkipped.length > 0
                      ? `已运行的检查未发现明显问题，但有 ${datasetProfile.qualityChecksSkipped.length} 项检查因样本不足未运行。`
                      : "基础质量检查未发现明显问题，仍需确认业务口径。"}</p>
                </div>
                <div className="definition-card"><span>Agent 权限边界</span><p>模型只读取字段画像和质量摘要；数字由白名单确定性工具计算，删除与清洗必须再次确认。</p></div>
              </div>
            </>
          ) : (<>
          <div className="evidence-heading">
            <div><p className="eyebrow">可信依据</p><h2>结论从哪里来</h2></div>
            <ShieldCheck size={21} />
          </div>

          <div className="evidence-tabs" role="tablist" aria-label="可信依据">
            {(["口径", "SQL", "校验"] as EvidenceTab[]).map((tab) => (
              <button
                key={tab}
                role="tab"
                aria-selected={activeTab === tab}
                className={activeTab === tab ? "active" : ""}
                onClick={() => setActiveTab(tab)}
              >{tab}</button>
            ))}
          </div>

          {activeTab === "口径" && (
            <div className="evidence-content">
              {analysisMode === "category" ? (
                <>
                  <div className="definition-card">
                    <span>品类商品 GMV</span>
                    <p>{snapshot.definitions.categoryProductGmv}</p>
                  </div>
                  <div className="definition-card">
                    <span>排名范围</span>
                    <p>按商品 GMV 从高到低取前五名，所有品类总额仍用于计算占比。</p>
                  </div>
                  <div className="notice warning">
                    <strong>不可加总</strong>
                    <p>一笔订单可能包含多个品类，因此各品类订单数不能相加后当作总订单量。</p>
                  </div>
                </>
              ) : analysisMode === "delivery" ? (
                <>
                  <div className="definition-card">
                    <span>负面评价</span>
                    <p>{snapshot.definitions.negativeReview}</p>
                  </div>
                  <div className="definition-card">
                    <span>延迟送达</span>
                    <p>{snapshot.definitions.lateDelivery}</p>
                  </div>
                  <div className="notice warning">
                    <strong>因果边界</strong>
                    <p>{snapshot.deliveryReview.interpretationLimit}</p>
                  </div>
                </>
              ) : (
                <>
                  <div className="definition-card">
                    <span>商品 GMV</span>
                    <p>{snapshot.definitions.productGmv}</p>
                  </div>
                  <div className="definition-card">
                    <span>总订单量</span>
                    <p>{snapshot.definitions.totalOrders} 避免一笔订单包含多个商品时重复计算。</p>
                  </div>
                  <div className="notice warning">
                    <strong>范围限制</strong>
                    <p>{snapshot.scope.limitation} 如需比较，应使用 2017 年与 2018 年同期数据。</p>
                  </div>
                </>
              )}
            </div>
          )}

          {activeTab === "SQL" && (
            <div className="evidence-content">
              <div className="sql-card">
                <div><span>只读查询</span><span className="valid-mark"><Check size={13} />已通过</span></div>
                <pre>{analysisMode === "unsupported" ? "当前问题未生成 SQL。" : activeSql}</pre>
              </div>
              <p className="helper-copy">查询仅包含 SELECT，不允许修改或删除源数据。</p>
            </div>
          )}

          {activeTab === "校验" && (
            <div className="evidence-content">
              {visibleValidation.map((item) => (
                <div className="check-row" key={item.id} title={item.detail}>
                  <span className="check-icon"><Check size={14} /></span>
                  <span>{item.label}</span><small>{item.passed ? "通过" : "异常"}</small>
                </div>
              ))}
              <div className="notice">
                <strong>结论边界</strong>
                <p>观察性分组只能说明关联，不能单独证明配送延迟导致负面评价。</p>
              </div>
            </div>
          )}
          </>)}

          <footer className="attribution">
            <span>MetricGround 原型</span>
            <span>参考 Data Formulator（MIT）的交互思路，业务工作流为独立实现</span>
          </footer>
        </aside>
      </div>
    </main>
  );
}
