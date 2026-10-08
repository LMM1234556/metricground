import { CellValue, DatasetProfile, isValidDateValue, profileRecords, QualityIssue } from "./tabular-profile";

export type CleaningAction = {
  issueId: string;
  issueTitle: string;
  action: NonNullable<QualityIssue["supportedRepair"]>;
  actionLabel: string;
  affectedRows: number;
};

export type CleaningReceipt = {
  sourceFileName: string;
  derivedFileName: string;
  sourceRows: number;
  resultRows: number;
  removedRows: number;
  issuesBefore: number;
  issuesAfter: number;
  checksSkippedAfter: number;
  actions: CleaningAction[];
};

export type CleaningPreview = {
  cleanedProfile: DatasetProfile;
  receipt: CleaningReceipt;
};

function isMissing(value: CellValue | undefined) {
  return value === null
    || value === undefined
    || (typeof value === "string" && ["", "null", "undefined", "__null__"].includes(value.trim().toLowerCase()));
}

function canonicalValue(value: CellValue | undefined) {
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (typeof value === "string") return `string:${value.trim()}`;
  return `${typeof value}:${String(value ?? "")}`;
}

function derivedFileName(fileName: string) {
  const extensionIndex = fileName.lastIndexOf(".");
  const baseName = extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName;
  return `${baseName}-cleaned.csv`;
}

function actionLabel(issue: QualityIssue) {
  if (issue.supportedRepair === "deduplicate_exact") return "移除完全重复副本，保留首次出现的记录";
  if (issue.supportedRepair === "drop_missing") return `删除“${issue.field}”缺失的记录`;
  return `删除“${issue.field}”无法识别为日期的记录`;
}

export function applyCleaningPlan(profile: DatasetProfile, selectedIssueIds: string[]): CleaningPreview {
  const selected = profile.qualityIssues.filter((issue) =>
    selectedIssueIds.includes(issue.id) && Boolean(issue.supportedRepair),
  );
  if (selected.length === 0) throw new Error("请至少选择一项可执行的清洗规则。");

  const headers = profile.columns.map((column) => column.name);
  let records = profile.records.map((record) => ({ ...record }));
  const actions: CleaningAction[] = [];

  selected
    .sort((left, right) => Number(right.supportedRepair === "deduplicate_exact") - Number(left.supportedRepair === "deduplicate_exact"))
    .forEach((issue) => {
      const before = records.length;
      if (issue.supportedRepair === "deduplicate_exact") {
        const seen = new Set<string>();
        records = records.filter((record) => {
          const signature = JSON.stringify(headers.map((header) => canonicalValue(record[header])));
          if (seen.has(signature)) return false;
          seen.add(signature);
          return true;
        });
      } else if (issue.supportedRepair === "drop_missing" && issue.field) {
        records = records.filter((record) => !isMissing(record[issue.field!]));
      } else if (issue.supportedRepair === "drop_invalid_date" && issue.field) {
        records = records.filter((record) => isMissing(record[issue.field!]) || isValidDateValue(record[issue.field!]));
      }
      actions.push({
        issueId: issue.id,
        issueTitle: issue.title,
        action: issue.supportedRepair!,
        actionLabel: actionLabel(issue),
        affectedRows: before - records.length,
      });
    });

  const cleanedProfile = profileRecords(records, {
    fileName: derivedFileName(profile.fileName),
    fileSize: profile.fileSize,
    fileType: profile.fileType,
    sheetNames: profile.sheetNames,
    activeSheet: profile.activeSheet,
  });
  return {
    cleanedProfile,
    receipt: {
      sourceFileName: profile.fileName,
      derivedFileName: cleanedProfile.fileName,
      sourceRows: profile.rowCount,
      resultRows: cleanedProfile.rowCount,
      removedRows: profile.rowCount - cleanedProfile.rowCount,
      issuesBefore: profile.qualityIssues.length,
      issuesAfter: cleanedProfile.qualityIssues.length,
      checksSkippedAfter: cleanedProfile.qualityChecksSkipped.length,
      actions,
    },
  };
}

function csvCell(value: CellValue | undefined) {
  if (value === null || value === undefined) return "";
  const text = value instanceof Date ? value.toISOString() : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function profileAsCsv(profile: DatasetProfile) {
  const headers = profile.columns.map((column) => column.name);
  return [
    headers.map(csvCell).join(","),
    ...profile.records.map((record) => headers.map((header) => csvCell(record[header])).join(",")),
  ].join("\r\n");
}
