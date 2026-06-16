CREATE TABLE "job_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "cloud_account_id" uuid NOT NULL,
  "scan_job_id" uuid,
  "trigger_run_id" varchar(255),
  "task_identifier" varchar(255) NOT NULL,
  "job_type" varchar(100) NOT NULL,
  "status" varchar(50) DEFAULT 'queued' NOT NULL,
  "message" text,
  "resources_found" integer,
  "started_at" timestamp,
  "completed_at" timestamp,
  "metadata" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_history" ADD CONSTRAINT "job_history_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "job_history" ADD CONSTRAINT "job_history_cloud_account_id_cloud_accounts_id_fk" FOREIGN KEY ("cloud_account_id") REFERENCES "public"."cloud_accounts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "job_history" ADD CONSTRAINT "job_history_scan_job_id_scan_jobs_id_fk" FOREIGN KEY ("scan_job_id") REFERENCES "public"."scan_jobs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "job_history_organization_id_idx" ON "job_history" USING btree ("organization_id");
--> statement-breakpoint
CREATE INDEX "job_history_cloud_account_id_idx" ON "job_history" USING btree ("cloud_account_id");
--> statement-breakpoint
CREATE INDEX "job_history_created_at_idx" ON "job_history" USING btree ("created_at");
