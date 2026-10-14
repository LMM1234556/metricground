import type { BusinessAnalysisConfig } from "./business-analysis";
import type { FilterRule } from "./metric-execution";

function identifier(field: string) { return `"${field.replace(/"/g, '""')}"`; }

// The table is normalized using the same documented import used by verification.
function condition(rule: FilterRule | undefined) {
  if (!rule?.enabled) return { sql: "TRUE", parameters: [] as string[] };
  const value = `NULLIF(TRIM(CAST(${identifier(rule.field)} AS VARCHAR)), '')`;
  if (rule.operator === "not_empty") return { sql: `${value} IS NOT NULL`, parameters: [] as string[] };
  return { sql: `LOWER(${value}) ${rule.operator === "equals" ? "=" : "<>"} LOWER(?)`, parameters: [rule.value.trim()] };
}

export function buildBusinessRatioSql(config: BusinessAnalysisConfig) {
  const denominator = condition(config.ratioDenominator);
  const numerator = condition(config.ratioNumerator);
  const prepared = [
    "WITH base AS (",
    `  SELECT * FROM "__TABLE__" WHERE ${denominator.sql}`,
    "), prepared AS (",
    `  SELECT NULLIF(TRIM(CAST(${identifier(config.groupField)} AS VARCHAR)), '') AS analysis_key,`,
    `    NULLIF(TRIM(CAST(${identifier(config.entityField)} AS VARCHAR)), '') AS __entity,`,
    `    COALESCE(${numerator.sql}, FALSE) AS __success FROM base`,
    "), grouped AS (",
    "  SELECT analysis_key, CAST(COUNT(*) AS DOUBLE) AS source_rows,",
    "    CAST(COUNT(DISTINCT __entity) AS DOUBLE) AS distinct_entities,",
    "    CAST(COUNT(DISTINCT CASE WHEN __success THEN __entity END) AS DOUBLE) AS numerator,",
    "    CAST(COUNT(DISTINCT __entity) AS DOUBLE) AS denominator,",
    "    0::DOUBLE AS excluded_invalid_values",
    "  FROM prepared WHERE analysis_key IS NOT NULL GROUP BY analysis_key",
    "), calculated AS (",
    "  SELECT *, numerator / NULLIF(denominator, 0) AS metric_value FROM grouped",
    ")",
  ].join("\n");
  const rows = `${prepared}\nSELECT * FROM calculated WHERE denominator > 0 ORDER BY metric_value ${config.sortDirection.toUpperCase()}, analysis_key ASC;`;
  const summary = `${prepared}\nSELECT
    CAST((SELECT COUNT(*) FROM "__TABLE__") AS DOUBLE) AS source_rows,
    CAST(COUNT(*) FILTER (WHERE analysis_key IS NOT NULL) AS DOUBLE) AS eligible_rows,
    CAST(COUNT(*) FILTER (WHERE analysis_key IS NULL) AS DOUBLE) AS excluded_grouping_rows,
    CAST((SELECT COUNT(*) FROM "__TABLE__") - (SELECT COUNT(*) FROM base) AS DOUBLE) AS excluded_scope_rows,
    CAST(COUNT(*) FILTER (WHERE analysis_key IS NOT NULL AND __entity IS NULL) AS DOUBLE) AS excluded_missing_entities,
    0::DOUBLE AS excluded_invalid_values,
    CAST((SELECT COUNT(*) FROM calculated WHERE denominator > 0) AS DOUBLE) AS full_group_count
  FROM prepared;`;
  const zero = `${prepared}\nSELECT analysis_key FROM calculated WHERE denominator = 0 ORDER BY analysis_key;`;
  const conflicts = `${prepared}\nSELECT __entity FROM prepared WHERE analysis_key IS NOT NULL AND __entity IS NOT NULL
    GROUP BY __entity HAVING COUNT(DISTINCT analysis_key) > 1 OR COUNT(DISTINCT __success) > 1;`;
  return { rows, summary, zero, conflicts, parameters: [...denominator.parameters, ...numerator.parameters] };
}
