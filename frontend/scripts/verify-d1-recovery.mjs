import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const runtimeRoot = join(projectRoot, "runtime");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDirectory = join(runtimeRoot, "backups");
const restoreDirectory = join(runtimeRoot, "restore-drills", timestamp);
const backupPath = join(backupDirectory, `taskruns-${timestamp}.sql`);
const manifestPath = `${backupPath}.json`;
const wrangler = join(projectRoot, "node_modules", "wrangler", "bin", "wrangler.js");
const config = "wrangler.local.jsonc";

await mkdir(backupDirectory, { recursive: true });
await mkdir(restoreDirectory, { recursive: true });

function runWrangler(args) {
  const result = spawnSync(process.execPath, [wrangler, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`Wrangler failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function queryCounts(persistTo) {
  const args = [
    "d1", "execute", "site-creator-d1", "--local", "--config", config,
    "--command", "SELECT (SELECT COUNT(*) FROM task_runs) AS task_runs, (SELECT COUNT(*) FROM task_run_writes) AS writes, (SELECT COUNT(*) FROM task_run_owners) AS owners;",
    "--json",
  ];
  if (persistTo) args.splice(6, 0, "--persist-to", persistTo);
  const parsed = JSON.parse(runWrangler(args));
  assert.equal(parsed[0]?.success, true);
  return parsed[0].results[0];
}

const sourceCounts = queryCounts();
assert.equal(sourceCounts.owners, sourceCounts.task_runs, "Every persisted TaskRun must have an owner binding");
runWrangler([
  "d1", "export", "site-creator-d1", "--local", "--config", config,
  "--output", relative(projectRoot, backupPath), "--skip-confirmation",
]);

const backup = await readFile(backupPath);
assert.ok(backup.byteLength > 100, "D1 backup is unexpectedly small");
const sha256 = createHash("sha256").update(backup).digest("hex");

runWrangler([
  "d1", "execute", "site-creator-d1", "--local", "--config", config,
  "--persist-to", relative(projectRoot, restoreDirectory), "--file", relative(projectRoot, backupPath), "--yes",
]);
const restoredCounts = queryCounts(relative(projectRoot, restoreDirectory));
assert.deepEqual(restoredCounts, sourceCounts);

const manifest = {
  version: 1,
  createdAt: new Date().toISOString(),
  source: "local D1",
  backupFile: relative(projectRoot, backupPath).replaceAll("\\", "/"),
  sha256,
  bytes: backup.byteLength,
  sourceCounts,
  restoredCounts,
  restoreDrill: "passed",
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify(manifest, null, 2));
