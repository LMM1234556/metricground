import type { MetricContract } from "./metric-contract";
import type { CellValue, DatasetProfile } from "./tabular-profile";
import { assessQualityImpact, type QualityImpactSummary } from "./quality-impact.ts";
import type { IndependentVerification } from "./independent-verification";

export type FilterOperator = "equals" | "not_equals" | "greater" | "greater_equal" | "less" | "less_equal" | "contains" | "not_empty";

export type FilterRule = {
  enabled: boolean;
  field: string;
  operator: FilterOperator;
  value: string;
};

export type ExecutionConfig = {
  baseFilter: FilterRule;
  ratioNumerator: FilterRule;
};

export type ExecutionPlan = {
  ready: boolean;
  errors: string[];
  steps: string[];
  sql: string;
  pandas: string;
};

export type ExecutionCheck = {
  label: string;
  passed: boolean;
  detail: string;
};

export type ExecutionResult = {
  value: number;
  displayValue: string;
  sourceRows: number;
  eligibleRows: number;
  distinctEntities: number;
  excludedMissingEntities: number;
  excludedInvalidValues: number;
  numerator: number | null;
  denominator: number | null;
  checks: ExecutionCheck[];
  warnings: string[];
  qualityImpact: QualityImpactSummary;
  engine: "browser-deterministic";
  independentVerification?: IndependentVerification;
};

export const FILTER_OPERATORS: Array<{ value: FilterOperator; label: string }> = [
  { value: "equals", label: "等于" },
  { value: "not_equals", label: "不等于" },
  { value: "greater", label: "大于" },
  { value: "greater_equal", label: "大于等于" },
  { value: "less", label: "小于" },
  { value: "less_equal", label: "小于等于" },
  { value: "contains", label: "包含" },
  { value: "not_empty", label: "非空" },
];

export function createExecutionConfig(profile: DatasetProfile): ExecutionConfig {
  const firstField = profile.columns[0]?.name ?? "";
  const categoryField = profile.columns.find((column) => column.inferredType === "文本" && column.name !== firstField)?.name ?? firstField;
  return {
    baseFilter: { enabled: false, field: firstField, operator: "equals", value: "" },
    ratioNumerator: { enabled: true, field: categoryField, operator: "equals", value: "" },
  };
}

function isMissing(value: CellValue | undefined) {
  return value === null
    || value === undefined
    || (typeof value === "string" && ["", "null", "undefined", "__null__"].includes(value.trim().toLowerCase()));
}

function finiteNumber(value: CellValue | undefined) {
  if (isMissing(value)) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !/^-?(?:\d+\.?\d*|\.\d+)$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function comparable(value: CellValue, target: string) {
  const numericValue = typeof value === "number" ? value : Number(String(value).trim());
  const numericTarget = Number(target.trim());
  if (Number.isFinite(numericValue) && Number.isFinite(numericTarget) && target.trim() !== "") {
    return { left: numericValue, right: numericTarget };
  }
  const valueDate = value instanceof Date ? value.getTime() : Date.parse(String(value));
  const targetDate = Date.parse(target);
  if (Number.isFinite(valueDate) && Number.isFinite(targetDate) && /[-/]/.test(target)) {
    return { left: valueDate, right: targetDate };
  }
  return { left: String(value).trim().toLowerCase(), right: target.trim().toLowerCase() };
}

function matchesRule(record: Record<string, CellValue>, rule: FilterRule) {
  if (!rule.enabled) return true;
  const value = record[rule.field];
  if (rule.operator === "not_empty") return !isMissing(value);
  if (isMissing(value)) return false;
  const { left, right } = comparable(value as CellValue, rule.value);
  if (rule.operator === "equals") return left === right;
  if (rule.operator === "not_equals") return left !== right;
  if (rule.operator === "contains") return String(left).includes(String(right));
  if (rule.operator === "greater") return left > right;
  if (rule.operator === "greater_equal") return left >= right;
  if (rule.operator === "less") return left < right;
  return left <= right;
}

function distinctValues(records: Array<Record<string, CellValue>>, field: string) {
  return new Set(records
    .map((record) => record[field])
    .filter((value) => !isMissing(value))
    .map((value) => value instanceof Date ? value.toISOString() : String(value).trim()));
}

function escapeIdentifier(identifier: string) {
  return `\`${identifier.replace(/`/g, "``")}\``;
}

function sqlCondition(rule: FilterRule, parameter: string) {
  if (!rule.enabled) return "1 = 1";
  const field = escapeIdentifier(rule.field);
  if (rule.operator === "not_empty") return `${field} IS NOT NULL AND TRIM(CAST(${field} AS CHAR)) <> ''`;
  if (rule.operator === "contains") return `${field} LIKE CONCAT('%', ${parameter}, '%')`;
  const operator = {
    equals: "=", not_equals: "<>", greater: ">", greater_equal: ">=", less: "<", less_equal: "<=",
  }[rule.operator];
  return `${field} ${operator} ${parameter}`;
}

function pandasCondition(frame: string, rule: FilterRule, valueName: string) {
  if (!rule.enabled) return `${frame}`;
  const field = JSON.stringify(rule.field);
  if (rule.operator === "not_empty") return `${frame}[${frame}[${field}].notna() & ${frame}[${field}].astype(str).str.strip().ne('')]`;
  if (rule.operator === "contains") return `${frame}[${frame}[${field}].astype(str).str.contains(${valueName}, case=False, na=False)]`;
  const operator = {
    equals: "eq", not_equals: "ne", greater: "gt", greater_equal: "ge", less: "lt", less_equal: "le",
  }[rule.operator];
  return `${frame}[${frame}[${field}].${operator}(${valueName})]`;
}

function ruleError(rule: FilterRule, label: string) {
  if (!rule.enabled) return null;
  if (!rule.field) return `${label}缺少字段`;
  if (rule.operator !== "not_empty" && !rule.value.trim()) return `${label}缺少比较值`;
  return null;
}

export function buildExecutionPlan(contract: MetricContract, config: ExecutionConfig): ExecutionPlan {
  const errors = [ruleError(config.baseFilter, "基础筛选")];
  if (contract.metricType === "ratio") errors.push(ruleError(config.ratioNumerator, "分子条件"));
  const validErrors = errors.filter((error): error is string => Boolean(error));
  const entity = escapeIdentifier(contract.statisticalUnit);
  const value = contract.valueField ? escapeIdentifier(contract.valueField) : null;
  const baseWhere = sqlCondition(config.baseFilter, ":filter_value");
  const numeratorWhere = sqlCondition(config.ratioNumerator, ":numerator_value");
  let expression = `COUNT(DISTINCT ${entity})`;
  let pandasResult = `result = base[${JSON.stringify(contract.statisticalUnit)}].nunique(dropna=True)`;
  if (contract.metricType === "amount" && value) {
    const numericSql = `CASE WHEN TRIM(CAST(${value} AS CHAR)) REGEXP '^-?([0-9]+([.][0-9]*)?|[.][0-9]+)$' THEN CAST(${value} AS DECIMAL(18, 4)) END`;
    expression = `SUM(${numericSql})`;
    pandasResult = `numeric = pd.to_numeric(base[${JSON.stringify(contract.valueField)}], errors='coerce')\nresult = numeric.sum(min_count=1)`;
  } else if (contract.metricType === "average" && value) {
    const numericSql = `CASE WHEN TRIM(CAST(${value} AS CHAR)) REGEXP '^-?([0-9]+([.][0-9]*)?|[.][0-9]+)$' THEN CAST(${value} AS DECIMAL(18, 4)) END`;
    expression = `SUM(${numericSql}) / NULLIF(COUNT(DISTINCT CASE WHEN ${numericSql} IS NOT NULL THEN ${entity} END), 0)`;
    pandasResult = [
      `numeric = pd.to_numeric(base[${JSON.stringify(contract.valueField)}], errors='coerce')`,
      "valid_rows = base[numeric.notna()]",
      `denominator = valid_rows[${JSON.stringify(contract.statisticalUnit)}].nunique(dropna=True)`,
      "result = numeric.sum(min_count=1) / denominator if denominator else None",
    ].join("\n");
  } else if (contract.metricType === "ratio") {
    expression = `COUNT(DISTINCT CASE WHEN ${numeratorWhere} THEN ${entity} END) / NULLIF(COUNT(DISTINCT ${entity}), 0)`;
    pandasResult = [
      `numerator_rows = ${pandasCondition("base", config.ratioNumerator, "numerator_value")}`,
      `numerator = numerator_rows[${JSON.stringify(contract.statisticalUnit)}].nunique(dropna=True)`,
      `denominator = base[${JSON.stringify(contract.statisticalUnit)}].nunique(dropna=True)`,
      "result = numerator / denominator if denominator else None",
    ].join("\n");
  }

  const sql = [
    "-- 参数值由界面绑定，不拼接用户输入",
    "WITH base AS (",
    "  SELECT *",
    "  FROM uploaded_data",
    `  WHERE ${baseWhere}`,
    ")",
    `SELECT ${expression} AS metric_value`,
    "FROM base;",
  ].join("\n");
  const pandas = [
    "import pandas as pd",
    "",
    "# df 由已上传文件读取；筛选值作为变量传入",
    `base = ${pandasCondition("df", config.baseFilter, "filter_value")}`,
    pandasResult,
  ].join("\n");
  const steps = [
    `读取 ${contract.source.fileName} 的 ${contract.source.rowCount.toLocaleString("zh-CN")} 行记录，不修改源文件`,
    config.baseFilter.enabled ? `按 ${config.baseFilter.field} 执行结构化基础筛选` : "使用全部上传记录作为基础范围",
    contract.metricType === "ratio" ? `按 ${config.ratioNumerator.field} 构造分子，并以基础范围作为分母` : `按合同公式计算 ${contract.metricName}`,
    "执行空值、分母为零、有限值和比例边界校验",
    "使用 DuckDB-WASM 对同一数据版本独立复算，并输出等价 SQL/pandas 代码与风险说明",
  ];
  return { ready: validErrors.length === 0, errors: validErrors, steps, sql, pandas };
}

export function executeMetricContract(
  contract: MetricContract,
  profile: DatasetProfile,
  config: ExecutionConfig,
): ExecutionResult {
  if (profile.fileName !== contract.source.fileName
    || profile.activeSheet !== contract.source.sheetName
    || profile.records.length !== contract.source.rowCount) {
    throw new Error("当前数据版本与指标合同不一致，请重新确认指标口径后再计算。");
  }
  const availableFields = new Set(profile.columns.map((column) => column.name));
  const requiredFields = [
    contract.statisticalUnit,
    ...((contract.metricType === "amount" || contract.metricType === "average") && contract.valueField ? [contract.valueField] : []),
    ...(config.baseFilter.enabled ? [config.baseFilter.field] : []),
    ...(contract.metricType === "ratio" && config.ratioNumerator.enabled ? [config.ratioNumerator.field] : []),
  ];
  const missingFields = [...new Set(requiredFields.filter((field) => !availableFields.has(field)))];
  if (missingFields.length > 0) {
    throw new Error(`指标合同或筛选引用了当前数据中不存在的字段：${missingFields.join("、")}。`);
  }
  if ((contract.metricType === "amount" || contract.metricType === "average") && !contract.valueField) {
    throw new Error("金额或平均指标缺少数值字段，不能执行计算。");
  }
  const plan = buildExecutionPlan(contract, config);
  if (!plan.ready) throw new Error(plan.errors.join("；"));
  const base = profile.records.filter((record) => matchesRule(record, config.baseFilter));
  const entityValues = distinctValues(base, contract.statisticalUnit);
  const excludedMissingEntities = base.filter((record) => isMissing(record[contract.statisticalUnit])).length;
  let excludedInvalidValues = 0;
  let numerator: number | null = null;
  let denominator: number | null = null;
  let value = 0;

  if (contract.metricType === "count") {
    value = entityValues.size;
  } else if (contract.metricType === "amount" || contract.metricType === "average") {
    const parsedRows = base.map((record) => ({ record, number: finiteNumber(record[contract.valueField ?? ""]) }));
    const validRows = parsedRows.filter((row): row is { record: Record<string, CellValue>; number: number } => row.number !== null);
    excludedInvalidValues = parsedRows.length - validRows.length;
    const total = validRows.reduce((sum, current) => sum + current.number, 0);
    const validEntities = distinctValues(validRows.map((row) => row.record), contract.statisticalUnit);
    value = validRows.length === 0
      ? Number.NaN
      : contract.metricType === "amount"
        ? total
        : validEntities.size === 0 ? Number.NaN : total / validEntities.size;
  } else {
    denominator = entityValues.size;
    numerator = distinctValues(base.filter((record) => matchesRule(record, config.ratioNumerator)), contract.statisticalUnit).size;
    value = denominator === 0 ? Number.NaN : numerator / denominator;
  }

  const isFiniteResult = Number.isFinite(value);
  const checks: ExecutionCheck[] = [
    { label: "源数据范围一致", passed: profile.records.length === contract.source.rowCount, detail: `合同记录 ${contract.source.rowCount} 行，当前读取 ${profile.records.length} 行。` },
    { label: "统计对象可计算", passed: entityValues.size > 0, detail: `基础范围内识别 ${entityValues.size} 个非空去重对象。` },
    { label: "结果为有限数值", passed: isFiniteResult, detail: isFiniteResult ? "计算结果不是空值、无穷大或非数。" : "结果为空、非数或分母为零。" },
  ];
  if (contract.metricType === "ratio") {
    checks.push({
      label: "比例边界正确",
      passed: isFiniteResult && value >= 0 && value <= 1 && (numerator ?? 0) <= (denominator ?? 0),
      detail: `分子 ${numerator ?? 0}，分母 ${denominator ?? 0}；预期 0 ≤ 分子 ≤ 分母。`,
    });
  }
  const runtimeScope = [
    config.baseFilter.enabled ? config.baseFilter.field : "",
    contract.metricType === "ratio" && config.ratioNumerator.enabled ? config.ratioNumerator.field : "",
  ].filter(Boolean).join(" ");
  const qualityImpact = assessQualityImpact(profile.qualityIssues, {
    metricName: contract.metricName,
    metricType: contract.metricType,
    entityField: contract.statisticalUnit,
    valueField: contract.valueField,
    timeField: contract.timeField,
    filterScope: contract.filterScope,
    decisionQuestion: contract.decisionQuestion,
    grainConfirmed: true,
    additionalScope: runtimeScope,
  });
  const warnings = [...contract.warnings];
  if (excludedMissingEntities > 0) warnings.push(`${excludedMissingEntities} 行统计对象为空，未进入去重计数。`);
  if (excludedInvalidValues > 0) warnings.push(`${excludedInvalidValues} 行数值缺失或无法转换，未进入金额计算。`);
  if (qualityImpact.affecting > 0 || qualityImpact.review > 0) {
    warnings.push(`当前仍有 ${qualityImpact.affecting} 项指标相关风险和 ${qualityImpact.review} 项待确认问题，结果只能作为带风险的分析预览。`);
  }

  const displayValue = contract.metricType === "ratio"
    ? isFiniteResult ? `${(value * 100).toFixed(2)}%` : "无法计算"
    : isFiniteResult ? value.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : "无法计算";
  return {
    value,
    displayValue,
    sourceRows: profile.records.length,
    eligibleRows: base.length,
    distinctEntities: entityValues.size,
    excludedMissingEntities,
    excludedInvalidValues,
    numerator,
    denominator,
    checks,
    warnings,
    qualityImpact,
    engine: "browser-deterministic",
  };
}
