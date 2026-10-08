import * as duckdb from "@duckdb/duckdb-wasm";
import { createDatasetVersion } from "./analysis-spec";
import type { BusinessAnalysisConfig, BusinessAnalysisResult } from "./business-analysis";
import type { ExecutionConfig, ExecutionResult, FilterRule } from "./metric-execution";
import type { MetricContract } from "./metric-contract";
import type { CellValue, DatasetProfile } from "./tabular-profile";
import {
  approximatelyEqual,
  verificationPassed,
  type IndependentVerification,
  type IndependentVerificationCheck,
} from "./independent-verification";

const DUCKDB_WASM_VERSION = "1.32.0";
const DUCKDB_STARTUP_TIMEOUT_MS = 15_000;
const NUMERIC_PATTERN = "^-?([0-9]+([.][0-9]*)?|[.][0-9]+)$";
const configuredAssetBase = process.env.NEXT_PUBLIC_DUCKDB_ASSET_BASE_URL?.trim().replace(/\/$/, "");

function configuredBundles(assetBase: string): duckdb.DuckDBBundles {
  return {
    mvp: {
      mainModule: `${assetBase}/duckdb-mvp.wasm`,
      mainWorker: `${assetBase}/duckdb-browser-mvp.worker.js`,
    },
    eh: {
      mainModule: `${assetBase}/duckdb-eh.wasm`,
      mainWorker: `${assetBase}/duckdb-browser-eh.worker.js`,
    },
  };
}

// The version-pinned official CDN avoids shipping 33–38 MiB WASM files as
// Worker static assets. Offline deployments can opt into /duckdb after running
// `npm run sync:duckdb`.
const bundles = configuredAssetBase
  ? configuredBundles(configuredAssetBase)
  : duckdb.getJsDelivrBundles();

let databasePromise: Promise<duckdb.AsyncDuckDB> | null = null;
let verificationSequence = 0;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function database() {
  if (!databasePromise) {
    databasePromise = (async () => {
      if (typeof Worker === "undefined") throw new Error("当前环境不支持 Web Worker，无法启动 DuckDB 独立复核。");
      const bundle = await duckdb.selectBundle(bundles);
      if (!bundle.mainWorker) throw new Error("无法选择可用的 DuckDB Worker。 ");
      const worker = await duckdb.createWorker(bundle.mainWorker);
      const instance = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
      try {
        await withTimeout(
          instance.instantiate(bundle.mainModule, bundle.pthreadWorker),
          DUCKDB_STARTUP_TIMEOUT_MS,
          "DuckDB 独立复核引擎启动超时。",
        );
        await instance.open({
          path: ":memory:",
          query: { castBigIntToDouble: true, castDecimalToDouble: true },
        });
        return instance;
      } catch (error) {
        worker.terminate();
        throw error;
      }
    })().catch((error) => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

function quoteIdentifier(identifier: string) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function isMissing(value: CellValue | undefined) {
  return value === null
    || value === undefined
    || (typeof value === "string" && ["", "null", "undefined", "__null__"].includes(value.trim().toLowerCase()));
}

function normalizedRecords(profile: DatasetProfile) {
  return profile.records.map((record) => Object.fromEntries(profile.columns.map((column) => {
    const value = record[column.name];
    if (isMissing(value)) return [column.name, null];
    if (value instanceof Date) return [column.name, value.toISOString()];
    return [column.name, String(value).trim()];
  })));
}

function rowsFromArrow<T>(table: { toArray(): unknown[] }): T[] {
  return table.toArray().map((row) => {
    const candidate = row as { toJSON?: () => unknown };
    return (candidate.toJSON ? candidate.toJSON() : candidate) as T;
  });
}

async function withVerificationTable<T>(profile: DatasetProfile, run: (connection: duckdb.AsyncDuckDBConnection, tableName: string) => Promise<T>) {
  const db = await database();
  const id = ++verificationSequence;
  const fileName = `metricground_verification_${id}.json`;
  const tableName = `verification_input_${id}`;
  await db.registerFileText(fileName, JSON.stringify(normalizedRecords(profile)));
  const connection = await db.connect();
  try {
    await connection.insertJSONFromPath(fileName, { schema: "main", name: tableName });
    return await run(connection, tableName);
  } finally {
    try { await connection.query(`DROP TABLE IF EXISTS ${quoteIdentifier(tableName)}`); } catch { /* best-effort cleanup */ }
    await connection.close();
    try { await db.dropFile(fileName); } catch { /* best-effort cleanup */ }
  }
}

type SqlCondition = { sql: string; parameters: Array<string | number> };

function comparisonOperator(operator: FilterRule["operator"]) {
  return ({ equals: "=", not_equals: "<>", greater: ">", greater_equal: ">=", less: "<", less_equal: "<=" } as const)[operator as Exclude<FilterRule["operator"], "contains" | "not_empty">];
}

function filterCondition(rule: FilterRule): SqlCondition {
  if (!rule.enabled) return { sql: "TRUE", parameters: [] };
  const raw = `TRIM(CAST(${quoteIdentifier(rule.field)} AS VARCHAR))`;
  if (rule.operator === "not_empty") return { sql: `${quoteIdentifier(rule.field)} IS NOT NULL AND ${raw} <> ''`, parameters: [] };
  if (rule.operator === "contains") return { sql: `CONTAINS(LOWER(${raw}), LOWER(?))`, parameters: [rule.value] };
  const operator = comparisonOperator(rule.operator);
  const numericTarget = rule.value.trim() !== "" ? Number(rule.value.trim()) : Number.NaN;
  if (Number.isFinite(numericTarget)) {
    return {
      sql: `(CASE WHEN TRY_CAST(${raw} AS DOUBLE) IS NOT NULL THEN TRY_CAST(${raw} AS DOUBLE) ${operator} ? ELSE LOWER(${raw}) ${operator} LOWER(?) END)`,
      parameters: [numericTarget, rule.value.trim()],
    };
  }
  const timestamp = /[-/]/.test(rule.value) && Number.isFinite(Date.parse(rule.value)) ? new Date(rule.value).toISOString() : null;
  if (timestamp) {
    return {
      sql: `(CASE WHEN TRY_CAST(REPLACE(${raw}, '/', '-') AS TIMESTAMP) IS NOT NULL THEN TRY_CAST(REPLACE(${raw}, '/', '-') AS TIMESTAMP) ${operator} CAST(? AS TIMESTAMP) ELSE LOWER(${raw}) ${operator} LOWER(?) END)`,
      parameters: [timestamp, rule.value.trim()],
    };
  }
  return { sql: `LOWER(${raw}) ${operator} LOWER(?)`, parameters: [rule.value.trim()] };
}

function numberValue(value: unknown) {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function metricChecks(primary: ExecutionResult, reference: MetricReference): IndependentVerificationCheck[] {
  return [
    {
      label: "DuckDB 指标值一致",
      passed: approximatelyEqual(primary.value, reference.metric_value),
      detail: `主引擎 ${primary.value}；DuckDB ${reference.metric_value ?? "NULL"}。`,
    },
    {
      label: "DuckDB 参与行数一致",
      passed: primary.sourceRows === reference.source_rows && primary.eligibleRows === reference.eligible_rows,
      detail: `源数据 ${primary.sourceRows}/${reference.source_rows}，参与计算 ${primary.eligibleRows}/${reference.eligible_rows}。`,
    },
    {
      label: "DuckDB 去重对象一致",
      passed: primary.distinctEntities === reference.distinct_entities,
      detail: `主引擎 ${primary.distinctEntities}；DuckDB ${reference.distinct_entities}。`,
    },
    {
      label: "DuckDB 排除与比例边界一致",
      passed: primary.excludedMissingEntities === reference.excluded_missing_entities
        && primary.excludedInvalidValues === reference.excluded_invalid_values
        && approximatelyEqual(primary.numerator, reference.numerator)
        && approximatelyEqual(primary.denominator, reference.denominator),
      detail: `缺失对象 ${primary.excludedMissingEntities}/${reference.excluded_missing_entities}，无效数值 ${primary.excludedInvalidValues}/${reference.excluded_invalid_values}。`,
    },
  ];
}

type MetricReference = {
  source_rows: number;
  eligible_rows: number;
  distinct_entities: number;
  excluded_missing_entities: number;
  excluded_invalid_values: number;
  metric_value: number | null;
  numerator: number | null;
  denominator: number | null;
};

export async function verifyMetricWithDuckDB(
  contract: MetricContract,
  profile: DatasetProfile,
  config: ExecutionConfig,
  primary: ExecutionResult,
): Promise<IndependentVerification> {
  const startedAt = performance.now();
  const version = createDatasetVersion(profile);
  let query = "";
  try {
    const base = filterCondition(config.baseFilter);
    const numeratorCondition = filterCondition(config.ratioNumerator);
    const entity = `NULLIF(TRIM(CAST(${quoteIdentifier(contract.statisticalUnit)} AS VARCHAR)), '')`;
    const numeric = contract.valueField
      ? `CASE WHEN REGEXP_FULL_MATCH(TRIM(CAST(${quoteIdentifier(contract.valueField)} AS VARCHAR)), '${NUMERIC_PATTERN}') THEN TRY_CAST(TRIM(CAST(${quoteIdentifier(contract.valueField)} AS VARCHAR)) AS DOUBLE) END`
      : "NULL::DOUBLE";
    const metricExpression = contract.metricType === "count" ? "CAST(COUNT(DISTINCT __entity) AS DOUBLE)"
      : contract.metricType === "amount" ? "SUM(__numeric_value)"
        : contract.metricType === "average" ? "SUM(__numeric_value) / NULLIF(COUNT(DISTINCT CASE WHEN __numeric_value IS NOT NULL THEN __entity END), 0)"
          : "CAST(COUNT(DISTINCT CASE WHEN __numerator_match THEN __entity END) AS DOUBLE) / NULLIF(COUNT(DISTINCT __entity), 0)";
    const invalidExpression = contract.metricType === "amount" || contract.metricType === "average"
      ? "CAST(COUNT(*) FILTER (WHERE __numeric_value IS NULL) AS DOUBLE)"
      : "0::DOUBLE";
    query = [
      "WITH base AS (",
      `  SELECT * FROM ${quoteIdentifier("__TABLE__")} WHERE ${base.sql}`,
      "), normalized AS (",
      `  SELECT ${entity} AS __entity, ${numeric} AS __numeric_value, ${contract.metricType === "ratio" ? numeratorCondition.sql : "FALSE"} AS __numerator_match FROM base`,
      ")",
      "SELECT",
      `  CAST((SELECT COUNT(*) FROM ${quoteIdentifier("__TABLE__")}) AS DOUBLE) AS source_rows,`,
      "  CAST(COUNT(*) AS DOUBLE) AS eligible_rows,",
      "  CAST(COUNT(DISTINCT __entity) AS DOUBLE) AS distinct_entities,",
      "  CAST(COUNT(*) FILTER (WHERE __entity IS NULL) AS DOUBLE) AS excluded_missing_entities,",
      `  ${invalidExpression} AS excluded_invalid_values,`,
      `  CAST(${metricExpression} AS DOUBLE) AS metric_value,`,
      `  ${contract.metricType === "ratio" ? "CAST(COUNT(DISTINCT CASE WHEN __numerator_match THEN __entity END) AS DOUBLE)" : "NULL::DOUBLE"} AS numerator,`,
      `  ${contract.metricType === "ratio" ? "CAST(COUNT(DISTINCT __entity) AS DOUBLE)" : "NULL::DOUBLE"} AS denominator`,
      "FROM normalized;",
    ].join("\n");
    const reference = await withVerificationTable(profile, async (connection, tableName) => {
      const executable = query.replaceAll('"__TABLE__"', quoteIdentifier(tableName));
      const statement = await connection.prepare(executable);
      try {
        const result = await statement.query(...base.parameters, ...(contract.metricType === "ratio" ? numeratorCondition.parameters : []));
        const row = rowsFromArrow<Record<string, unknown>>(result)[0];
        return {
          source_rows: numberValue(row.source_rows) ?? 0,
          eligible_rows: numberValue(row.eligible_rows) ?? 0,
          distinct_entities: numberValue(row.distinct_entities) ?? 0,
          excluded_missing_entities: numberValue(row.excluded_missing_entities) ?? 0,
          excluded_invalid_values: numberValue(row.excluded_invalid_values) ?? 0,
          metric_value: numberValue(row.metric_value),
          numerator: numberValue(row.numerator),
          denominator: numberValue(row.denominator),
        } satisfies MetricReference;
      } finally {
        await statement.close();
      }
    });
    const checks = metricChecks(primary, reference);
    return {
      engine: "duckdb-wasm",
      engineVersion: DUCKDB_WASM_VERSION,
      status: verificationPassed(checks) ? "passed" : "failed",
      datasetVersionId: version.versionId,
      durationMs: Math.round(performance.now() - startedAt),
      query,
      checks,
      referenceValue: reference.metric_value,
      referenceRows: [],
      error: null,
    };
  } catch (error) {
    return {
      engine: "duckdb-wasm",
      engineVersion: DUCKDB_WASM_VERSION,
      status: "error",
      datasetVersionId: version.versionId,
      durationMs: Math.round(performance.now() - startedAt),
      query,
      checks: [],
      referenceValue: null,
      referenceRows: [],
      error: error instanceof Error ? error.message : "DuckDB 独立复核失败。",
    };
  }
}

function timeKeyExpression(field: string, grain: BusinessAnalysisConfig["timeGrain"]) {
  const raw = `TRIM(CAST(${quoteIdentifier(field)} AS VARCHAR))`;
  const parsed = `CASE WHEN REGEXP_FULL_MATCH(${raw}, '^[0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2}([ T].*)?$') THEN TRY_CAST(REPLACE(${raw}, '/', '-') AS TIMESTAMP) END`;
  if (grain === "day") return `STRFTIME(${parsed}, '%Y-%m-%d')`;
  if (grain === "week") return `STRFTIME(${parsed}, '%G-W%V')`;
  if (grain === "quarter") return `CONCAT(YEAR(${parsed}), '-Q', QUARTER(${parsed}))`;
  return `STRFTIME(${parsed}, '%Y-%m')`;
}

type BusinessReference = {
  rows: Array<{ key: string; value: number; sourceRows: number; distinctEntities: number; excludedInvalidValues: number }>;
  sourceRows: number;
  eligibleRows: number;
  excludedGroupingRows: number;
  excludedMissingEntities: number;
  excludedInvalidValues: number;
  fullGroupCount: number;
};

function businessChecks(primary: BusinessAnalysisResult, reference: BusinessReference): IndependentVerificationCheck[] {
  const sameRows = primary.rows.length === reference.rows.length && primary.rows.every((row, index) => {
    const other = reference.rows[index];
    return other && row.key === other.key && approximatelyEqual(row.value, other.value)
      && row.sourceRows === other.sourceRows && row.distinctEntities === other.distinctEntities
      && row.excludedInvalidValues === other.excludedInvalidValues;
  });
  return [
    { label: "DuckDB 分组结果一致", passed: sameRows, detail: `主引擎 ${primary.rows.length} 行；DuckDB ${reference.rows.length} 行。` },
    {
      label: "DuckDB 行数勾稽一致",
      passed: primary.sourceRows === reference.sourceRows && primary.eligibleRows === reference.eligibleRows
        && primary.excludedGroupingRows === reference.excludedGroupingRows,
      detail: `源行 ${primary.sourceRows}/${reference.sourceRows}，进入分组 ${primary.eligibleRows}/${reference.eligibleRows}，排除 ${primary.excludedGroupingRows}/${reference.excludedGroupingRows}。`,
    },
    {
      label: "DuckDB 排除记录一致",
      passed: primary.excludedMissingEntities === reference.excludedMissingEntities
        && primary.excludedInvalidValues === reference.excludedInvalidValues,
      detail: `缺失对象 ${primary.excludedMissingEntities}/${reference.excludedMissingEntities}，无效数值 ${primary.excludedInvalidValues}/${reference.excludedInvalidValues}。`,
    },
    { label: "DuckDB 结果边界一致", passed: primary.fullGroupCount === reference.fullGroupCount, detail: `完整分组 ${primary.fullGroupCount}/${reference.fullGroupCount}。` },
  ];
}

export async function verifyBusinessAnalysisWithDuckDB(
  profile: DatasetProfile,
  config: BusinessAnalysisConfig,
  primary: BusinessAnalysisResult,
): Promise<IndependentVerification> {
  const startedAt = performance.now();
  const version = createDatasetVersion(profile);
  let query = "";
  try {
    const key = config.analysisType === "trend"
      ? timeKeyExpression(config.timeField, config.timeGrain)
      : `NULLIF(TRIM(CAST(${quoteIdentifier(config.groupField)} AS VARCHAR)), '')`;
    const entity = `NULLIF(TRIM(CAST(${quoteIdentifier(config.entityField)} AS VARCHAR)), '')`;
    const numeric = config.aggregation === "count_distinct" ? "NULL::DOUBLE"
      : `CASE WHEN REGEXP_FULL_MATCH(TRIM(CAST(${quoteIdentifier(config.valueField)} AS VARCHAR)), '${NUMERIC_PATTERN}') THEN TRY_CAST(TRIM(CAST(${quoteIdentifier(config.valueField)} AS VARCHAR)) AS DOUBLE) END`;
    const validNumeric = config.aggregation === "average" ? "__numeric_value IS NOT NULL AND __entity IS NOT NULL" : "__numeric_value IS NOT NULL";
    const aggregate = config.aggregation === "count_distinct" ? "CAST(COUNT(DISTINCT __entity) AS DOUBLE)"
      : config.aggregation === "sum" ? "SUM(__numeric_value)"
        : "SUM(CASE WHEN __entity IS NOT NULL THEN __numeric_value END) / NULLIF(COUNT(DISTINCT CASE WHEN __numeric_value IS NOT NULL THEN __entity END), 0)";
    const invalid = config.aggregation === "count_distinct" ? "0::DOUBLE"
      : `CAST(COUNT(*) FILTER (WHERE NOT (${validNumeric})) AS DOUBLE)`;
    const order = config.analysisType === "trend" ? "analysis_key ASC"
      : `metric_value ${config.sortDirection.toUpperCase()}, analysis_key ASC`;
    const limit = config.analysisType === "top_n" ? ` LIMIT ${Math.trunc(config.limit)}` : "";
    const prepared = [
      "WITH prepared AS (",
      `  SELECT ${key} AS analysis_key, ${entity} AS __entity, ${numeric} AS __numeric_value`,
      `  FROM ${quoteIdentifier("__TABLE__")}`,
      "), grouped AS (",
      "  SELECT analysis_key,",
      `    CAST(${aggregate} AS DOUBLE) AS metric_value,`,
      "    CAST(COUNT(*) AS DOUBLE) AS source_rows,",
      "    CAST(COUNT(DISTINCT __entity) AS DOUBLE) AS distinct_entities,",
      `    ${invalid} AS excluded_invalid_values`,
      "  FROM prepared WHERE analysis_key IS NOT NULL GROUP BY analysis_key",
      ")",
    ].join("\n");
    query = `${prepared}\nSELECT * FROM grouped WHERE ISFINITE(metric_value) ORDER BY ${order}${limit};`;
    const reference = await withVerificationTable(profile, async (connection, tableName) => {
      const executable = query.replaceAll('"__TABLE__"', quoteIdentifier(tableName));
      const rowsResult = await connection.query(executable);
      const rowData = rowsFromArrow<Record<string, unknown>>(rowsResult).map((row) => ({
        key: String(row.analysis_key),
        value: numberValue(row.metric_value) ?? Number.NaN,
        sourceRows: numberValue(row.source_rows) ?? 0,
        distinctEntities: numberValue(row.distinct_entities) ?? 0,
        excludedInvalidValues: numberValue(row.excluded_invalid_values) ?? 0,
      }));
      const table = quoteIdentifier(tableName);
      const summarySql = [
        prepared.replaceAll('"__TABLE__"', table),
        "SELECT",
        `  CAST((SELECT COUNT(*) FROM ${table}) AS DOUBLE) AS source_rows,`,
        "  CAST(COUNT(*) FILTER (WHERE analysis_key IS NOT NULL) AS DOUBLE) AS eligible_rows,",
        "  CAST(COUNT(*) FILTER (WHERE analysis_key IS NULL) AS DOUBLE) AS excluded_grouping_rows,",
        "  CAST(COUNT(*) FILTER (WHERE analysis_key IS NOT NULL AND __entity IS NULL) AS DOUBLE) AS excluded_missing_entities,",
        `  ${config.aggregation === "count_distinct" ? "0::DOUBLE" : `CAST(COUNT(*) FILTER (WHERE analysis_key IS NOT NULL AND NOT (${validNumeric})) AS DOUBLE)`} AS excluded_invalid_values,`,
        "  CAST((SELECT COUNT(*) FROM grouped WHERE ISFINITE(metric_value)) AS DOUBLE) AS full_group_count",
        "FROM prepared;",
      ].join("\n");
      const summaryResult = await connection.query(summarySql);
      const summary = rowsFromArrow<Record<string, unknown>>(summaryResult)[0];
      return {
        rows: rowData,
        sourceRows: numberValue(summary.source_rows) ?? 0,
        eligibleRows: numberValue(summary.eligible_rows) ?? 0,
        excludedGroupingRows: numberValue(summary.excluded_grouping_rows) ?? 0,
        excludedMissingEntities: numberValue(summary.excluded_missing_entities) ?? 0,
        excludedInvalidValues: numberValue(summary.excluded_invalid_values) ?? 0,
        fullGroupCount: numberValue(summary.full_group_count) ?? 0,
      } satisfies BusinessReference;
    });
    const checks = businessChecks(primary, reference);
    return {
      engine: "duckdb-wasm",
      engineVersion: DUCKDB_WASM_VERSION,
      status: verificationPassed(checks) ? "passed" : "failed",
      datasetVersionId: version.versionId,
      durationMs: Math.round(performance.now() - startedAt),
      query,
      checks,
      referenceValue: null,
      referenceRows: reference.rows.map((row) => ({ key: row.key, value: row.value })),
      error: null,
    };
  } catch (error) {
    return {
      engine: "duckdb-wasm",
      engineVersion: DUCKDB_WASM_VERSION,
      status: "error",
      datasetVersionId: version.versionId,
      durationMs: Math.round(performance.now() - startedAt),
      query,
      checks: [],
      referenceValue: null,
      referenceRows: [],
      error: error instanceof Error ? error.message : "DuckDB 独立复核失败。",
    };
  }
}
