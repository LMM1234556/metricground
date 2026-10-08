import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const taskRuns = sqliteTable("task_runs", {
  id: text("id").primaryKey(),
  traceId: text("trace_id").notNull(),
  state: text("state").notNull(),
  question: text("question").notNull(),
  payload: text("payload").notNull(),
  revision: integer("revision").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  persistedAt: text("persisted_at").notNull(),
}, (table) => [
  index("task_runs_trace_id_idx").on(table.traceId),
  index("task_runs_updated_at_idx").on(table.updatedAt),
]);

export const taskRunWrites = sqliteTable("task_run_writes", {
  idempotencyKey: text("idempotency_key").primaryKey(),
  taskRunId: text("task_run_id").notNull(),
  revision: integer("revision").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("task_run_writes_task_run_id_idx").on(table.taskRunId)]);
