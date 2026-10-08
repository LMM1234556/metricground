import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = dirname(scriptDirectory);
const sourceDirectory = `${projectDirectory}/node_modules/@duckdb/duckdb-wasm/dist`;
const targetDirectory = `${projectDirectory}/public/duckdb`;
const assetNames = [
  "duckdb-mvp.wasm",
  "duckdb-eh.wasm",
  "duckdb-browser-mvp.worker.js",
  "duckdb-browser-eh.worker.js",
];

export async function syncDuckDBAssets() {
  await mkdir(targetDirectory, { recursive: true });
  await Promise.all(assetNames.map((assetName) => copyFile(
    `${sourceDirectory}/${assetName}`,
    `${targetDirectory}/${assetName}`,
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
      "",
      "These files are copied from the installed npm package at dev/build time.",
    ].join("\n"),
    "utf8",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await syncDuckDBAssets();
}
