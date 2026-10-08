export type CellValue = string | number | boolean | Date | null;

export type ColumnProfile = {
  name: string;
  inferredType: "文本" | "数值" | "日期" | "布尔" | "混合" | "空列";
  missingCount: number;
  missingRate: number;
  uniqueCount: number;
  examples: string[];
  isCandidateKey: boolean;
};

export type QualityIssue = {
  id: string;
  check: "重复行" | "键与粒度" | "完整性" | "有效性" | "异常值";
  severity: "高" | "中" | "低";
  title: string;
  evidence: string;
  impact: string;
  recommendation: string;
  requiresApproval: boolean;
  field?: string;
  supportedRepair?: "deduplicate_exact" | "drop_missing" | "drop_invalid_date";
};

export type QualitySummary = {
  checksRun: number;
  passedChecks: number;
  highIssues: number;
  mediumIssues: number;
  lowIssues: number;
};

export type QualityCheckSkip = {
  check: "异常值";
  field: string;
  reason: string;
};

export type JoinAmountReconciliation = {
  tableId: string;
  tableAlias: string;
  field: string;
  qualifiedField: string;
  sourceTotal: number;
  outputTotal: number;
  netDelta: number;
  netDeltaRate: number | null;
  validSourceRows: number;
  outputValueRows: number;
  duplicatedSourceRows: number;
  excludedSourceRows: number;
  duplicationImpact: number;
  exclusionImpact: number;
  status: "balanced" | "duplicated" | "excluded" | "mixed";
};

export type DatasetProfile = {
  fileName: string;
  fileSize: number;
  fileType: "CSV" | "Excel";
  sheetNames: string[];
  activeSheet: string;
  headerRowNumber: number;
  rowCount: number;
  columnCount: number;
  missingCellCount: number;
  columns: ColumnProfile[];
  candidateKeys: string[];
  grainSuggestion: string;
  qualityIssues: QualityIssue[];
  qualityChecksSkipped: QualityCheckSkip[];
  qualitySummary: QualitySummary;
  joinAmountReconciliations?: JoinAmountReconciliation[];
  records: Array<Record<string, CellValue>>;
};

const EMPTY_VALUES = new Set(["", "null", "undefined", "__null__"]);
export const MAX_TABULAR_ROWS = 100_000;
export const MAX_TABULAR_COLUMNS = 200;

function enforceTabularBounds(rows: CellValue[][]) {
  if (rows.length > MAX_TABULAR_ROWS + 20) {
    throw new Error(`当前最多处理 ${MAX_TABULAR_ROWS.toLocaleString("en-US")} 行数据。`);
  }
  const width = rows.reduce((maximum, row) => Math.max(maximum, row.length), 0);
  if (width > MAX_TABULAR_COLUMNS) {
    throw new Error(`当前最多处理 ${MAX_TABULAR_COLUMNS} 列数据。`);
  }
}

function isMissing(value: unknown) {
  return value === null
    || value === undefined
    || (typeof value === "string" && EMPTY_VALUES.has(value.trim().toLowerCase()));
}

function detectDelimiter(text: string) {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim()) ?? "";
  const candidates = [",", "\t", ";"];
  let best = ",";
  let bestCount = -1;

  for (const candidate of candidates) {
    let count = 0;
    let quoted = false;
    for (let index = 0; index < firstLine.length; index += 1) {
      if (firstLine[index] === '"') quoted = !quoted;
      else if (!quoted && firstLine[index] === candidate) count += 1;
    }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

export function parseCsv(text: string): CellValue[][] {
  const source = text.replace(/^\uFEFF/, "");
  const delimiter = detectDelimiter(source);
  const rows: CellValue[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }

  row.push(cell);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  return rows;
}

function makeHeaders(row: CellValue[], width: number) {
  const used = new Map<string, number>();
  return Array.from({ length: width }, (_, index) => {
    const raw = row[index];
    const base = raw === null || raw === undefined || String(raw).trim() === ""
      ? `未命名列 ${index + 1}`
      : String(raw).trim();
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    return count === 1 ? base : `${base}（${count}）`;
  });
}

function findHeaderRow(rows: CellValue[][], width: number) {
  const headerWords = /id|编号|编码|名称|日期|时间|状态|金额|价格|数量|类型|类别|地区|字段|含义|说明|描述|备注|单位|表名|用途|角色|rate|date|time|amount|price|status|name|type|count|description|note|unit|value/i;
  let bestIndex = 0;
  let bestScore = Number.NEGATIVE_INFINITY;

  rows.slice(0, 20).forEach((row, rowIndex) => {
    const present = Array.from({ length: width }, (_, index) => row[index])
      .filter((value) => !isMissing(value));
    if (present.length === 0) return;
    const textValues = present.map((value) => String(value).trim());
    const distinctCount = new Set(textValues).size;
    const headerMatches = textValues.filter((value) => headerWords.test(value)).length;
    const numericCount = present.filter((value) => typeof value === "number").length;
    const duplicatePenalty = present.length - distinctCount;
    const score = distinctCount * 2
      + headerMatches * 3
      + (present.length - numericCount) * 0.25
      - numericCount * 0.6
      - duplicatePenalty * 2
      - rowIndex * 0.15;
    if (score > bestScore) {
      bestIndex = rowIndex;
      bestScore = score;
    }
  });

  return bestIndex;
}

export function isValidDateValue(value: unknown) {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  const match = normalized.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T].*)?$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  const calendarDateIsValid = parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
  if (!calendarDateIsValid) return false;
  return !/[ T]/.test(normalized) || Number.isFinite(Date.parse(normalized));
}

function classify(value: unknown) {
  if (isValidDateValue(value)) return "日期";
  if (typeof value === "number" && Number.isFinite(value)) return "数值";
  if (typeof value === "boolean") return "布尔";
  if (typeof value !== "string") return "文本";

  const normalized = value.trim();
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(normalized)) return "数值";
  if (/^(?:true|false|是|否)$/i.test(normalized)) return "布尔";
  return "文本";
}

function displayValue(value: unknown) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value);
  return text.length > 28 ? `${text.slice(0, 27)}…` : text;
}

function uniqueValue(value: unknown) {
  if (value instanceof Date) return `date:${value.toISOString()}`;
  return `${typeof value}:${String(value)}`;
}

function inferGrain(candidateKeys: string[]) {
  if (candidateKeys.length === 0) {
    return "未发现单列唯一键，可能需要复合主键或人工确认数据粒度。";
  }

  const key = candidateKeys[0];
  const normalized = key.toLowerCase();
  if (/order.*item|item.*id|明细/.test(normalized)) return `“${key}”可唯一标识记录，一行可能代表一条商品或交易明细。`;
  if (/order|订单/.test(normalized)) return `“${key}”可唯一标识记录，一行可能代表一笔订单。`;
  if (/customer|user|member|客户|用户|会员/.test(normalized)) return `“${key}”可唯一标识记录，一行可能代表一位客户或用户。`;
  return `“${key}”在当前数据中唯一，一行可能代表一个由该字段标识的业务记录。`;
}

function looksLikeIdentifier(name: string) {
  return /(?:^|[_\s-])(?:id|key|code|no|number)(?:$|[_\s-])|编号|编码|单号|主键/i.test(name);
}

function quantile(values: number[], probability: number) {
  const position = (values.length - 1) * probability;
  const lower = Math.floor(position);
  const remainder = position - lower;
  return values[lower + 1] === undefined
    ? values[lower]
    : values[lower] + remainder * (values[lower + 1] - values[lower]);
}

function buildQualityIssues(
  dataRows: CellValue[][],
  headers: string[],
  columns: ColumnProfile[],
): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const rowCounts = new Map<string, number>();
  dataRows.forEach((row) => {
    const signature = JSON.stringify(headers.map((_, index) => {
      const value = row[index] ?? null;
      if (value instanceof Date) return value.toISOString();
      return typeof value === "string" ? value.trim() : value;
    }));
    rowCounts.set(signature, (rowCounts.get(signature) ?? 0) + 1);
  });
  const duplicateGroups = [...rowCounts.values()].filter((count) => count > 1);
  const duplicateRows = duplicateGroups.reduce((sum, count) => sum + count - 1, 0);
  if (duplicateRows > 0) {
    issues.push({
      id: "duplicate-rows",
      check: "重复行",
      severity: "高",
      title: `发现 ${duplicateRows.toLocaleString("zh-CN")} 行完全重复记录`,
      evidence: `${duplicateGroups.length} 组记录重复，重复副本占数据行的 ${(duplicateRows / dataRows.length * 100).toFixed(1)}%。`,
      impact: "直接聚合可能重复计算订单量、金额或其他指标。",
      recommendation: "先核实重复记录是重复采集还是有效业务明细，再决定是否去除重复副本。",
      requiresApproval: true,
      supportedRepair: "deduplicate_exact",
    });
  }

  headers.forEach((name, columnIndex) => {
    const column = columns[columnIndex];
    const present = dataRows
      .map((row) => row[columnIndex] ?? null)
      .filter((value) => !isMissing(value));

    if (looksLikeIdentifier(name) && present.length > 0) {
      const counts = new Map<string, number>();
      present.forEach((value) => {
        const normalized = String(value).trim().toLowerCase();
        counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
      });
      const repeatedValues = [...counts.values()].filter((count) => count > 1);
      const affectedRows = repeatedValues.reduce((sum, count) => sum + count, 0);
      if (affectedRows > 0) {
        issues.push({
          id: `identifier-duplicates-${columnIndex}`,
          check: "键与粒度",
          severity: column.missingCount > 0 ? "高" : "中",
          title: `标识字段“${name}”存在重复值`,
          evidence: `${repeatedValues.length.toLocaleString("zh-CN")} 个标识值重复，涉及 ${affectedRows.toLocaleString("zh-CN")} 行。`,
          impact: "这可能是正常的一对多明细，也可能违反预期主键；在确认粒度前不能直接去重。",
          recommendation: `确认一行数据代表什么，并判断“${name}”应当唯一还是允许重复。`,
          requiresApproval: false,
          field: name,
        });
      }
    }

    if (column.missingCount > 0) {
      const rate = column.missingRate;
      issues.push({
        id: `missing-${columnIndex}`,
        check: "完整性",
        severity: looksLikeIdentifier(name) || rate >= 0.2 ? "高" : rate >= 0.05 ? "中" : "低",
        title: `字段“${name}”存在缺失值`,
        evidence: `${column.missingCount.toLocaleString("zh-CN")} 行缺失，占该字段的 ${(rate * 100).toFixed(1)}%。`,
        impact: "删除、填补或忽略缺失值会改变样本范围，可能影响指标和分组结论。",
        recommendation: "先确认缺失的业务含义和允许范围；未经确认不要自动填补或删除。",
        requiresApproval: true,
        field: name,
        supportedRepair: "drop_missing",
      });
    }

    const dateLike = /date|time|日期|时间/i.test(name);
    if (dateLike && present.length > 0) {
      const invalidDates = present.filter((value) => classify(value) !== "日期").length;
      if (invalidDates > 0) {
        issues.push({
          id: `invalid-date-${columnIndex}`,
          check: "有效性",
          severity: invalidDates / present.length >= 0.05 ? "高" : "中",
          title: `日期字段“${name}”包含无法识别的值`,
          evidence: `${invalidDates.toLocaleString("zh-CN")} 个非空值无法按常见日期格式识别，占非空值的 ${(invalidDates / present.length * 100).toFixed(1)}%。`,
          impact: "按月汇总、周期比较和时间筛选可能遗漏或错误归档这些记录。",
          recommendation: "查看原始格式并确认日期规则，再统一转换；无法确认的值应单独标记。",
          requiresApproval: true,
          field: name,
          supportedRepair: "drop_invalid_date",
        });
      }
    } else if (column.inferredType === "混合") {
      issues.push({
        id: `mixed-type-${columnIndex}`,
        check: "有效性",
        severity: "中",
        title: `字段“${name}”包含混合类型`,
        evidence: `样例值包括：${column.examples.join("、") || "未提供"}。`,
        impact: "排序、筛选或数值计算时可能出现转换失败和结果遗漏。",
        recommendation: "先确定字段的目标类型，再将无法转换的值单独列出供人工处理。",
        requiresApproval: true,
        field: name,
      });
    }

    if (column.inferredType === "数值" && !looksLikeIdentifier(name)) {
      const numericValues = present
        .map((value) => typeof value === "number" ? value : Number(String(value).trim()))
        .filter((value) => Number.isFinite(value))
        .sort((left, right) => left - right);
      if (numericValues.length >= 8) {
        const firstQuartile = quantile(numericValues, 0.25);
        const thirdQuartile = quantile(numericValues, 0.75);
        const range = thirdQuartile - firstQuartile;
        const lowerBound = firstQuartile - 1.5 * range;
        const upperBound = thirdQuartile + 1.5 * range;
        const outliers = numericValues.filter((value) => value < lowerBound || value > upperBound);
        if (outliers.length > 0) {
          issues.push({
            id: `outlier-${columnIndex}`,
            check: "异常值",
            severity: "中",
            title: `数值字段“${name}”存在 ${outliers.length} 个统计异常值`,
            evidence: `按 IQR 规则，正常参考范围约为 ${lowerBound.toFixed(2)} 至 ${upperBound.toFixed(2)}；异常值占 ${(outliers.length / numericValues.length * 100).toFixed(1)}%。`,
            impact: "异常值可能是真实的大额业务，也可能是录入、单位或小数点错误，会显著影响均值与总额。",
            recommendation: "回查原始记录和单位，不应仅因统计异常就自动删除。",
            requiresApproval: false,
            field: name,
          });
        }
      }
    }
  });

  return issues;
}

export function profileRows(
  rows: CellValue[][],
  metadata: Pick<DatasetProfile, "fileName" | "fileSize" | "fileType" | "sheetNames" | "activeSheet">,
): DatasetProfile {
  if (rows.length === 0) throw new Error("文件中没有可读取的数据。");

  const width = rows.reduce((maximum, current) => Math.max(maximum, current.length), 0);
  if (width === 0) throw new Error("文件中没有可读取的字段。");

  const headerRowIndex = findHeaderRow(rows, width);
  const headers = makeHeaders(rows[headerRowIndex], width);
  const dataRows = rows.slice(headerRowIndex + 1).filter((current) => current.some((value) => !isMissing(value)));
  if (dataRows.length === 0) throw new Error("文件只有表头，没有数据行。");

  let missingCellCount = 0;
  const columns = headers.map((name, columnIndex): ColumnProfile => {
    const values = dataRows.map((current) => current[columnIndex] ?? null);
    const present = values.filter((value) => !isMissing(value));
    const missingCount = values.length - present.length;
    missingCellCount += missingCount;
    const types = new Set(present.map(classify));
    const inferredType = present.length === 0
      ? "空列"
      : types.size === 1
        ? [...types][0] as ColumnProfile["inferredType"]
        : "混合";
    const unique = new Set(present.map(uniqueValue));
    const examples = [...new Set(present.map(displayValue))].slice(0, 3);
    const isCandidateKey = missingCount === 0
      && unique.size === dataRows.length
      && looksLikeIdentifier(name);

    return {
      name,
      inferredType,
      missingCount,
      missingRate: missingCount / dataRows.length,
      uniqueCount: unique.size,
      examples,
      isCandidateKey,
    };
  });

  const candidateKeys = columns.filter((column) => column.isCandidateKey).map((column) => column.name);
  const qualityIssues = buildQualityIssues(dataRows, headers, columns);
  const numericAnalysisColumns = columns.filter((column) =>
    column.inferredType === "数值" && !looksLikeIdentifier(column.name)
  );
  const qualityChecksSkipped: QualityCheckSkip[] = numericAnalysisColumns
    .filter((column) => dataRows.length - column.missingCount < 8)
    .map((column) => ({
      check: "异常值",
      field: column.name,
      reason: `仅 ${dataRows.length - column.missingCount} 个有效数值，少于 IQR 检查所需的 8 个。`,
    }));
  const anomalyCheckRan = numericAnalysisColumns.some((column) => dataRows.length - column.missingCount >= 8);
  const checksRun = 4 + Number(anomalyCheckRan);
  const failedChecks = new Set(qualityIssues.map((issue) => issue.check)).size;
  const records = dataRows.map((row) => Object.fromEntries(
    headers.map((header, index) => [header, row[index] ?? null]),
  ));
  return {
    ...metadata,
    headerRowNumber: headerRowIndex + 1,
    rowCount: dataRows.length,
    columnCount: width,
    missingCellCount,
    columns,
    candidateKeys,
    grainSuggestion: inferGrain(candidateKeys),
    qualityIssues,
    qualityChecksSkipped,
    records,
    qualitySummary: {
      checksRun,
      passedChecks: Math.max(0, checksRun - failedChecks),
      highIssues: qualityIssues.filter((issue) => issue.severity === "高").length,
      mediumIssues: qualityIssues.filter((issue) => issue.severity === "中").length,
      lowIssues: qualityIssues.filter((issue) => issue.severity === "低").length,
    },
  };
}

export function profileRecords(
  records: Array<Record<string, CellValue>>,
  metadata: Pick<DatasetProfile, "fileName" | "fileSize" | "fileType" | "sheetNames" | "activeSheet">,
): DatasetProfile {
  if (records.length === 0) throw new Error("清洗方案会移除全部记录，已阻止生成空数据副本。");
  const headers = Object.keys(records[0]);
  const rows: CellValue[][] = [headers, ...records.map((record) => headers.map((header) => record[header] ?? null))];
  return profileRows(rows, metadata);
}

export async function parseTabularFile(file: File, sheetName?: string): Promise<DatasetProfile> {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension !== "csv" && extension !== "xlsx") {
    throw new Error("当前仅支持 CSV 和 XLSX 文件。");
  }

  const maximumSize = extension === "csv" ? 20 * 1024 * 1024 : 10 * 1024 * 1024;
  if (file.size > maximumSize) {
    throw new Error(extension === "csv" ? "CSV 不能超过 20 MB。" : "Excel 不能超过 10 MB。");
  }

  if (extension === "csv") {
    const sample = await file.slice(0, 4096).text();
    if (sample.includes("\0")) throw new Error("CSV 包含二进制空字节，已拒绝解析。");
    const rows = parseCsv(await file.text());
    enforceTabularBounds(rows);
    const profile = profileRows(rows, {
      fileName: file.name,
      fileSize: file.size,
      fileType: "CSV",
      sheetNames: ["CSV 数据"],
      activeSheet: "CSV 数据",
    });
    if (profile.rowCount > MAX_TABULAR_ROWS) throw new Error(`当前最多处理 ${MAX_TABULAR_ROWS.toLocaleString("en-US")} 行数据。`);
    return profile;
  }

  const signature = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (signature.length < 4 || signature[0] !== 0x50 || signature[1] !== 0x4b) {
    throw new Error("文件扩展名为 XLSX，但内容不是有效的 Excel ZIP 容器。");
  }
  const { default: readWorkbook } = await import("read-excel-file/browser");
  const sheets = await readWorkbook(file);
  const sheetNames = sheets.map((sheet) => sheet.sheet);
  if (sheetNames.length === 0) throw new Error("Excel 中没有可读取的工作表。");
  const activeSheet = sheetName && sheetNames.includes(sheetName) ? sheetName : sheetNames[0];
  const rows = sheets.find((sheet) => sheet.sheet === activeSheet)?.data as CellValue[][] | undefined;
  if (!rows) throw new Error(`无法读取工作表“${activeSheet}”。`);
  enforceTabularBounds(rows);
  const profile = profileRows(rows, {
    fileName: file.name,
    fileSize: file.size,
    fileType: "Excel",
    sheetNames,
    activeSheet,
  });
  if (profile.rowCount > MAX_TABULAR_ROWS) throw new Error(`当前最多处理 ${MAX_TABULAR_ROWS.toLocaleString("en-US")} 行数据。`);
  return profile;
}
