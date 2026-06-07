CREATE TABLE "usage_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "cloud_account_id" uuid,
  "monthly_limit" numeric(12, 2) NOT NULL,
  "alert_threshold_percent" integer DEFAULT 80 NOT NULL,
  "alert_email" varchar(320),
  "enabled" boolean DEFAULT true NOT NULL,
  "last_alert_sent_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "usage_policies" ADD CONSTRAINT "usage_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "usage_policies" ADD CONSTRAINT "usage_policies_cloud_account_id_cloud_accounts_id_fk" FOREIGN KEY ("cloud_account_id") REFERENCES "public"."cloud_accounts"("id") ON DELETE no action ON UPDATE no action;
