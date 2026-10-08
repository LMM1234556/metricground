import { env } from "cloudflare:workers";
import type { TaskRun, TaskRunState } from "./task-run";

const VALID_STATES = new Set<TaskRunState>([
  "IDLE", "DATA_PROFILED", "PLANNING", "NEEDS_CLARIFICATION", "NEEDS_APPROVAL",
  "READY_TO_EXECUTE", "EXECUTING", "VALIDATING", "COMPLETED", "NEEDS_REVISION",
  "NEEDS_JOIN_REVISION", "DATA_VERSION_CHANGED", "UNSUPPORTED", "FAILED",
]);

let schemaReady: Promise<void> | null = null;
const LEGACY_ANONYMOUS_OWNER_HASH = "864dd53ed0e8e149ae01cc2b36cdc40ba8e46ffde50c2c9704c9a16f24225e84";

export function taskRunDb(): D1Database {
  if (!env.DB) throw new Error("D1 binding DB is unavailable");
  return env.DB;
}

export function ensureTaskRunSchema(db = taskRunDb()) {
  schemaReady ??= db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS task_runs (
      id TEXT PRIMARY KEY NOT NULL,
      trace_id TEXT NOT NULL,
      state TEXT NOT NULL,
      question TEXT NOT NULL,
      payload TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      persisted_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS task_runs_trace_id_idx ON task_runs(trace_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS task_runs_updated_at_idx ON task_runs(updated_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS task_run_writes (
      idempotency_key TEXT PRIMARY KEY NOT NULL,
      task_run_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS task_run_writes_task_run_id_idx ON task_run_writes(task_run_id)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS task_run_owners (
      task_run_id TEXT PRIMARY KEY NOT NULL,
      owner_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    db.prepare(`INSERT OR IGNORE INTO task_run_owners (task_run_id, owner_hash, created_at)
      SELECT id, ?, created_at FROM task_runs`).bind(LEGACY_ANONYMOUS_OWNER_HASH),
    db.prepare("CREATE INDEX IF NOT EXISTS task_run_owners_owner_hash_idx ON task_run_owners(owner_hash)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS api_rate_limits (
      bucket_key TEXT PRIMARY KEY NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 1,
      expires_at INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS api_rate_limits_expires_at_idx ON api_rate_limits(expires_at)"),
  ]).then(() => undefined).catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

export function parseTaskRun(value: unknown): TaskRun | null {
  if (!value || typeof value !== "object") return null;
  const run = value as Partial<TaskRun>;
  if (
    typeof run.id !== "string" || run.id.length < 8 || run.id.length > 160
    || typeof run.traceId !== "string" || run.traceId.length < 8 || run.traceId.length > 160
    || typeof run.question !== "string" || run.question.length > 500
    || typeof run.state !== "string" || !VALID_STATES.has(run.state as TaskRunState)
    || !Number.isInteger(run.persistenceRevision) || (run.persistenceRevision ?? -1) < 0
    || typeof run.createdAt !== "string" || typeof run.updatedAt !== "string"
    || !Array.isArray(run.datasetVersions) || !Array.isArray(run.plan)
    || !Array.isArray(run.toolCalls) || !Array.isArray(run.approvals) || !Array.isArray(run.events)
  ) return null;
  return run as TaskRun;
}

type StoredRunRow = {
  payload: string;
  revision: number;
  trace_id: string;
};

export async function readTaskRun(id: string, traceId: string, ownerHash: string, db = taskRunDb()) {
  await ensureTaskRunSchema(db);
  const row = await db.prepare(`SELECT task_runs.payload, task_runs.revision, task_runs.trace_id
      FROM task_runs INNER JOIN task_run_owners ON task_run_owners.task_run_id = task_runs.id
      WHERE task_runs.id = ? AND task_run_owners.owner_hash = ?`)
    .bind(id, ownerHash).first<StoredRunRow>();
  if (!row || row.trace_id !== traceId) return null;
  const parsed = parseTaskRun(JSON.parse(row.payload));
  return parsed ? { ...parsed, persistenceRevision: row.revision } : null;
}

export type PersistResult =
  | { kind: "saved" | "replayed"; run: TaskRun }
  | { kind: "conflict"; current: TaskRun | null };

export async function persistTaskRun(run: TaskRun, idempotencyKey: string, ownerHash: string, db = taskRunDb()): Promise<PersistResult> {
  await ensureTaskRunSchema(db);
  const priorWrite = await db.prepare("SELECT task_run_id, revision FROM task_run_writes WHERE idempotency_key = ?")
    .bind(idempotencyKey).first<{ task_run_id: string; revision: number }>();
  if (priorWrite) {
    if (priorWrite.task_run_id !== run.id) return { kind: "conflict", current: null };
    const replayed = await readTaskRun(run.id, run.traceId, ownerHash, db);
    return replayed ? { kind: "replayed", run: replayed } : { kind: "conflict", current: null };
  }

  const now = new Date().toISOString();
  const current = await readTaskRun(run.id, run.traceId, ownerHash, db);
  if (!current) {
    if (run.persistenceRevision !== 0) return { kind: "conflict", current: null };
    const stored = { ...run, persistenceRevision: 1 };
    const payload = JSON.stringify(stored);
    let results: D1Result[];
    try {
      results = await db.batch([
        db.prepare(`INSERT OR IGNORE INTO task_runs
          (id, trace_id, state, question, payload, revision, created_at, updated_at, persisted_at)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`)
          .bind(run.id, run.traceId, run.state, run.question, payload, run.createdAt, run.updatedAt, now),
        db.prepare(`INSERT INTO task_run_owners (task_run_id, owner_hash, created_at)
          SELECT ?, ?, ? WHERE EXISTS (
            SELECT 1 FROM task_runs WHERE id = ? AND trace_id = ? AND revision = 1 AND payload = ?
          )`).bind(run.id, ownerHash, now, run.id, run.traceId, payload),
        db.prepare(`INSERT INTO task_run_writes (idempotency_key, task_run_id, revision, created_at)
          SELECT ?, ?, 1, ? WHERE EXISTS (
            SELECT 1 FROM task_runs WHERE id = ? AND trace_id = ? AND revision = 1 AND payload = ?
          )`).bind(idempotencyKey, run.id, now, run.id, run.traceId, payload),
      ]);
    } catch (error) {
      const racedWrite = await db.prepare("SELECT task_run_id FROM task_run_writes WHERE idempotency_key = ?")
        .bind(idempotencyKey).first<{ task_run_id: string }>();
      if (racedWrite?.task_run_id === run.id) {
        const replayed = await readTaskRun(run.id, run.traceId, ownerHash, db);
        if (replayed) return { kind: "replayed", run: replayed };
      }
      throw error;
    }
    if (Number(results[0].meta.changes ?? 0) !== 1 || Number(results[1].meta.changes ?? 0) !== 1 || Number(results[2].meta.changes ?? 0) !== 1) {
      return { kind: "conflict", current: await readTaskRun(run.id, run.traceId, ownerHash, db) };
    }
    return { kind: "saved", run: stored };
  }

  if (current.persistenceRevision !== run.persistenceRevision) return { kind: "conflict", current };
  const nextRevision = current.persistenceRevision + 1;
  const stored = { ...run, persistenceRevision: nextRevision };
  const payload = JSON.stringify(stored);
  let results: D1Result[];
  try {
    results = await db.batch([
      db.prepare(`UPDATE task_runs
        SET state = ?, question = ?, payload = ?, revision = ?, updated_at = ?, persisted_at = ?
        WHERE id = ? AND trace_id = ? AND revision = ?`)
        .bind(run.state, run.question, payload, nextRevision, run.updatedAt, now, run.id, run.traceId, run.persistenceRevision),
      db.prepare(`INSERT INTO task_run_writes (idempotency_key, task_run_id, revision, created_at)
        SELECT ?, ?, ?, ? WHERE EXISTS (
          SELECT 1 FROM task_runs WHERE id = ? AND trace_id = ? AND revision = ? AND payload = ?
        )`).bind(idempotencyKey, run.id, nextRevision, now, run.id, run.traceId, nextRevision, payload),
    ]);
  } catch (error) {
    const racedWrite = await db.prepare("SELECT task_run_id FROM task_run_writes WHERE idempotency_key = ?")
      .bind(idempotencyKey).first<{ task_run_id: string }>();
    if (racedWrite?.task_run_id === run.id) {
      const replayed = await readTaskRun(run.id, run.traceId, ownerHash, db);
      if (replayed) return { kind: "replayed", run: replayed };
    }
    throw error;
  }
  if (Number(results[0].meta.changes ?? 0) !== 1 || Number(results[1].meta.changes ?? 0) !== 1) {
    return { kind: "conflict", current: await readTaskRun(run.id, run.traceId, ownerHash, db) };
  }
  return { kind: "saved", run: stored };
}
