import type { TaskRun } from "./task-run";

export type EvidencePackage = {
  format: "metricground-evidence";
  version: "1.0" | "1.1";
  exportedAt: string;
  integrity: { algorithm: "fnv1a32-pair-v1"; checksum: string };
  task: {
    id: string;
    question: string;
    state: TaskRun["state"];
    createdAt: string;
    updatedAt: string;
  };
  datasets: TaskRun["datasetVersions"];
  plan: string[];
  analysisSpec: TaskRun["analysisSpec"];
  approvals: TaskRun["approvals"];
  toolCalls: Array<{
    id: string;
    tool: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    input: Record<string, unknown>;
    outputSummary: string | null;
    error: string | null;
  }>;
  validationSummary: string | null;
  resultSummary: string | null;
  failure: TaskRun["failure"];
  events: TaskRun["events"];
  planningEvidence?: TaskRun["planningEvidence"] | null;
  qualityEvidence?: TaskRun["qualityEvidence"] | null;
  resultEvidence?: TaskRun["resultEvidence"] | null;
  privacy: {
    rawRowsIncluded: false;
    statement: string;
  };
};

const RAW_DATA_KEYS = /^(?:records?|rows?|raw(?:data)?|dataframe|cells?|values?|filecontent)$/i;
const SECRET_KEYS = /^(?:api[_-]?key|authorization|password|secret|access[_-]?token|refresh[_-]?token)$/i;

function scrubToolInput(value: unknown, key = "", depth = 0): unknown {
  if (RAW_DATA_KEYS.test(key)) return "[已移除原始明细数据]";
  if (SECRET_KEYS.test(key)) return "[已移除凭据]";
  if (depth > 5) return "[超过证据包嵌套深度]";
  if (Array.isArray(value)) {
    if (value.length > 20) return { itemCount: value.length, preview: value.slice(0, 3).map((item) => scrubToolInput(item, "", depth + 1)) };
    return value.map((item) => scrubToolInput(item, "", depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined).map(([childKey, child]) => [childKey, scrubToolInput(child, childKey, depth + 1)]));
  }
  if (typeof value === "string" && value.length > 500) return `${value.slice(0, 500)}…[已截断]`;
  return value;
}

function scrubCallInput(tool: string, input: Record<string, unknown>) {
  const scrubbed = scrubToolInput(input) as Record<string, unknown>;
  if (tool !== "validate_result") return scrubbed;
  // These are structured verification evidence, not arbitrary tool payloads.
  // Keep the actual SQL and bound parameters intact so a reviewer can rerun them.
  if (typeof input.sql === "string") scrubbed.sql = input.sql;
  if (Array.isArray(input.parameters) && input.parameters.every((value) => typeof value === "string" || typeof value === "number")) {
    scrubbed.parameters = [...input.parameters];
  }
  if (Array.isArray(input.aggregateResults)) {
    scrubbed.aggregateResults = input.aggregateResults.slice(0, 100).map((row) => {
      const aggregate = row as { key?: unknown; value?: unknown };
      return { key: typeof aggregate?.key === "string" ? aggregate.key : null, value: typeof aggregate?.value === "number" ? aggregate.value : null };
    });
    scrubbed.aggregatesTruncated = Boolean(input.aggregatesTruncated) || input.aggregateResults.length > 100;
  }
  return scrubbed;
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableValue(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fnv1a(value: string, seed: number) {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function checksum(value: unknown) {
  const stable = stableValue(value);
  return `${fnv1a(stable, 0x811c9dc5)}${fnv1a(stable, 0x9e3779b9)}`;
}

export function buildEvidencePackage(run: TaskRun, exportedAt = new Date().toISOString()): EvidencePackage {
  // A completed analysis is an immutable evidence snapshot. Download actions are
  // still recorded on the persisted TaskRun, but they must not change the
  // report/JSON contents or make two formats from one run disagree.
  const completedAt = run.state === "COMPLETED"
    ? [...run.events].reverse().find((event) => event.to === "COMPLETED")?.at ?? run.updatedAt
    : null;
  const evidenceRun = completedAt ? {
    ...run,
    updatedAt: completedAt,
    toolCalls: run.toolCalls.filter((call) => call.tool !== "export_evidence"),
  } : run;
  const snapshotAt = completedAt ?? exportedAt;
  const withoutIntegrity = {
    format: "metricground-evidence" as const,
    version: "1.1" as const,
    exportedAt: snapshotAt,
    task: { id: evidenceRun.id, question: evidenceRun.question, state: evidenceRun.state, createdAt: evidenceRun.createdAt, updatedAt: evidenceRun.updatedAt },
    datasets: evidenceRun.datasetVersions,
    plan: evidenceRun.plan,
    analysisSpec: evidenceRun.analysisSpec,
    planningEvidence: evidenceRun.planningEvidence ?? null,
    qualityEvidence: evidenceRun.qualityEvidence ?? null,
    resultEvidence: evidenceRun.resultEvidence ?? null,
    approvals: evidenceRun.approvals,
    toolCalls: evidenceRun.toolCalls.map((call) => ({
      id: call.id,
      tool: call.tool,
      status: call.status,
      startedAt: call.startedAt,
      finishedAt: call.finishedAt,
      input: scrubCallInput(call.tool, call.input),
      outputSummary: call.outputSummary,
      error: call.error,
    })),
    validationSummary: evidenceRun.validationSummary,
    resultSummary: evidenceRun.resultSummary,
    failure: evidenceRun.failure,
    events: evidenceRun.events,
    privacy: {
      rawRowsIncluded: false as const,
      statement: "证据包包含数据版本、结构化口径、聚合结果、质量风险与判断、规划来源、工具摘要和复核 SQL，不包含 Excel/CSV 原始数据行。筛选参数与分组名称可能包含业务信息，请确认后分享。",
    },
  };
  return {
    ...withoutIntegrity,
    integrity: { algorithm: "fnv1a32-pair-v1", checksum: checksum(withoutIntegrity) },
  };
}

export function verifyEvidencePackage(evidence: EvidencePackage) {
  const { integrity, ...content } = evidence;
  return integrity.algorithm === "fnv1a32-pair-v1" && integrity.checksum === checksum(content);
}

export function evidenceAsJson(evidence: EvidencePackage) {
  return JSON.stringify(evidence, null, 2);
}

function codeBlock(value: string, language = "json") {
  const longest = Math.max(2, ...(value.match(/`+/g) ?? []).map((match) => match.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${language}\n${value}\n${fence}`;
}

function renderAnalysisSpec(evidence: EvidencePackage) {
  const spec = evidence.analysisSpec;
  if (!spec) return "未记录结构化指标口径；画像/质量检查任务不要求计算指标。";
  const activeFilters = spec.filters.filter((filter) => filter.enabled);
  return [
    `- 分析类型：${spec.analysisType}；聚合方式：${spec.aggregation}；状态：${spec.status}`,
    `- 统计对象：${spec.entityTable}.${spec.entityField}`,
    `- 数值字段：${spec.valueField ? `${spec.valueTable ?? spec.entityTable}.${spec.valueField}` : "不使用数值字段"}`,
    `- 分组字段：${spec.groupBy.map((group) => `${group.table}.${group.field}`).join("、") || "无"}`,
    `- 时间字段及粒度：${spec.timeField ? `${spec.timeField.table}.${spec.timeField.field} / ${spec.timeGrain ?? "未记录"}` : "未设置时间/趋势字段；日期筛选以基础筛选规则为准"}`,
    `- 基础筛选：${activeFilters.length ? JSON.stringify(activeFilters) : "无；包含当前数据版本的全部记录/状态（计算规则仍可能排除无效值）"}`,
    `- 数据粒度：${spec.grainDescription}`,
    `- 金额/业务范围：${spec.amountScope ?? "未记录；不能从字段名推断收入或利润"}`,
    "- 业务限制：数值求和不自动等同于企业收入或利润；币种、税费、退款和运费含义以人工确认的定义为准，未记录的定义不补推。",
    "",
    "完整结构化口径（含来源、比例分子分母、筛选、排序和限制）：",
    "",
    codeBlock(JSON.stringify(spec, null, 2)),
  ].join("\n");
}

function renderQuality(evidence: EvidencePackage) {
  const quality = evidence.qualityEvidence;
  if (!quality) return "未记录质量风险明细及处置快照（历史任务）；风险数量摘要不代表风险已解决。";
  const decisionLabels = { pending: "未判断", kept: "保留原样/暂不处理（未修复）", approved: "批准处理建议或人工核实（不代表清洗已执行）" };
  return [
    `- 数据版本：${quality.datasetVersionId}；判断快照时间：${quality.capturedAt}`,
    `- 风险数量：${quality.issues.length}；以下为快照时的判断，不补写历史处置。`,
    "",
    quality.issues.map((issue, index) => [
      `### ${index + 1}. ${issue.title}`,
      "",
      `- 检查：${issue.check}；风险：${issue.severity}；字段：${issue.field ?? "整表"}`,
      `- 证据：${issue.evidence}`,
      `- 潜在影响：${issue.impact}`,
      `- 建议：${issue.recommendation}`,
      `- 当前判断：${decisionLabels[issue.decision]}`,
      `- 可用处理规则：${issue.supportedRepair ?? "仅人工核实"}`,
    ].join("\n")).join("\n\n") || "本次基础规则未发现风险；不等于数据完全无问题。",
    "",
    "未执行的质量检查：",
    "",
    quality.checksSkipped.map((check) => `- ${check.check} / ${check.field}：${check.reason}`).join("\n") || "无",
  ].join("\n");
}

function renderPlanning(evidence: EvidencePackage) {
  const planning = evidence.planningEvidence;
  if (!planning) return "未记录规划来源、模型及调用用量（历史任务）；不能据此声称由大模型规划，也不能将未知用量记为 0。";
  return [
    `- 规划来源：${planning.source}；平台：${planning.provider ?? "不适用/未记录"}；模型：${planning.model ?? "无"}`,
    `- 工具规划步骤：${planning.stepsExecuted}；尝试次数：${planning.attempts ?? "未记录"}；规划耗时：${planning.latencyMs} ms`,
    `- Token 用量：输入 ${planning.usage?.inputTokens ?? "未记录"}，输出 ${planning.usage?.outputTokens ?? "未记录"}`,
    "- 范围说明：模型/规则只生成候选分析计划，最终计算使用人工批准的结构化口径和确定性引擎；规划用量不是费用账单，也不包含未记录的失败请求。",
  ].join("\n");
}

function renderVerification(evidence: EvidencePackage) {
  const calls = evidence.toolCalls.filter((call) => call.tool === "validate_result" && typeof call.input.sql === "string");
  if (!calls.length) return "未记录独立复核 SQL；不能从验证摘要还原实际执行查询。画像/质量任务可能仅执行基础检查。";
  return calls.map((call) => {
    const input = call.input;
    const sql = String(input.sql);
    const checks = Array.isArray(input.checks) ? input.checks as Array<{ label: string; passed: boolean; detail: string }> : [];
    return [
      `- 引擎：${input.engine ?? "未记录"} / ${input.engineVersion ?? "未记录"}；状态：${input.status ?? "未记录"}`,
      `- 数据版本：${input.datasetVersionId ?? "未记录"}；耗时：${input.durationMs ?? "未记录"} ms`,
      "",
      ...checks.map((check) => `- ${check.passed ? "通过" : "未通过"}：${check.label} — ${check.detail}`),
      "",
      sql.includes("…[已截断]") ? "警告：历史复核 SQL 已截断，无法直接完整复算；不会伪造缺失部分。" : "完整复核 SQL：",
      "",
      codeBlock(sql, "sql"),
      "",
      "绑定参数（按占位符出现顺序）：",
      "",
      Array.isArray(input.parameters) ? codeBlock(JSON.stringify(input.parameters, null, 2)) : "未记录（历史任务）；无占位符的查询无需绑定参数。",
      "",
      "复算说明：需要另行取得相同版本的源文件；原始数据不在证据包内。复核导入会去除文本首尾空白，将空值/空字符串/null/undefined/__null__ 转为 NULL，日期对象转 ISO 文本，其余非空值转文本。将这些规范化字段导入 DuckDB 临时表，并把 SQL 的 \"__TABLE__\" 替换为该表名，再按顺序绑定参数。不要将本 SQL 摘要当作原始 CSV 的无转换查询。",
      "",
      "独立引擎聚合参考值（非原始明细）：",
      "",
      codeBlock(JSON.stringify({ value: input.referenceValue ?? null, aggregates: input.aggregateResults ?? null, truncated: input.aggregatesTruncated ?? null }, null, 2)),
      "",
      "本项目内两种计算引擎对账不等于第三方独立审计；校验码仅用于检查文件一致性，不是数字签名或正确性认证。",
    ].join("\n");
  }).join("\n\n");
}

export function evidenceAsMarkdown(evidence: EvidencePackage) {
  const tools = evidence.toolCalls.map((call) => `- ${call.tool}: ${call.status}${call.outputSummary ? ` - ${call.outputSummary}` : ""}${call.error ? ` - ${call.error}` : ""}`).join("\n") || "- 无";
  const approvals = evidence.approvals.map((approval) => `- ${approval.type}: ${approval.decision} - ${approval.statement}`).join("\n") || "- 无";
  const datasets = evidence.datasets.map((dataset) => `- ${dataset.fileName} / ${dataset.sheetName}: ${dataset.rowCount} 行 x ${dataset.columnCount} 列，版本 ${dataset.versionId}`).join("\n");
  return [
    "# MetricGround 分析报告与审计证据",
    "",
    `- 任务：${evidence.task.question}`,
    `- 状态：${evidence.task.state}`,
    `- 任务编号：${evidence.task.id}`,
    `- 证据快照时间：${evidence.exportedAt}`,
    `- 完整性校验：${evidence.integrity.algorithm} / ${evidence.integrity.checksum}`,
    "",
    "## 数据版本",
    "",
    datasets,
    "",
    "## 结构化分析口径（批准状态见下）",
    "",
    renderAnalysisSpec(evidence),
    "",
    "## 质量风险与处置快照",
    "",
    renderQuality(evidence),
    "",
    "## 规划来源与模型用量",
    "",
    renderPlanning(evidence),
    "",
    "## Agent 计划",
    "",
    evidence.plan.map((step, index) => `${index + 1}. ${step}`).join("\n") || "无",
    "",
    "## 人工确认",
    "",
    approvals,
    "",
    "## 工具调用",
    "",
    tools,
    "",
    "## 结果与验证",
    "",
    `- 结果摘要：${evidence.resultSummary ?? "无"}`,
    `- 验证摘要：${evidence.validationSummary ?? "无"}`,
    `- 失败记录：${evidence.failure ? `${evidence.failure.code} - ${evidence.failure.message}` : "无"}`,
    "",
    "结构化主计算结果（非原始明细，分组结果最多保存 100 组，截断时显式标记）：",
    "",
    evidence.resultEvidence ? codeBlock(JSON.stringify(evidence.resultEvidence, null, 2)) : "未记录结构化结果（历史任务或仅画像/质量检查）；结果摘要可能经过四舍五入。",
    "",
    "## DuckDB 独立复核详情与复算",
    "",
    renderVerification(evidence),
    "",
    `> ${evidence.privacy.statement}`,
  ].join("\n");
}
