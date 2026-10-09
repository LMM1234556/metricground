import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGzip, constants } from "node:zlib";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = dirname(scriptDirectory);
const sourceDirectory = `${projectDirectory}/node_modules/@duckdb/duckdb-wasm/dist`;
const targetDirectory = resolve(projectDirectory, "public/duckdb");
const wasmNames = ["duckdb-mvp.wasm", "duckdb-eh.wasm"];
const workerNames = [
  "duckdb-browser-mvp.worker.js",
  "duckdb-browser-eh.worker.js",
];

export async function syncDuckDBAssets() {
  const expectedParent = `${resolve(projectDirectory, "public")}${sep}`;
  if (!targetDirectory.startsWith(expectedParent)) {
    throw new Error(`Refusing to replace DuckDB assets outside public/: ${targetDirectory}`);
  }
  await rm(targetDirectory, { recursive: true, force: true });
  await mkdir(targetDirectory, { recursive: true });
  await Promise.all(workerNames.map((assetName) => copyFile(
    `${sourceDirectory}/${assetName}`,
    `${targetDirectory}/${assetName}`,
  )));
  await Promise.all(wasmNames.map((assetName) => pipeline(
    createReadStream(`${sourceDirectory}/${assetName}`),
    createGzip({ level: constants.Z_BEST_COMPRESSION }),
    createWriteStream(`${targetDirectory}/${assetName}.gz`),
  )));

  const packageJson = JSON.parse(await readFile(
    `${projectDirectory}/node_modules/@duckdb/duckdb-wasm/package.json`,
    "utf8",
  ));
  await writeFile(
    `${targetDirectory}/THIRD_PARTY_NOTICE.txt`,
    [
      `@duckdb/duckdb-wasm ${packageJson.version}`,
      `License: ${packageJson.license}`,
      `Source: ${packageJson.repository?.url ?? "https://github.com/duckdb/duckdb-wasm"}`,
      "WASM binaries are gzip-compressed during the build and decompressed in the browser.",
      "",
      "These files are copied from the installed npm package at dev/build time.",
    ].join("\n"),
    "utf8",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await syncDuckDBAssets();
}
