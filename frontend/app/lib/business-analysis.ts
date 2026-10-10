import { isDistinctCountQuestion, isRankingQuestion, type AgentPlan } from "./agent-plan.ts";
import type { CellValue, DatasetProfile } from "./tabular-profile";
import type { IndependentVerification } from "./independent-verification";

export type BusinessAnalysisType = "group_compare" | "trend" | "top_n";
export type BusinessAggregation = "count_distinct" | "sum" | "average";
export type TimeGrain = "day" | "week" | "month" | "quarter";
export type SortDirection = "desc" | "asc";

export type BusinessAnalysisConfig = {
  analysisType: BusinessAnalysisType;
  aggregation: BusinessAggregation;
  entityField: string;
  valueField: string;
  groupField: string;
  timeField: string;
  timeGrain: TimeGrain;
  limit: number;
  sortDirection: SortDirection;
};

export type BusinessAnalysisPlan = {
  ready: boolean;
  errors: string[];
  steps: string[];
  sql: string;
  pandas: string;
};

export type BusinessAnalysisCheck = {
  label: string;
  passed: boolean;
  detail: string;
};

export type BusinessAnalysisRow = {
  key: string;
  value: number;
  sourceRows: number;
  distinctEntities: number;
  excludedInvalidValues: number;
};

export type BusinessAnalysisResult = {
  rows: BusinessAnalysisRow[];
  sourceRows: number;
  eligibleRows: number;
  excludedGroupingRows: number;
  excludedMissingEntities: number;
  excludedInvalidValues: number;
  fullGroupCount: number;
  checks: BusinessAnalysisCheck[];
  warnings: string[];
  engine: "browser-deterministic";
  independentVerification?: IndependentVerification;
};

export const ANALYSIS_TYPES: Array<{ value: BusinessAnalysisType; label: string; description: string }> = [
  { value: "group_compare", label: "分组比较", description: "比较地区、渠道、品类等分组" },
  { value: "trend", label: "时间趋势", description: "按日、周、月或季度观察变化" },
  { value: "top_n", label: "Top N", description: "找出最高或最低的若干分组" },
];

export const AGGREGATIONS: Array<{ value: BusinessAggregation; label: string }> = [
  { value: "count_distinct", label: "去重计数" },
  { value: "sum", label: "数值求和" },
  { value: "average", label: "按去重对象平均" },
];

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

function stableValue(value: CellValue | undefined) {
  if (isMissing(value)) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

function isValidDateValue(value: unknown) {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  const match = normalized.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T].*)?$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
    && (!/[ T]/.test(normalized) || Number.isFinite(Date.parse(normalized)));
}

function parseUtcDate(value: CellValue | undefined) {
  if (!isValidDateValue(value)) return null;
  if (value instanceof Date) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  const match = String(value).trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function isoWeek(date: Date) {
  const current = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = current.getUTCDay() || 7;
  current.setUTCDate(current.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(current.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((current.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${current.getUTCFullYear()}-W${pad(week)}`;
}

function timeBucket(value: CellValue | undefined, grain: TimeGrain) {
  const date = parseUtcDate(value);
  if (!date) return null;
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  if (grain === "day") return `${year}-${pad(month)}-${pad(date.getUTCDate())}`;
  if (grain === "week") return isoWeek(date);
  if (grain === "quarter") return `${year}-Q${Math.floor((month - 1) / 3) + 1}`;
  return `${year}-${pad(month)}`;
}

function escapeIdentifier(identifier: string) {
  return `\`${identifier.replace(/`/g, "``")}\``;
}

function inferAggregation(question: string): BusinessAggregation {
  if (/平均|均值|客单价|人均/i.test(question)) return "average";
  if (isDistinctCountQuestion(question)) return "count_distinct";
  if (/数量|个数|订单|客户|用户|商品数|去重/i.test(question) && !/金额|销售额|gmv|收入|营收/i.test(question)) return "count_distinct";
  return "sum";
}

function inferTopN(question: string) {
  const digit = question.match(/(?:前|top)\s*(\d+)/i)?.[1];
  if (digit) return Math.min(50, Math.max(1, Number(digit)));
  const chinese = question.match(/前\s*([一二三四五六七八九十])/i)?.[1];
  const values: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (chinese) return values[chinese];
  return isRankingQuestion(question) && /谁|哪个|哪家|哪种/i.test(question) ? 1 : 5;
}

export function createBusinessAnalysisConfig(
  profile: DatasetProfile,
  plan?: AgentPlan | null,
  question = "",
): BusinessAnalysisConfig {
  const fieldExists = (field: string | null | undefined) => field && profile.columns.some((column) => column.name === field) ? field : "";
  const entity = fieldExists(plan?.fieldBindings.entityField)
    || (!plan ? profile.columns.find((column) => column.isCandidateKey)?.name : "")
    || (!plan ? profile.columns[0]?.name : "")
    || "";
  const value = fieldExists(plan?.fieldBindings.valueField)
    || (!plan ? profile.columns.find((column) => column.inferredType === "数值" && column.name !== entity)?.name : "")
    || "";
  const group = fieldExists(plan?.fieldBindings.groupField)
    || (!plan ? profile.columns.find((column) => column.inferredType === "文本" && column.name !== entity)?.name : "")
    || "";
  const time = fieldExists(plan?.fieldBindings.timeField)
    || (!plan ? profile.columns.find((column) => column.inferredType === "日期")?.name : "")
    || "";
  const analysisType = plan && ["group_compare", "trend", "top_n"].includes(plan.analysisType)
    ? plan.analysisType as BusinessAnalysisType
    : "group_compare";
  return {
    analysisType,
    aggregation: inferAggregation(question),
    entityField: entity,
    valueField: value,
    groupField: group,
    timeField: time,
    timeGrain: /季度|按季/i.test(question) ? "quarter" : /按周|周度/i.test(question) ? "week" : /按日|每日|日度/i.test(question) ? "day" : "month",
    limit: inferTopN(question),
    sortDirection: /最低|最少|最小|倒数/i.test(question) ? "asc" : "desc",
  };
}

function aggregationSql(config: BusinessAnalysisConfig) {
  const entity = escapeIdentifier(config.entityField);
  if (config.aggregation === "count_distinct") return `COUNT(DISTINCT ${entity})`;
  const value = escapeIdentifier(config.valueField);
  const numeric = `CASE WHEN TRIM(CAST(${value} AS CHAR)) REGEXP '^-?([0-9]+([.][0-9]*)?|[.][0-9]+)$' THEN CAST(${value} AS DECIMAL(18, 4)) END`;
  if (config.aggregation === "sum") return `SUM(${numeric})`;
  return `SUM(${numeric}) / NULLIF(COUNT(DISTINCT CASE WHEN ${numeric} IS NOT NULL THEN ${entity} END), 0)`;
}

function pandasAggregation(config: BusinessAnalysisConfig) {
  const entity = JSON.stringify(config.entityField);
  if (config.aggregation === "count_distinct") return `.groupby('_analysis_key')[${entity}].nunique(dropna=True)`;
  const value = JSON.stringify(config.valueField);
  if (config.aggregation === "sum") return `.groupby('_analysis_key')[${value}].sum(min_count=1)`;
  return `.groupby('_analysis_key').apply(lambda g: pd.to_numeric(g[${value}], errors='coerce').sum(min_count=1) / g.loc[pd.to_numeric(g[${value}], errors='coerce').notna(), ${entity}].nunique() if g.loc[pd.to_numeric(g[${value}], errors='coerce').notna(), ${entity}].nunique() else None)`;
}

export function buildBusinessAnalysisPlan(profile: DatasetProfile, config: BusinessAnalysisConfig): BusinessAnalysisPlan {
  const names = new Set(profile.columns.map((column) => column.name));
  const errors: string[] = [];
  if (!config.entityField || !names.has(config.entityField)) errors.push("请选择当前数据中真实存在的统计对象字段");
  if (config.aggregation !== "count_distinct" && (!config.valueField || !names.has(config.valueField))) errors.push("求和或平均分析必须选择数值字段");
  if (config.analysisType === "trend" && (!config.timeField || !names.has(config.timeField))) errors.push("趋势分析必须选择时间字段");
  if (config.analysisType !== "trend" && (!config.groupField || !names.has(config.groupField))) errors.push("分组比较或 Top N 必须选择分组字段");
  if (config.analysisType === "top_n" && (!Number.isInteger(config.limit) || config.limit < 1 || config.limit > 50)) errors.push("Top N 必须是 1 至 50 的整数");

  const keyField = config.analysisType === "trend" ? config.timeField : config.groupField;
  const key = escapeIdentifier(keyField || "未选择字段");
  const timeExpression = config.timeGrain === "day" ? `DATE(${key})`
    : config.timeGrain === "week" ? `DATE_FORMAT(${key}, '%x-W%v')`
      : config.timeGrain === "quarter" ? `CONCAT(YEAR(${key}), '-Q', QUARTER(${key}))`
        : `DATE_FORMAT(${key}, '%Y-%m')`;
  const groupExpression = config.analysisType === "trend" ? timeExpression : key;
  const limit = config.analysisType === "top_n" ? `\nLIMIT ${Math.trunc(config.limit)}` : "";
  const sql = [
    "-- 字段来自已确认的结构化选择，不执行任意自然语言 SQL",
    `SELECT ${groupExpression} AS analysis_key,`,
    `       ${aggregationSql(config)} AS metric_value`,
    "FROM uploaded_data",
    `WHERE ${key} IS NOT NULL`,
    "GROUP BY analysis_key",
    `ORDER BY ${config.analysisType === "trend" ? "analysis_key ASC" : `metric_value ${config.sortDirection.toUpperCase()}`}${limit};`,
  ].join("\n");
  const keyCode = config.analysisType === "trend"
    ? `base['_analysis_key'] = pd.to_datetime(base[${JSON.stringify(config.timeField)}], errors='coerce').dt.to_period(${JSON.stringify(config.timeGrain === "day" ? "D" : config.timeGrain === "week" ? "W" : config.timeGrain === "quarter" ? "Q" : "M")}).astype(str)`
    : `base['_analysis_key'] = base[${JSON.stringify(config.groupField)}].astype('string').str.strip()`;
  const pandas = [
    "import pandas as pd",
    "",
    "base = df.copy()  # df 来自当前上传文件",
    keyCode,
    config.aggregation === "count_distinct" ? "" : `base[${JSON.stringify(config.valueField)}] = pd.to_numeric(base[${JSON.stringify(config.valueField)}], errors='coerce')`,
    `result = (base${pandasAggregation(config)}`,
    `  .sort_values(ascending=${config.analysisType === "trend" || config.sortDirection === "asc" ? "True" : "False"})${config.analysisType === "top_n" ? `.head(${config.limit})` : ""})`,
  ].filter(Boolean).join("\n");
  const analysisLabel = config.analysisType === "trend" ? `按${({ day: "日", week: "周", month: "月", quarter: "季度" } as const)[config.timeGrain]}聚合`
    : config.analysisType === "top_n" ? `计算并保留${config.sortDirection === "desc" ? "最高" : "最低"} ${config.limit} 个分组`
      : "按业务维度分组比较";
  return {
    ready: errors.length === 0,
    errors,
    steps: [
      `读取 ${profile.fileName} 的 ${profile.rowCount.toLocaleString("zh-CN")} 行记录，不修改源文件`,
      `按 ${config.entityField || "待选择字段"} 核对统计对象和去重粒度`,
      `${analysisLabel}，使用“${AGGREGATIONS.find((item) => item.value === config.aggregation)?.label}”口径`,
      "排除空分组、无效日期或不可转换数值并记录数量",
      "验证结果有限性、排序与行数勾稽，并使用 DuckDB-WASM 独立复算",
    ],
    sql,
    pandas,
  };
}

type Accumulator = {
  sourceRows: number;
  entities: Set<string>;
  validEntities: Set<string>;
  sum: number;
  validValues: number;
  invalidValues: number;
};

export function executeBusinessAnalysis(profile: DatasetProfile, config: BusinessAnalysisConfig): BusinessAnalysisResult {
  const plan = buildBusinessAnalysisPlan(profile, config);
  if (!plan.ready) throw new Error(plan.errors.join("；"));
  const groups = new Map<string, Accumulator>();
  let eligibleRows = 0;
  let excludedGroupingRows = 0;
  let excludedMissingEntities = 0;
  let excludedInvalidValues = 0;

  for (const record of profile.records) {
    const key = config.analysisType === "trend"
      ? timeBucket(record[config.timeField], config.timeGrain)
      : stableValue(record[config.groupField]);
    if (!key) {
      excludedGroupingRows += 1;
      continue;
    }
    eligibleRows += 1;
    const entity = stableValue(record[config.entityField]);
    if (!entity) excludedMissingEntities += 1;
    const current = groups.get(key) ?? {
      sourceRows: 0, entities: new Set<string>(), validEntities: new Set<string>(), sum: 0, validValues: 0, invalidValues: 0,
    };
    current.sourceRows += 1;
    if (entity) current.entities.add(entity);
    if (config.aggregation !== "count_distinct") {
      const numeric = finiteNumber(record[config.valueField]);
      if (numeric === null || (config.aggregation === "average" && !entity)) {
        current.invalidValues += 1;
        excludedInvalidValues += 1;
      } else {
        current.sum += numeric;
        current.validValues += 1;
        if (entity) current.validEntities.add(entity);
      }
    }
    groups.set(key, current);
  }

  const allRows = [...groups.entries()].map(([key, group]) => {
    const value = config.aggregation === "count_distinct" ? group.entities.size
      : config.aggregation === "sum" ? (group.validValues ? group.sum : Number.NaN)
        : group.validEntities.size ? group.sum / group.validEntities.size : Number.NaN;
    return {
      key,
      value,
      sourceRows: group.sourceRows,
      distinctEntities: group.entities.size,
      excludedInvalidValues: group.invalidValues,
    };
  });
  const finiteRows = allRows.filter((row) => Number.isFinite(row.value));
  const sorted = config.analysisType === "trend"
    ? finiteRows.sort((left, right) => left.key.localeCompare(right.key))
    : finiteRows.sort((left, right) => {
      const delta = config.sortDirection === "desc" ? right.value - left.value : left.value - right.value;
      return delta || left.key.localeCompare(right.key);
    });
  const rows = config.analysisType === "top_n" ? sorted.slice(0, config.limit) : sorted;
  const reconciledRows = [...groups.values()].reduce((sum, group) => sum + group.sourceRows, 0);
  const correctlySorted = rows.every((row, index) => index === 0 || (config.analysisType === "trend"
    ? rows[index - 1].key.localeCompare(row.key) <= 0
    : config.sortDirection === "desc" ? rows[index - 1].value >= row.value : rows[index - 1].value <= row.value));
  const checks: BusinessAnalysisCheck[] = [
    { label: "源数据行数勾稽", passed: eligibleRows + excludedGroupingRows === profile.rowCount && reconciledRows === eligibleRows, detail: `源数据 ${profile.rowCount} 行，进入分组 ${eligibleRows} 行，排除 ${excludedGroupingRows} 行。` },
    { label: "结果为有限数值", passed: rows.length > 0 && rows.every((row) => Number.isFinite(row.value)), detail: rows.length ? `输出 ${rows.length} 个有限数值结果。` : "没有可计算的结果。" },
    { label: "结果顺序正确", passed: correctlySorted, detail: config.analysisType === "trend" ? "时间分组按先后顺序排列。" : `结果按数值${config.sortDirection === "desc" ? "降序" : "升序"}排列。` },
  ];
  if (config.analysisType === "top_n") checks.push({ label: "Top N 边界正确", passed: rows.length <= config.limit, detail: `最多输出 ${config.limit} 个分组，实际输出 ${rows.length} 个。` });
  const warnings: string[] = [];
  if (excludedGroupingRows > 0) warnings.push(`${excludedGroupingRows} 行分组字段为空或时间无法识别，未进入分析。`);
  if (excludedMissingEntities > 0) warnings.push(`${excludedMissingEntities} 行统计对象为空；去重计数和按对象平均可能受影响。`);
  if (excludedInvalidValues > 0) warnings.push(`${excludedInvalidValues} 行数值缺失、无法转换或缺少统计对象，未进入数值聚合。`);
  if (allRows.length > finiteRows.length) warnings.push(`${allRows.length - finiteRows.length} 个分组没有有效数值，未展示。`);
  if (profile.qualityIssues.length > 0) warnings.push(`当前数据仍记录 ${profile.qualityIssues.length} 项质量风险，结论需结合质量处置状态使用。`);
  return {
    rows,
    sourceRows: profile.rowCount,
    eligibleRows,
    excludedGroupingRows,
    excludedMissingEntities,
    excludedInvalidValues,
    fullGroupCount: finiteRows.length,
    checks,
    warnings,
    engine: "browser-deterministic",
  };
}
