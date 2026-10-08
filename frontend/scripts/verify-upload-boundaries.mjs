import assert from "node:assert/strict";
import { File } from "node:buffer";
import { MAX_TABULAR_COLUMNS, MAX_TABULAR_ROWS, parseTabularFile } from "../app/lib/tabular-profile.ts";

async function rejected(file, pattern) {
  await assert.rejects(() => parseTabularFile(file), pattern);
}

await rejected(new File(["not a zip"], "spoofed.xlsx"), /不是有效的 Excel ZIP 容器/);
await rejected(new File(["a,b\n1,\0"], "binary.csv"), /二进制空字节/);

const wideHeader = Array.from({ length: MAX_TABULAR_COLUMNS + 1 }, (_, index) => `c${index}`).join(",");
await rejected(new File([`${wideHeader}\n${wideHeader}`], "wide.csv"), /最多处理 200 列/);

const oversizedRows = `id\n${Array.from({ length: MAX_TABULAR_ROWS + 21 }, (_, index) => index).join("\n")}`;
await rejected(new File([oversizedRows], "too-many-rows.csv"), /最多处理 100,000 行/);

console.log(JSON.stringify({
  checksPassed: true,
  maximumRows: MAX_TABULAR_ROWS,
  maximumColumns: MAX_TABULAR_COLUMNS,
  spoofedXlsxRejected: true,
  binaryCsvRejected: true,
}, null, 2));
