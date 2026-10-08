import type { BusinessAnalysisConfig } from "./business-analysis";
import type { MetricContract } from "./metric-contract";
import type { FilterRule } from "./metric-execution";
import type { CellValue, DatasetProfile } from "./tabular-profile";

export type AnalysisType = "count" | "sum" | "average" | "ratio" | "group_compare" | "trend" | "top_n";
export type AnalysisAggregation = "count_distinct" | "sum" | "average" | "ratio";
export type AnalysisTimeGrain = "day" | "week" | "month" | "quarter";
export type AnalysisSort = { field: "group" | "value" | "time"; direction: "asc" | "desc" };

export type DatasetVersion = {
  datasetId: string;
  versionId: string;
  fileName: string;
  sheetName: string;
  fileType: DatasetProfile["fileType"];
  fileSize: number;
  rowCount: number;
  columnCount: number;
  fingerprintAlgorithm: "fnv1a32-pair-v1";
};

export type AnalysisSource = {
  datasetId: string;
  versionId: string;
  alias: string;
  role: "primary" | "lookup";
};

export type RatioDefinition = {
  description: string;
  filter: FilterRule | null;
};

export type AnalysisSpec = {
  version: "1.0";
  id: string;
  question: string;
  analysisType: AnalysisType;
  aggregation: AnalysisAggregation;
  sources: AnalysisSource[];
  entityTable: string;
  entityField: string;
  valueTable: string | null;
  valueField: string | null;
  groupBy: Array<{ table: string; field: string }>;
  timeField: { table: string; field: string } | null;
  timeGrain: AnalysisTimeGrain | null;
  filters: FilterRule[];
  numerator: RatioDefinition | null;
  denominator: RatioDefinition | null;
  sort: AnalysisSort | null;
  limit: number | null;
  grainDescription: string;
  amountScope: string | null;
  assumptions: string[];
  unresolvedQuestions: string[];
  status: "draft" | "needs_confirmation" | "confirmed";
};

export type AnalysisSpecValidation = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

function stableCell(value: CellValue | undefined) {
  if (value === null || value === undefined) return "null";
  if (value instanceof Date) return `date:${value.toISOString()}`;
  return `${typeof value}:${String(value).trim()}`;
}

function fnv1a(value: string, seed: number) {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function profileFingerprintInput(profile: DatasetProfile) {
  const fields = profile.columns.map((column) => column.name);
  const rows = profile.records.map((record) => fields.map((field) => stableCell(record[field])).join("\u001f"));
  return [
    profile.fileName,
    profile.activeSheet,
    String(profile.fileSize),
    String(profile.rowCount),
    String(profile.columnCount),
    fields.join("\u001e"),
    rows.join("\u001d"),
  ].join("\u001c");
}

export function createDatasetVersion(profile: DatasetProfile): DatasetVersion {
  const input = profileFingerprintInput(profile);
  const fingerprint = `${fnv1a(input, 0x811c9dc5)}${fnv1a(input, 0x9e3779b9)}`;
  const datasetId = `dataset_${fnv1a(`${profile.fileName}\u001f${profile.activeSheet}`, 0x811c9dc5)}`;
  return {
    datasetId,
    versionId: `${datasetId}_${profile.rowCount}x${profile.columnCount}_${fingerprint}`,
    fileName: profile.fileName,
    sheetName: profile.activeSheet,
    fileType: profile.fileType,
    fileSize: profile.fileSize,
    rowCount: profile.rowCount,
    columnCount: profile.columnCount,
    fingerprintAlgorithm: "fnv1a32-pair-v1",
  };
}

function sourceFromVersion(version: DatasetVersion, alias = "primary"): AnalysisSource {
  return { datasetId: version.datasetId, versionId: version.versionId, alias, role: "primary" };
}

function metricAggregation(contract: MetricContract): AnalysisAggregation {
  if (contract.metricType === "amount") return "sum";
  if (contract.metricType === "count") return "count_distinct";
  return contract.metricType;
}

function metricAnalysisType(contract: MetricContract): AnalysisType {
  if (contract.metricType === "amount") return "sum";
  return contract.metricType;
}

export function analysisSpecFromMetricContract(
  contract: MetricContract,
  profile: DatasetProfile,
  filters: FilterRule[] = [],
): AnalysisSpec {
  const version = createDatasetVersion(profile);
  const primary = "primary";
  return {
    version: "1.0",
    id: `analysis_${version.versionId}_${metricAnalysisType(contract)}`,
    question: contract.decisionQuestion,
    analysisType: metricAnalysisType(contract),
    aggregation: metricAggregation(contract),
    sources: [sourceFromVersion(version, primary)],
    entityTable: primary,
    entityField: contract.statisticalUnit,
    valueTable: contract.valueField ? primary : null,
    valueField: contract.valueField,
    groupBy: [],
    timeField: contract.timeField ? { table: primary, field: contract.timeField } : null,
    timeGrain: null,
    filters,
    numerator: contract.metricType === "ratio" ? { description: "待执行配置确认的分子条件", filter: null } : null,
    denominator: contract.metricType === "ratio" ? { description: "筛选范围内去重统计对象", filter: null } : null,
    sort: null,
    limit: null,
    grainDescription: contract.grainDescription,
    amountScope: contract.valueField ? `${contract.metricName}使用字段“${contract.valueField}”，范围为：${contract.filterScope}` : null,
    assumptions: [...contract.warnings],
    unresolvedQuestions: contract.metricType === "ratio" ? ["需把已确认的分子条件绑定为结构化筛选规则"] : [],
    status: contract.metricType === "ratio" ? "needs_confirmation" : "confirmed",
  };
}

export function analysisSpecFromBusinessConfig(
  config: BusinessAnalysisConfig,
  profile: DatasetProfile,
  question: string,
): AnalysisSpec {
  const version = createDatasetVersion(profile);
  const primary = "primary";
  return {
    version: "1.0",
    id: `analysis_${version.versionId}_${config.analysisType}`,
    question,
    analysisType: config.analysisType,
    aggregation: config.aggregation,
    sources: [sourceFromVersion(version, primary)],
    entityTable: primary,
    entityField: config.entityField,
    valueTable: config.aggregation === "count_distinct" ? null : primary,
    valueField: config.aggregation === "count_distinct" ? null : config.valueField,
    groupBy: config.analysisType === "trend" ? [] : [{ table: primary, field: config.groupField }],
    timeField: config.analysisType === "trend" ? { table: primary, field: config.timeField } : null,
    timeGrain: config.analysisType === "trend" ? config.timeGrain : null,
    filters: [],
    numerator: null,
    denominator: null,
    sort: config.analysisType === "trend"
      ? { field: "time", direction: "asc" }
      : { field: "value", direction: config.sortDirection },
    limit: config.analysisType === "top_n" ? config.limit : null,
    grainDescription: profile.grainSuggestion,
    amountScope: config.aggregation === "count_distinct" ? null : `使用数值字段“${config.valueField}”进行${config.aggregation === "sum" ? "求和" : "平均值"}计算`,
    assumptions: [],
    unresolvedQuestions: [],
    status: "confirmed",
  };
}

export function validateAnalysisSpec(spec: AnalysisSpec, versions: DatasetVersion[]): AnalysisSpecValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const aliases = new Set(spec.sources.map((source) => source.alias));
  const versionIds = new Set(versions.map((version) => version.versionId));

  if (spec.version !== "1.0") errors.push("不支持的 AnalysisSpec 版本");
  if (!spec.question.trim()) errors.push("缺少原始业务问题");
  if (spec.sources.length < 1 || spec.sources.length > 3) errors.push("分析数据源必须为 1 至 3 个");
  if (aliases.size !== spec.sources.length) errors.push("数据源别名必须唯一");
  if (spec.sources.filter((source) => source.role === "primary").length !== 1) errors.push("必须且只能有一个主数据源");
  spec.sources.forEach((source) => {
    if (!versionIds.has(source.versionId)) errors.push(`数据版本不存在或已变化：${source.alias}`);
  });
  if (!aliases.has(spec.entityTable) || !spec.entityField) errors.push("统计对象必须绑定到真实数据源字段");
  if (["sum", "average"].includes(spec.aggregation) && (!spec.valueTable || !spec.valueField)) {
    errors.push("求和或平均分析必须绑定数值字段");
  }
  if (spec.valueTable && !aliases.has(spec.valueTable)) errors.push("数值字段引用了不存在的数据源");
  if (["group_compare", "top_n"].includes(spec.analysisType) && spec.groupBy.length === 0) {
    errors.push("分组比较或 Top N 必须指定分组字段");
  }
  spec.groupBy.forEach((group) => {
    if (!aliases.has(group.table) || !group.field) errors.push("分组字段引用无效");
  });
  if (spec.analysisType === "trend" && (!spec.timeField || !spec.timeGrain)) errors.push("趋势分析必须指定时间字段和时间粒度");
  if (spec.timeField && !aliases.has(spec.timeField.table)) errors.push("时间字段引用了不存在的数据源");
  if (spec.analysisType === "top_n" && (!Number.isInteger(spec.limit) || (spec.limit ?? 0) < 1 || (spec.limit ?? 0) > 50)) {
    errors.push("Top N 必须是 1 至 50 的整数");
  }
  if (spec.aggregation === "ratio" && (!spec.numerator?.description || !spec.denominator?.description)) {
    errors.push("比例指标必须定义分子和分母");
  }
  if (!spec.grainDescription.trim()) errors.push("必须说明分析数据粒度");
  if (["sum", "average"].includes(spec.aggregation) && !spec.amountScope) warnings.push("尚未说明金额或数值字段的业务范围");
  if (spec.unresolvedQuestions.length > 0) errors.push(`仍有 ${spec.unresolvedQuestions.length} 个待确认问题`);
  if (spec.status !== "confirmed") errors.push("AnalysisSpec 尚未完成人工确认");

  return { valid: errors.length === 0, errors, warnings };
}

export function sameDatasetVersions(expected: DatasetVersion[], actual: DatasetVersion[]) {
  if (expected.length !== actual.length) return false;
  const actualIds = new Set(actual.map((version) => version.versionId));
  return expected.every((version) => actualIds.has(version.versionId));
}
