import { createDatasetVersion, type DatasetVersion } from "./analysis-spec.ts";
import type { CellValue, DatasetProfile } from "./tabular-profile";

export type CatalogTable = {
  tableId: string;
  alias: string;
  version: DatasetVersion;
  profile: DatasetProfile;
};

export type DatasetCatalog = {
  version: "1.0";
  tables: CatalogTable[];
};

export type KeyProfile = {
  tableId: string;
  fields: string[];
  rowCount: number;
  nonNullRows: number;
  nullRows: number;
  distinctKeyCount: number;
  duplicatedKeyCount: number;
  rowsWithDuplicatedKeys: number;
  unique: boolean;
};

export type RelationshipCardinality = "1:1" | "1:N" | "N:1" | "N:N";

export type RelationshipProfile = {
  id: string;
  leftTableId: string;
  rightTableId: string;
  leftFields: string[];
  rightFields: string[];
  leftKey: KeyProfile;
  rightKey: KeyProfile;
  cardinality: RelationshipCardinality;
  matchedLeftRows: number;
  matchedRightRows: number;
  leftRowCoverage: number;
  rightRowCoverage: number;
  leftOrphanRows: number;
  rightOrphanRows: number;
  leftOrphanKeys: number;
  rightOrphanKeys: number;
  estimatedLeftJoinRows: number;
  estimatedLeftJoinExpansion: number;
  duplicatedLeftMeasureRisk: boolean;
  blockedByDefault: boolean;
  warnings: string[];
};

function normalizedAlias(value: string) {
  const normalized = value.trim().replace(/\.[^.]+$/, "").replace(/[^\p{L}\p{N}_]+/gu, "_").replace(/^_+|_+$/g, "");
  return normalized || "table";
}

export function createDatasetCatalog(inputs: Array<{ profile: DatasetProfile; alias?: string }>): DatasetCatalog {
  if (inputs.length < 1 || inputs.length > 3) throw new Error("DatasetCatalog 仅支持 1 至 3 张表");
  const usedAliases = new Set<string>();
  const tables = inputs.map((input, index): CatalogTable => {
    const version = createDatasetVersion(input.profile);
    const base = normalizedAlias(input.alias ?? input.profile.activeSheet ?? input.profile.fileName);
    let alias = base;
    let suffix = 2;
    while (usedAliases.has(alias)) alias = `${base}_${suffix++}`;
    usedAliases.add(alias);
    return {
      tableId: `table_${index + 1}_${version.datasetId.replace(/^dataset_/, "")}`,
      alias,
      version,
      profile: input.profile,
    };
  });
  return { version: "1.0", tables };
}

function missing(value: CellValue | undefined) {
  return value === null || value === undefined || (typeof value === "string" && ["", "null", "undefined", "__null__"].includes(value.trim().toLowerCase()));
}

function normalizedKeyPart(value: CellValue) {
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (typeof value === "string") return `string:${value.trim().toLowerCase()}`;
  return `${typeof value}:${String(value)}`;
}

function recordKey(record: Record<string, CellValue>, fields: string[]) {
  const values = fields.map((field) => record[field]);
  if (values.some(missing)) return null;
  return values.map((value) => normalizedKeyPart(value as CellValue)).join("\u001f");
}

function requireTable(catalog: DatasetCatalog, tableId: string) {
  const table = catalog.tables.find((item) => item.tableId === tableId);
  if (!table) throw new Error(`找不到数据表：${tableId}`);
  return table;
}

function validateFields(table: CatalogTable, fields: string[]) {
  if (fields.length < 1 || fields.length > 2) throw new Error("关联键必须为 1 个字段或 2 个字段组成的复合键");
  if (new Set(fields).size !== fields.length) throw new Error("复合键字段不能重复");
  const existing = new Set(table.profile.columns.map((column) => column.name));
  fields.forEach((field) => {
    if (!existing.has(field)) throw new Error(`表“${table.alias}”不存在字段“${field}”`);
  });
}

export function profileTableKey(catalog: DatasetCatalog, tableId: string, fields: string[]): KeyProfile {
  const table = requireTable(catalog, tableId);
  validateFields(table, fields);
  const counts = new Map<string, number>();
  let nullRows = 0;
  table.profile.records.forEach((record) => {
    const key = recordKey(record, fields);
    if (key === null) {
      nullRows += 1;
      return;
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  const duplicated = [...counts.values()].filter((count) => count > 1);
  return {
    tableId,
    fields: [...fields],
    rowCount: table.profile.rowCount,
    nonNullRows: table.profile.rowCount - nullRows,
    nullRows,
    distinctKeyCount: counts.size,
    duplicatedKeyCount: duplicated.length,
    rowsWithDuplicatedKeys: duplicated.reduce((sum, count) => sum + count, 0),
    unique: nullRows === 0 && counts.size === table.profile.rowCount,
  };
}

function cardinality(left: KeyProfile, right: KeyProfile): RelationshipCardinality {
  if (left.unique && right.unique) return "1:1";
  if (left.unique) return "1:N";
  if (right.unique) return "N:1";
  return "N:N";
}

function ratio(value: number, total: number) {
  return total === 0 ? 0 : value / total;
}

function shortHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function profileRelationship(
  catalog: DatasetCatalog,
  input: { leftTableId: string; rightTableId: string; leftFields: string[]; rightFields: string[] },
): RelationshipProfile {
  if (input.leftTableId === input.rightTableId) throw new Error("关联关系必须发生在两张不同的表之间");
  if (input.leftFields.length !== input.rightFields.length) throw new Error("左右关联键字段数量必须一致");
  const left = requireTable(catalog, input.leftTableId);
  const right = requireTable(catalog, input.rightTableId);
  validateFields(left, input.leftFields);
  validateFields(right, input.rightFields);
  const leftKey = profileTableKey(catalog, left.tableId, input.leftFields);
  const rightKey = profileTableKey(catalog, right.tableId, input.rightFields);
  const leftCounts = new Map<string, number>();
  const rightCounts = new Map<string, number>();
  left.profile.records.forEach((record) => {
    const key = recordKey(record, input.leftFields);
    if (key !== null) leftCounts.set(key, (leftCounts.get(key) ?? 0) + 1);
  });
  right.profile.records.forEach((record) => {
    const key = recordKey(record, input.rightFields);
    if (key !== null) rightCounts.set(key, (rightCounts.get(key) ?? 0) + 1);
  });

  let matchedLeftRows = 0;
  let matchedRightRows = 0;
  let leftOrphanRows = leftKey.nullRows;
  let rightOrphanRows = rightKey.nullRows;
  let leftOrphanKeys = 0;
  let rightOrphanKeys = 0;
  let estimatedLeftJoinRows = 0;
  leftCounts.forEach((count, key) => {
    const rightMatches = rightCounts.get(key) ?? 0;
    if (rightMatches > 0) matchedLeftRows += count;
    else {
      leftOrphanRows += count;
      leftOrphanKeys += 1;
    }
    estimatedLeftJoinRows += count * Math.max(1, rightMatches);
  });
  estimatedLeftJoinRows += leftKey.nullRows;
  rightCounts.forEach((count, key) => {
    if (leftCounts.has(key)) matchedRightRows += count;
    else {
      rightOrphanRows += count;
      rightOrphanKeys += 1;
    }
  });

  const relation = cardinality(leftKey, rightKey);
  const expansion = ratio(estimatedLeftJoinRows, left.profile.rowCount);
  const warnings: string[] = [];
  if (leftKey.nullRows > 0 || rightKey.nullRows > 0) warnings.push("关联键存在空值，空键记录不能匹配");
  if (leftOrphanRows > 0) warnings.push(`左表有 ${leftOrphanRows} 行无法匹配右表`);
  if (rightOrphanRows > 0) warnings.push(`右表有 ${rightOrphanRows} 行无法匹配左表`);
  if (relation === "N:N") warnings.push("检测到多对多关系，默认禁止执行，需先聚合或修正关联键");
  if (expansion > 1) warnings.push(`按左表关联预计产生 ${expansion.toFixed(2)} 倍行数膨胀`);
  if (relation === "1:N" || relation === "N:N") warnings.push("左表数值字段在关联后可能被重复累计");
  return {
    id: `rel_${shortHash(`${left.tableId}:${input.leftFields.join("+")}=${right.tableId}:${input.rightFields.join("+")}`)}`,
    leftTableId: left.tableId,
    rightTableId: right.tableId,
    leftFields: [...input.leftFields],
    rightFields: [...input.rightFields],
    leftKey,
    rightKey,
    cardinality: relation,
    matchedLeftRows,
    matchedRightRows,
    leftRowCoverage: ratio(matchedLeftRows, left.profile.rowCount),
    rightRowCoverage: ratio(matchedRightRows, right.profile.rowCount),
    leftOrphanRows,
    rightOrphanRows,
    leftOrphanKeys,
    rightOrphanKeys,
    estimatedLeftJoinRows,
    estimatedLeftJoinExpansion: expansion,
    duplicatedLeftMeasureRisk: relation === "1:N" || relation === "N:N",
    blockedByDefault: relation === "N:N",
    warnings,
  };
}

function normalizedFieldName(name: string) {
  return name.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function identifierLike(name: string) {
  return /id|key|code|no|number|编号|编码|单号/i.test(name);
}

function compatibleTypes(left: CatalogTable, leftField: string, right: CatalogTable, rightField: string) {
  const leftType = left.profile.columns.find((column) => column.name === leftField)?.inferredType;
  const rightType = right.profile.columns.find((column) => column.name === rightField)?.inferredType;
  return leftType === rightType || [leftType, rightType].every((type) => type === "文本" || type === "混合");
}

export function discoverRelationshipCandidates(catalog: DatasetCatalog): RelationshipProfile[] {
  const candidates: RelationshipProfile[] = [];
  for (let leftIndex = 0; leftIndex < catalog.tables.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < catalog.tables.length; rightIndex += 1) {
      const left = catalog.tables[leftIndex];
      const right = catalog.tables[rightIndex];
      const pairs = left.profile.columns.flatMap((leftColumn) => right.profile.columns
        .filter((rightColumn) => normalizedFieldName(leftColumn.name) === normalizedFieldName(rightColumn.name))
        .filter((rightColumn) => compatibleTypes(left, leftColumn.name, right, rightColumn.name))
        .map((rightColumn) => ({ left: leftColumn.name, right: rightColumn.name })));
      const preferred = pairs.filter((pair) => identifierLike(pair.left) || identifierLike(pair.right));
      const singles = preferred.length > 0 ? preferred : pairs;
      singles.slice(0, 8).forEach((pair) => {
        candidates.push(profileRelationship(catalog, {
          leftTableId: left.tableId, rightTableId: right.tableId, leftFields: [pair.left], rightFields: [pair.right],
        }));
      });
      for (let first = 0; first < preferred.length; first += 1) {
        for (let second = first + 1; second < preferred.length; second += 1) {
          const candidate = profileRelationship(catalog, {
            leftTableId: left.tableId,
            rightTableId: right.tableId,
            leftFields: [preferred[first].left, preferred[second].left],
            rightFields: [preferred[first].right, preferred[second].right],
          });
          if (candidate.leftKey.unique || candidate.rightKey.unique) candidates.push(candidate);
        }
      }
    }
  }
  return candidates.sort((left, right) => {
    const leftScore = (left.blockedByDefault ? 10 : 0) + left.leftOrphanRows + left.rightOrphanRows;
    const rightScore = (right.blockedByDefault ? 10 : 0) + right.leftOrphanRows + right.rightOrphanRows;
    return leftScore - rightScore;
  });
}
