CREATE TABLE `task_run_writes` (
	`idempotency_key` text PRIMARY KEY NOT NULL,
	`task_run_id` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `task_run_writes_task_run_id_idx` ON `task_run_writes` (`task_run_id`);--> statement-breakpoint
CREATE TABLE `task_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`trace_id` text NOT NULL,
	`state` text NOT NULL,
	`question` text NOT NULL,
	`payload` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`persisted_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `task_runs_trace_id_idx` ON `task_runs` (`trace_id`);--> statement-breakpoint
CREATE INDEX `task_runs_updated_at_idx` ON `task_runs` (`updated_at`);