import type { CellValue, JoinAmountReconciliation } from "./tabular-profile";
import {
  profileRelationship,
  type CatalogTable,
  type DatasetCatalog,
  type RelationshipCardinality,
  type RelationshipProfile,
} from "./dataset-catalog.ts";

export type JoinType = "left" | "inner";

export type JoinSpec = {
  version: "1.0";
  id: string;
  relationshipId: string;
  leftTableId: string;
  rightTableId: string;
  leftVersionId: string;
  rightVersionId: string;
  leftFields: string[];
  rightFields: string[];
  joinType: JoinType;
  expectedCardinality: RelationshipCardinality;
  intendedGrainTableId: string;
  intendedGrainDescription: string;
  keyMeaningConfirmed: boolean;
  relationshipConfirmed: boolean;
  grainConfirmed: boolean;
  orphanRiskAcknowledged: boolean;
  expansionRiskAcknowledged: boolean;
  status: "draft" | "confirmed";
};

export type JoinSpecValidation = {
  valid: boolean;
  errors: string[];
  warnings: string[];
  relationship: RelationshipProfile;
  recommendedGrainTableId: string | null;
};

export type JoinPreview = {
  relationship: RelationshipProfile;
  joinType: JoinType;
  estimatedOutputRows: number;
  estimatedExpansion: number;
  matchedLeftRows: number;
  leftOrphanRows: number;
  rightOrphanRows: number;
  risks: string[];
  sampleMatchedKeys: string[];
  sampleLeftOrphanKeys: string[];
  sampleRightOrphanKeys: string[];
};

export type JoinedRecord = Record<string, CellValue>;

export type JoinExecutionCheck = {
  label: string;
  passed: boolean;
  detail: string;
};

export type JoinExecutionResult = {
  records: JoinedRecord[];
  tableIds: string[];
  sourceRows: { left: number; right: number };
  outputRows: number;
  matchedOutputRows: number;
  unmatchedLeftRows: number;
  expansion: number;
  cardinality: RelationshipCardinality;
  amountReconciliations: JoinAmountReconciliation[];
  checks: JoinExecutionCheck[];
  warnings: string[];
  preaggregation?: {
    side: "right";
    operation: "distinct-list-by-key";
    sourceRows: number;
    groupedKeys: number;
    matchedGroupedKeys: number;
    selectedFields: string[];
  };
  engine: "browser-deterministic-join" | "browser-deterministic-grain-preserving-enrichment";
};

export type GrainPreservingEnrichmentValidation = {
  valid: boolean;
  errors: string[];
  warnings: string[];
  relationship: RelationshipProfile;
};

export type JoinPipelineResult = {
  records: JoinedRecord[];
  tableIds: string[];
  steps: Array<{
    joinSpecId: string;
    beforeRows: number;
    afterRows: number;
    matchedOutputRows: number;
    unmatchedLeftRows: number;
  }>;
  amountReconciliations: JoinAmountReconciliation[];
  checks: JoinExecutionCheck[];
  warnings: string[];
  engine: "browser-deterministic-join-pipeline";
};

const JOIN_LINEAGE = Symbol("metricgroundJoinLineage");
type Lineage = Record<string, number[]>;
type LineagedRecord = JoinedRecord & { [JOIN_LINEAGE]?: Lineage };

function table(catalog: DatasetCatalog, tableId: string) {
  const found = catalog.tables.find((item) => item.tableId === tableId);
  if (!found) throw new Error(`找不到数据表：${tableId}`);
  return found;
}

function missing(value: CellValue | undefined) {
  return value === null || value === undefined || (typeof value === "string" && ["", "null", "undefined", "__null__"].includes(value.trim().toLowerCase()));
}

function keyPart(value: CellValue) {
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (typeof value === "string") return `string:${value.trim().toLowerCase()}`;
  return `${typeof value}:${String(value)}`;
}

function rawKey(record: Record<string, CellValue>, fields: string[]) {
  const values = fields.map((field) => record[field]);
  if (values.some(missing)) return null;
  return values.map((value) => keyPart(value as CellValue)).join("\u001f");
}

function qualifiedKey(record: JoinedRecord, source: CatalogTable, fields: string[]) {
  const values = fields.map((field) => record[`${source.alias}.${field}`]);
  if (values.some(missing)) return null;
  return values.map((value) => keyPart(value as CellValue)).join("\u001f");
}

function displayKey(key: string) {
  return key.split("\u001f").map((part) => part.replace(/^[^:]+:/, "")).join(" + ");
}

function displayValue(value: CellValue) {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value.trim() : String(value);
}

function qualifiedRecord(source: CatalogTable, record: Record<string, CellValue> | null): JoinedRecord {
  return Object.fromEntries(source.profile.columns.map((column) => [`${source.alias}.${column.name}`, record?.[column.name] ?? null]));
}

function withLineage(record: JoinedRecord, lineage: Lineage): LineagedRecord {
  Object.defineProperty(record, JOIN_LINEAGE, { value: lineage, enumerable: false });
  return record;
}

function lineageOf(record: LineagedRecord): Lineage {
  return record[JOIN_LINEAGE] ?? {};
}

function numberValue(value: CellValue | undefined) {
  if (value === null || value === undefined || value instanceof Date || typeof value === "boolean") return null;
  const parsed = typeof value === "number" ? value : Number(value.trim().replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function isAmountField(name: string) {
  return /(?:^|[_\s.-])(?:amount|price|gmv|revenue|sales|income|cost|fee|freight|tax|refund|payment(?:[_\s.-]?value)?|金额|价格|销售额|收入|营收|成本|运费|税费|退款)(?:$|[_\s.-])/i.test(name);
}

function amountReconciliations(
  catalog: DatasetCatalog,
  records: LineagedRecord[],
  tableIds: string[],
): JoinAmountReconciliation[] {
  return tableIds.flatMap((tableId) => {
    const source = table(catalog, tableId);
    const occurrences = Array.from({ length: source.profile.records.length }, () => 0);
    records.forEach((record) => {
      (lineageOf(record)[tableId] ?? []).forEach((index) => { occurrences[index] += 1; });
    });
    return source.profile.columns
      .filter((column) => column.inferredType === "数值" && isAmountField(column.name))
      .map((column) => {
        let sourceTotal = 0;
        let outputTotal = 0;
        let validSourceRows = 0;
        let outputValueRows = 0;
        let duplicatedSourceRows = 0;
        let excludedSourceRows = 0;
        let duplicationImpact = 0;
        let exclusionImpact = 0;
        source.profile.records.forEach((record, index) => {
          const value = numberValue(record[column.name]);
          if (value === null) return;
          const count = occurrences[index];
          sourceTotal += value;
          validSourceRows += 1;
          outputTotal += value * count;
          outputValueRows += count;
          if (count === 0) {
            excludedSourceRows += 1;
            exclusionImpact += value;
          } else if (count > 1) {
            duplicatedSourceRows += 1;
            duplicationImpact += value * (count - 1);
          }
        });
        const netDelta = outputTotal - sourceTotal;
        const status = duplicatedSourceRows > 0 && excludedSourceRows > 0 ? "mixed"
          : duplicatedSourceRows > 0 ? "duplicated"
            : excludedSourceRows > 0 ? "excluded"
              : "balanced";
        return {
          tableId,
          tableAlias: source.alias,
          field: column.name,
          qualifiedField: `${source.alias}.${column.name}`,
          sourceTotal,
          outputTotal,
          netDelta,
          netDeltaRate: sourceTotal === 0 ? null : netDelta / Math.abs(sourceTotal),
          validSourceRows,
          outputValueRows,
          duplicatedSourceRows,
          excludedSourceRows,
          duplicationImpact,
          exclusionImpact,
          status,
        } satisfies JoinAmountReconciliation;
      });
  });
}

function reconciliationCheck(item: JoinAmountReconciliation): JoinExecutionCheck {
  const balanced = item.status === "balanced";
  return {
    label: `金额对账：${item.qualifiedField}`,
    passed: balanced,
    detail: balanced
      ? `源表与关联结果均为 ${item.sourceTotal.toLocaleString("zh-CN", { maximumFractionDigits: 4 })}`
      : `源表 ${item.sourceTotal.toLocaleString("zh-CN", { maximumFractionDigits: 4 })}，关联后 ${item.outputTotal.toLocaleString("zh-CN", { maximumFractionDigits: 4 })}；重复 ${item.duplicatedSourceRows} 行，排除 ${item.excludedSourceRows} 行`,
  };
}

function recommendedGrain(relationship: RelationshipProfile) {
  if (relationship.cardinality === "1:1" || relationship.cardinality === "N:1") return relationship.leftTableId;
  if (relationship.cardinality === "1:N") return relationship.rightTableId;
  return null;
}

export function createJoinSpec(
  catalog: DatasetCatalog,
  relationship: RelationshipProfile,
  options: { joinType?: JoinType; intendedGrainTableId?: string; intendedGrainDescription?: string } = {},
): JoinSpec {
  const left = table(catalog, relationship.leftTableId);
  const right = table(catalog, relationship.rightTableId);
  const recommended = recommendedGrain(relationship) ?? left.tableId;
  return {
    version: "1.0",
    id: `join_${relationship.id}`,
    relationshipId: relationship.id,
    leftTableId: left.tableId,
    rightTableId: right.tableId,
    leftVersionId: left.version.versionId,
    rightVersionId: right.version.versionId,
    leftFields: [...relationship.leftFields],
    rightFields: [...relationship.rightFields],
    joinType: options.joinType ?? (relationship.cardinality === "1:N" ? "inner" : "left"),
    expectedCardinality: relationship.cardinality,
    intendedGrainTableId: options.intendedGrainTableId ?? recommended,
    intendedGrainDescription: options.intendedGrainDescription ?? "",
    keyMeaningConfirmed: false,
    relationshipConfirmed: false,
    grainConfirmed: false,
    orphanRiskAcknowledged: false,
    expansionRiskAcknowledged: false,
    status: "draft",
  };
}

export function validateJoinSpec(catalog: DatasetCatalog, spec: JoinSpec): JoinSpecValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const left = table(catalog, spec.leftTableId);
  const right = table(catalog, spec.rightTableId);
  const relationship = profileRelationship(catalog, {
    leftTableId: spec.leftTableId,
    rightTableId: spec.rightTableId,
    leftFields: spec.leftFields,
    rightFields: spec.rightFields,
  });
  const recommended = recommendedGrain(relationship);
  if (spec.version !== "1.0") errors.push("不支持的 JoinSpec 版本");
  if (spec.leftVersionId !== left.version.versionId || spec.rightVersionId !== right.version.versionId) {
    errors.push("数据版本已变化，必须重新生成关联画像");
  }
  if (spec.expectedCardinality !== relationship.cardinality) errors.push("实际关联基数与确认时不一致");
  if (relationship.cardinality === "N:N") errors.push("多对多关联已被默认禁止，请先聚合或修正关联键");
  if (!spec.keyMeaningConfirmed) errors.push("尚未确认左右关联键的业务含义一致");
  if (!spec.relationshipConfirmed) errors.push("尚未确认关联基数与业务预期一致");
  if (!spec.grainConfirmed || !spec.intendedGrainDescription.trim()) errors.push("尚未确认关联后的输出粒度");
  if ((relationship.leftOrphanRows > 0 || relationship.rightOrphanRows > 0) && !spec.orphanRiskAcknowledged) {
    errors.push("存在未匹配记录，必须确认孤儿键处置方式");
  }
  if (relationship.estimatedLeftJoinExpansion > 1 && !spec.expansionRiskAcknowledged) {
    errors.push("关联会造成行数膨胀，必须确认重复累计风险");
  }
  if (recommended && spec.intendedGrainTableId !== recommended) {
    errors.push("当前关联方向不能保持所选输出粒度；请调整主表、关联类型或先聚合明细表");
  }
  if (relationship.cardinality === "1:N" && spec.joinType === "left" && relationship.leftOrphanRows > 0) {
    errors.push("1:N 左连接且存在左表孤儿记录时，输出不再是纯右表粒度；请改用内连接或先处理孤儿记录");
  }
  if (spec.joinType === "inner" && (relationship.leftOrphanRows > 0 || relationship.rightOrphanRows > 0)) {
    warnings.push("内连接会排除未匹配记录，分析样本范围将缩小");
  }
  warnings.push(...relationship.warnings);
  if (spec.status !== "confirmed") errors.push("JoinSpec 尚未完成人工确认");
  return { valid: errors.length === 0, errors, warnings: [...new Set(warnings)], relationship, recommendedGrainTableId: recommended };
}

export function validateGrainPreservingEnrichment(
  catalog: DatasetCatalog,
  spec: JoinSpec,
  selectedFields: string[],
): GrainPreservingEnrichmentValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const left = table(catalog, spec.leftTableId);
  const right = table(catalog, spec.rightTableId);
  const relationship = profileRelationship(catalog, {
    leftTableId: spec.leftTableId,
    rightTableId: spec.rightTableId,
    leftFields: spec.leftFields,
    rightFields: spec.rightFields,
  });
  const allowedFields = new Map(right.profile.columns
    .filter((column) => !spec.rightFields.includes(column.name))
    .map((column) => [column.name, column.inferredType]));
  const uniqueFields = [...new Set(selectedFields)];

  if (spec.version !== "1.0") errors.push("不支持的 JoinSpec 版本");
  if (spec.leftVersionId !== left.version.versionId || spec.rightVersionId !== right.version.versionId) {
    errors.push("数据版本已变化，必须重新生成关联画像");
  }
  if (relationship.cardinality !== "1:N") errors.push("粒度保持方案仅适用于左表唯一、右表多行的一对多关系");
  if (spec.joinType !== "left") errors.push("保留全部左表业务对象时必须使用 Left join");
  if (spec.intendedGrainTableId !== left.tableId) errors.push("粒度保持方案的输出粒度必须属于左表");
  if (!spec.keyMeaningConfirmed) errors.push("尚未确认左右关联键的业务含义一致");
  if (!spec.relationshipConfirmed) errors.push("尚未确认一对多关系符合业务预期");
  if (!spec.grainConfirmed || !spec.intendedGrainDescription.trim()) errors.push("尚未确认关联后的输出粒度");
  if ((relationship.leftOrphanRows > 0 || relationship.rightOrphanRows > 0) && !spec.orphanRiskAcknowledged) {
    errors.push("存在未匹配记录，必须确认孤儿键处置方式");
  }
  if (!spec.expansionRiskAcknowledged) errors.push("尚未确认直接关联的重复累计风险和预聚合处置");
  if (uniqueFields.length < 1) errors.push("请至少选择一个需要补充到左表的描述字段");
  uniqueFields.forEach((field) => {
    const inferredType = allowedFields.get(field);
    if (!inferredType) errors.push(`右表字段“${field}”不存在、属于关联键或不可用于补充`);
    else if (!['文本', '混合', '布尔'].includes(inferredType)) {
      errors.push(`字段“${field}”是${inferredType}字段；本方案只生成描述值去重列表，不自动汇总数值或日期`);
    }
  });
  if (spec.status !== "confirmed") errors.push("关联方案尚未完成人工确认");
  if (relationship.leftOrphanRows > 0) warnings.push(`左表有 ${relationship.leftOrphanRows} 行没有明细，将保留并把补充字段设为空`);
  if (relationship.rightOrphanRows > 0) warnings.push(`右表有 ${relationship.rightOrphanRows} 行无法匹配左表，不会附加到任何左表记录`);
  warnings.push("右表描述字段按关联键生成去重列表；列表只能用于查找或展示，不能按列表成员分摊左表金额");
  return { valid: errors.length === 0, errors, warnings, relationship };
}

function keySamples(
  left: CatalogTable,
  right: CatalogTable,
  leftFields: string[],
  rightFields: string[],
) {
  const leftKeys = new Set(left.profile.records.map((record) => rawKey(record, leftFields)).filter((key): key is string => key !== null));
  const rightKeys = new Set(right.profile.records.map((record) => rawKey(record, rightFields)).filter((key): key is string => key !== null));
  return {
    matched: [...leftKeys].filter((key) => rightKeys.has(key)).slice(0, 3).map(displayKey),
    leftOrphans: [...leftKeys].filter((key) => !rightKeys.has(key)).slice(0, 3).map(displayKey),
    rightOrphans: [...rightKeys].filter((key) => !leftKeys.has(key)).slice(0, 3).map(displayKey),
  };
}

export function previewJoin(catalog: DatasetCatalog, spec: JoinSpec): JoinPreview {
  const validation = validateJoinSpec(catalog, { ...spec, status: "confirmed", keyMeaningConfirmed: true, relationshipConfirmed: true, grainConfirmed: true, orphanRiskAcknowledged: true, expansionRiskAcknowledged: true, intendedGrainDescription: spec.intendedGrainDescription || "预览粒度" });
  const left = table(catalog, spec.leftTableId);
  const right = table(catalog, spec.rightTableId);
  const samples = keySamples(left, right, spec.leftFields, spec.rightFields);
  const innerRows = left.profile.records.reduce((sum, record) => {
    const key = rawKey(record, spec.leftFields);
    if (key === null) return sum;
    return sum + right.profile.records.filter((rightRecord) => rawKey(rightRecord, spec.rightFields) === key).length;
  }, 0);
  const estimatedOutputRows = spec.joinType === "left" ? validation.relationship.estimatedLeftJoinRows : innerRows;
  return {
    relationship: validation.relationship,
    joinType: spec.joinType,
    estimatedOutputRows,
    estimatedExpansion: left.profile.rowCount === 0 ? 0 : estimatedOutputRows / left.profile.rowCount,
    matchedLeftRows: validation.relationship.matchedLeftRows,
    leftOrphanRows: validation.relationship.leftOrphanRows,
    rightOrphanRows: validation.relationship.rightOrphanRows,
    risks: [...new Set([...validation.errors, ...validation.warnings])],
    sampleMatchedKeys: samples.matched,
    sampleLeftOrphanKeys: samples.leftOrphans,
    sampleRightOrphanKeys: samples.rightOrphans,
  };
}

function joinQualifiedRecords(
  current: LineagedRecord[],
  left: CatalogTable,
  right: CatalogTable,
  spec: JoinSpec,
) {
  const rightIndex = new Map<string, Array<{ record: Record<string, CellValue>; index: number }>>();
  right.profile.records.forEach((record, index) => {
    const key = rawKey(record, spec.rightFields);
    if (key === null) return;
    const bucket = rightIndex.get(key) ?? [];
    bucket.push({ record, index });
    rightIndex.set(key, bucket);
  });
  const records: LineagedRecord[] = [];
  let matchedOutputRows = 0;
  let unmatchedLeftRows = 0;
  current.forEach((record) => {
    const key = qualifiedKey(record, left, spec.leftFields);
    const matches = key === null ? [] : rightIndex.get(key) ?? [];
    if (matches.length === 0) {
      unmatchedLeftRows += 1;
      if (spec.joinType === "left") records.push(withLineage({ ...record, ...qualifiedRecord(right, null) }, lineageOf(record)));
      return;
    }
    matches.forEach((match) => {
      records.push(withLineage(
        { ...record, ...qualifiedRecord(right, match.record) },
        { ...lineageOf(record), [right.tableId]: [match.index] },
      ));
      matchedOutputRows += 1;
    });
  });
  return { records, matchedOutputRows, unmatchedLeftRows };
}

export function executeControlledJoin(catalog: DatasetCatalog, spec: JoinSpec): JoinExecutionResult {
  const validation = validateJoinSpec(catalog, spec);
  if (!validation.valid) throw new Error(`关联未获准执行：${validation.errors.join("；")}`);
  const left = table(catalog, spec.leftTableId);
  const right = table(catalog, spec.rightTableId);
  const initial = left.profile.records.map((record, index) => withLineage(qualifiedRecord(left, record), { [left.tableId]: [index] }));
  const executed = joinQualifiedRecords(initial, left, right, spec);
  const preview = previewJoin(catalog, spec);
  const expansion = left.profile.rowCount === 0 ? 0 : executed.records.length / left.profile.rowCount;
  const structuralChecks: JoinExecutionCheck[] = [
    { label: "关联基数未漂移", passed: validation.relationship.cardinality === spec.expectedCardinality, detail: `预期与实际均为 ${validation.relationship.cardinality}` },
    { label: "输出行数符合预览", passed: executed.records.length === preview.estimatedOutputRows, detail: `预览 ${preview.estimatedOutputRows} 行，实际 ${executed.records.length} 行` },
    { label: "未发生多对多关联", passed: validation.relationship.cardinality !== "N:N", detail: `当前关系 ${validation.relationship.cardinality}` },
    { label: "数据版本一致", passed: spec.leftVersionId === left.version.versionId && spec.rightVersionId === right.version.versionId, detail: "执行使用确认时绑定的数据版本" },
  ];
  if (structuralChecks.some((check) => !check.passed)) throw new Error(`关联执行后的确定性校验失败：${structuralChecks.filter((check) => !check.passed).map((check) => check.label).join("、")}`);
  const reconciliations = amountReconciliations(catalog, executed.records, [left.tableId, right.tableId]);
  const checks = [...structuralChecks, ...reconciliations.map(reconciliationCheck)];
  const reconciliationWarnings = reconciliations.filter((item) => item.status !== "balanced").map((item) =>
    `${item.qualifiedField} 未通过关联金额对账；后续对该字段求和或求平均将被阻止，请先按正确业务粒度聚合。`
  );
  return {
    records: executed.records,
    tableIds: [left.tableId, right.tableId],
    sourceRows: { left: left.profile.rowCount, right: right.profile.rowCount },
    outputRows: executed.records.length,
    matchedOutputRows: executed.matchedOutputRows,
    unmatchedLeftRows: executed.unmatchedLeftRows,
    expansion,
    cardinality: validation.relationship.cardinality,
    amountReconciliations: reconciliations,
    checks,
    warnings: [...new Set([...validation.warnings, ...reconciliationWarnings])],
    engine: "browser-deterministic-join",
  };
}

export function executeGrainPreservingEnrichment(
  catalog: DatasetCatalog,
  spec: JoinSpec,
  selectedFields: string[],
): JoinExecutionResult {
  const validation = validateGrainPreservingEnrichment(catalog, spec, selectedFields);
  if (!validation.valid) throw new Error(`粒度保持关联未获准执行：${validation.errors.join("；")}`);
  const left = table(catalog, spec.leftTableId);
  const right = table(catalog, spec.rightTableId);
  const fields = [...new Set(selectedFields)];
  const rightGroups = new Map<string, Array<{ record: Record<string, CellValue>; index: number }>>();
  right.profile.records.forEach((record, index) => {
    const key = rawKey(record, spec.rightFields);
    if (key === null) return;
    const group = rightGroups.get(key) ?? [];
    group.push({ record, index });
    rightGroups.set(key, group);
  });

  let matchedOutputRows = 0;
  let unmatchedLeftRows = 0;
  const matchedRightKeys = new Set<string>();
  const records = left.profile.records.map((leftRecord, leftIndex) => {
    const key = rawKey(leftRecord, spec.leftFields);
    const matches = key === null ? [] : rightGroups.get(key) ?? [];
    if (matches.length > 0 && key !== null) {
      matchedOutputRows += 1;
      matchedRightKeys.add(key);
    } else unmatchedLeftRows += 1;
    const aggregated = Object.fromEntries(fields.map((field) => {
      const distinct = new Map<string, string>();
      matches.forEach(({ record }) => {
        const value = record[field];
        if (missing(value)) return;
        distinct.set(keyPart(value as CellValue), displayValue(value as CellValue));
      });
      return [`${right.alias}.${field}_distinct_list`, distinct.size ? [...distinct.values()].join("、") : null];
    }));
    return withLineage(
      { ...qualifiedRecord(left, leftRecord), ...aggregated },
      { [left.tableId]: [leftIndex], [right.tableId]: matches.map((match) => match.index) },
    );
  });

  const reconciliations = amountReconciliations(catalog, records, [left.tableId]);
  const checks: JoinExecutionCheck[] = [
    { label: "右表明细已按关联键预聚合", passed: true, detail: `${right.profile.rowCount} 行明细归并为 ${rightGroups.size} 个非空键` },
    { label: "输出保持左表粒度", passed: records.length === left.profile.rowCount, detail: `${left.profile.rowCount} 行进入，${records.length} 行输出` },
    { label: "未匹配左表记录已保留", passed: records.length - matchedOutputRows === unmatchedLeftRows, detail: `保留 ${unmatchedLeftRows} 行未匹配记录，补充字段为空` },
    { label: "原始一对多关系未漂移", passed: validation.relationship.cardinality === "1:N", detail: `确认前后均为 ${validation.relationship.cardinality}` },
    { label: "数据版本一致", passed: spec.leftVersionId === left.version.versionId && spec.rightVersionId === right.version.versionId, detail: "执行使用人工确认时绑定的数据版本" },
    ...reconciliations.map(reconciliationCheck),
  ];
  const failedChecks = checks.filter((check) => !check.passed);
  if (failedChecks.length > 0) {
    throw new Error(`粒度保持关联后的确定性校验失败：${failedChecks.map((check) => check.label).join("、")}`);
  }
  return {
    records,
    tableIds: [left.tableId, right.tableId],
    sourceRows: { left: left.profile.rowCount, right: right.profile.rowCount },
    outputRows: records.length,
    matchedOutputRows,
    unmatchedLeftRows,
    expansion: left.profile.rowCount === 0 ? 0 : records.length / left.profile.rowCount,
    cardinality: validation.relationship.cardinality,
    amountReconciliations: reconciliations,
    checks,
    warnings: validation.warnings,
    preaggregation: {
      side: "right",
      operation: "distinct-list-by-key",
      sourceRows: right.profile.rowCount,
      groupedKeys: rightGroups.size,
      matchedGroupedKeys: matchedRightKeys.size,
      selectedFields: fields,
    },
    engine: "browser-deterministic-grain-preserving-enrichment",
  };
}

export function executeJoinPipeline(catalog: DatasetCatalog, specs: JoinSpec[]): JoinPipelineResult {
  if (specs.length < 1 || specs.length > 2) throw new Error("三表范围内的关联管线必须包含 1 至 2 个关联步骤");
  const firstLeft = table(catalog, specs[0].leftTableId);
  let records = firstLeft.profile.records.map((record, index) => withLineage(qualifiedRecord(firstLeft, record), { [firstLeft.tableId]: [index] }));
  const included = new Set([firstLeft.tableId]);
  const steps: JoinPipelineResult["steps"] = [];
  const checks: JoinExecutionCheck[] = [];
  const warnings: string[] = [];
  specs.forEach((spec) => {
    const validation = validateJoinSpec(catalog, spec);
    if (!validation.valid) throw new Error(`关联步骤“${spec.id}”未获准执行：${validation.errors.join("；")}`);
    if (!included.has(spec.leftTableId)) throw new Error("关联步骤顺序无效：左表尚未进入当前数据集");
    if (included.has(spec.rightTableId)) throw new Error("同一数据表不能被重复关联");
    const left = table(catalog, spec.leftTableId);
    const right = table(catalog, spec.rightTableId);
    const beforeRows = records.length;
    const executed = joinQualifiedRecords(records, left, right, spec);
    records = executed.records;
    included.add(right.tableId);
    steps.push({ joinSpecId: spec.id, beforeRows, afterRows: records.length, matchedOutputRows: executed.matchedOutputRows, unmatchedLeftRows: executed.unmatchedLeftRows });
    checks.push(
      { label: `${spec.id} 未发生多对多关联`, passed: validation.relationship.cardinality !== "N:N", detail: `关系 ${validation.relationship.cardinality}` },
      { label: `${spec.id} 数据版本一致`, passed: spec.leftVersionId === left.version.versionId && spec.rightVersionId === right.version.versionId, detail: "执行使用人工确认时绑定的数据版本" },
    );
    if (spec.joinType === "left") {
      checks.push({ label: `${spec.id} 左连接未丢失当前行`, passed: records.length >= beforeRows, detail: `${beforeRows} 行进入，${records.length} 行输出` });
    }
    if (spec.joinType === "left" && ["1:1", "N:1"].includes(validation.relationship.cardinality)) {
      checks.push({ label: `${spec.id} 维表关联未放大粒度`, passed: records.length === beforeRows, detail: `${beforeRows} 行进入，${records.length} 行输出` });
    }
    warnings.push(...validation.warnings);
  });
  const failedChecks = checks.filter((check) => !check.passed);
  if (failedChecks.length > 0) {
    throw new Error(`关联管线执行后的确定性校验失败：${failedChecks.map((check) => check.label).join("、")}`);
  }
  const reconciliations = amountReconciliations(catalog, records, [...included]);
  checks.push(...reconciliations.map(reconciliationCheck));
  warnings.push(...reconciliations.filter((item) => item.status !== "balanced").map((item) =>
    `${item.qualifiedField} 未通过关联金额对账；后续对该字段求和或求平均将被阻止，请先按正确业务粒度聚合。`
  ));
  return {
    records,
    tableIds: [...included],
    steps,
    amountReconciliations: reconciliations,
    checks,
    warnings: [...new Set(warnings)],
    engine: "browser-deterministic-join-pipeline",
  };
}
