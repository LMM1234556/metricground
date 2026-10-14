"use client";

import { useState } from "react";
import { ChevronLeft, ChevronRight, FileDown } from "lucide-react";
import type { DatasetProfile } from "../lib/tabular-profile";
import { fieldDisplayName } from "../lib/field-label";
import { profileAsCsv } from "../lib/data-cleaning";

const PAGE_SIZE = 25;

export function downloadDatasetCsv(profile: DatasetProfile) {
  // Neutralize spreadsheet formulas only in text cells; numeric values keep their type.
  const records = profile.records.map((record) => Object.fromEntries(
    Object.entries(record).map(([field, value]) => [field,
      typeof value === "string" && /^\s*[=+@-]/.test(value) ? `'${value}` : value,
    ]),
  ));
  const columns = profile.columns.map((column) => ({ ...column,
    name: /^\s*[=+@-]/.test(column.name) ? `'${column.name}` : column.name,
  }));
  const renamedRecords = records.map((record) => Object.fromEntries(
    profile.columns.map((column, index) => [columns[index].name, record[column.name]]),
  ));
  const content = profileAsCsv({ ...profile, columns, records: renamedRecords });
  const url = URL.createObjectURL(new Blob(["\uFEFF", content], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = profile.fileName.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]/g, "-") + ".csv";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function DatasetResult({ profile }: { profile: DatasetProfile }) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(profile.records.length / PAGE_SIZE));
  const activePage = Math.min(page, pageCount - 1);
  const start = activePage * PAGE_SIZE;
  const rows = profile.records.slice(start, start + PAGE_SIZE);
  return (
    <section className="dataset-result" aria-label="派生结果明细">
      <div className="dataset-result-heading">
        <div><h3>结果明细</h3><p>{profile.fileName} · {profile.records.length.toLocaleString("zh-CN")} 行 · {profile.columns.length} 列</p></div>
        <button type="button" onClick={() => downloadDatasetCsv(profile)}><FileDown size={15} />下载 CSV</button>
      </div>
      <p className="dataset-result-note">这里展示当前派生数据，可翻页检查；下载包含全部行和字段。下载操作在当前浏览器内完成。以公式符号开头的文本会添加保护前缀。</p>
      <div className="dataset-result-table-wrap">
        <table className="dataset-result-table">
          <thead><tr><th scope="col">行号</th>{profile.columns.map((column) => <th scope="col" key={column.name} title={column.name}>{fieldDisplayName(column.name)}</th>)}</tr></thead>
          <tbody>{rows.map((record, index) => <tr key={start + index}><th scope="row">{start + index + 1}</th>{profile.columns.map((column) => {
            const value = record[column.name];
            const text = value instanceof Date ? value.toISOString() : String(value ?? "");
            return <td key={column.name} className={text === "" ? "empty-cell" : ""}>{text === "" ? <span aria-label="空值">（空）</span> : text}</td>;
          })}</tr>)}</tbody>
        </table>
      </div>
      {rows.length === 0 && <p role="status">当前结果没有数据行。</p>}
      <nav className="dataset-result-pagination" aria-label="结果明细分页">
        <span>{rows.length ? `${start + 1}–${start + rows.length}` : "0"} / {profile.records.length.toLocaleString("zh-CN")} 行</span>
        <button type="button" aria-label="上一页结果" disabled={activePage === 0} onClick={() => setPage(activePage - 1)}><ChevronLeft size={15} />上一页</button>
        <span>第 {activePage + 1} / {pageCount} 页</span>
        <button type="button" aria-label="下一页结果" disabled={activePage >= pageCount - 1} onClick={() => setPage(activePage + 1)}>下一页<ChevronRight size={15} /></button>
      </nav>
    </section>
  );
}
