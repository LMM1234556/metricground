import type { TaskRun } from "./task-run";

export type EvidencePackage = {
  format: "metricground-evidence";
  version: "1.0";
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
  privacy: {
    rawRowsIncluded: false;
    statement: string;
  };
};

const RAW_DATA_KEYS = /^(?:records?|rows?|raw(?:data)?|dataframe|cells?|values?|filecontent)$/i;

function scrubToolInput(value: unknown, key = "", depth = 0): unknown {
  if (RAW_DATA_KEYS.test(key)) return "[已移除原始明细数据]";
  if (depth > 5) return "[超过证据包嵌套深度]";
  if (Array.isArray(value)) {
    if (value.length > 20) return { itemCount: value.length, preview: value.slice(0, 3).map((item) => scrubToolInput(item, "", depth + 1)) };
    return value.map((item) => scrubToolInput(item, "", depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, scrubToolInput(child, childKey, depth + 1)]));
  }
  if (typeof value === "string" && value.length > 500) return `${value.slice(0, 500)}…[已截断]`;
  return value;
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
  const withoutIntegrity = {
    format: "metricground-evidence" as const,
    version: "1.0" as const,
    exportedAt,
    task: { id: run.id, question: run.question, state: run.state, createdAt: run.createdAt, updatedAt: run.updatedAt },
    datasets: run.datasetVersions,
    plan: run.plan,
    analysisSpec: run.analysisSpec,
    approvals: run.approvals,
    toolCalls: run.toolCalls.map((call) => ({
      id: call.id,
      tool: call.tool,
      status: call.status,
      startedAt: call.startedAt,
      finishedAt: call.finishedAt,
      input: scrubToolInput(call.input) as Record<string, unknown>,
      outputSummary: call.outputSummary,
      error: call.error,
    })),
    validationSummary: run.validationSummary,
    resultSummary: run.resultSummary,
    failure: run.failure,
    events: run.events,
    privacy: {
      rawRowsIncluded: false as const,
      statement: "证据包只包含数据版本、结构化口径、工具摘要、人工确认和验证结论，不包含 Excel/CSV 原始数据行。",
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

export function evidenceAsMarkdown(evidence: EvidencePackage) {
  const tools = evidence.toolCalls.map((call) => `- ${call.tool}: ${call.status}${call.outputSummary ? ` - ${call.outputSummary}` : ""}${call.error ? ` - ${call.error}` : ""}`).join("\n") || "- 无";
  const approvals = evidence.approvals.map((approval) => `- ${approval.type}: ${approval.decision} - ${approval.statement}`).join("\n") || "- 无";
  const datasets = evidence.datasets.map((dataset) => `- ${dataset.fileName} / ${dataset.sheetName}: ${dataset.rowCount} 行 x ${dataset.columnCount} 列，版本 ${dataset.versionId}`).join("\n");
  return [
    "# MetricGround Agent 证据包",
    "",
    `- 任务：${evidence.task.question}`,
    `- 状态：${evidence.task.state}`,
    `- 任务编号：${evidence.task.id}`,
    `- 导出时间：${evidence.exportedAt}`,
    `- 完整性校验：${evidence.integrity.algorithm} / ${evidence.integrity.checksum}`,
    "",
    "## 数据版本",
    "",
    datasets,
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
    `> ${evidence.privacy.statement}`,
  ].join("\n");
}
