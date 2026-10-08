CREATE TABLE `api_rate_limits` (
	`bucket_key` text PRIMARY KEY NOT NULL,
	`request_count` integer DEFAULT 1 NOT NULL,
	`expires_at` integer NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `api_rate_limits_expires_at_idx` ON `api_rate_limits` (`expires_at`);--> statement-breakpoint
CREATE TABLE `task_run_owners` (
	`task_run_id` text PRIMARY KEY NOT NULL,
	`owner_hash` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `task_run_owners` (`task_run_id`, `owner_hash`, `created_at`)
SELECT `id`, '864dd53ed0e8e149ae01cc2b36cdc40ba8e46ffde50c2c9704c9a16f24225e84', `created_at` FROM `task_runs`;
--> statement-breakpoint
CREATE INDEX `task_run_owners_owner_hash_idx` ON `task_run_owners` (`owner_hash`);
