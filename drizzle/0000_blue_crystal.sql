CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"resource_id" uuid,
	"title" varchar(500),
	"recommendation" text NOT NULL,
	"estimated_savings" numeric(10, 2),
	"severity" varchar(50),
	"confidence" integer,
	"status" varchar(50) DEFAULT 'pending',
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_remediations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recommendation_id" uuid,
	"organization_id" uuid NOT NULL,
	"action_type" varchar(255),
	"execution_plan" jsonb,
	"status" varchar(50) DEFAULT 'pending',
	"approved_by_user" boolean DEFAULT false,
	"executed_at" timestamp,
	"execution_logs" jsonb,
	"rollback_plan" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"resource_id" uuid,
	"title" varchar(255),
	"description" text,
	"severity" varchar(50),
	"status" varchar(50) DEFAULT 'open',
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"role" varchar(50) NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"title" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" varchar(50) NOT NULL,
	"account_name" varchar(255) NOT NULL,
	"account_identifier" varchar(255) NOT NULL,
	"status" varchar(50) DEFAULT 'connected',
	"credentials" jsonb,
	"last_scan_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"cloud_account_id" uuid NOT NULL,
	"provider" varchar(50) NOT NULL,
	"resource_id" varchar(500) NOT NULL,
	"resource_name" varchar(500),
	"resource_type" varchar(255) NOT NULL,
	"region" varchar(100),
	"service" varchar(100),
	"status" varchar(100),
	"monthly_cost" numeric(12, 2) DEFAULT '0',
	"utilization" numeric(5, 2),
	"tags" jsonb,
	"metadata" jsonb,
	"first_seen_at" timestamp,
	"last_seen_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"plan" varchar(50) DEFAULT 'free',
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_cost_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_id" uuid NOT NULL,
	"cost_date" timestamp NOT NULL,
	"daily_cost" numeric(10, 2) NOT NULL,
	"monthly_projection" numeric(10, 2)
);
--> statement-breakpoint
CREATE TABLE "scan_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"cloud_account_id" uuid NOT NULL,
	"status" varchar(50) DEFAULT 'pending',
	"started_at" timestamp,
	"completed_at" timestamp,
	"resources_found" integer,
	"scan_metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_recommendations" ADD CONSTRAINT "ai_recommendations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_recommendations" ADD CONSTRAINT "ai_recommendations_resource_id_cloud_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."cloud_resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_remediations" ADD CONSTRAINT "ai_remediations_recommendation_id_ai_recommendations_id_fk" FOREIGN KEY ("recommendation_id") REFERENCES "public"."ai_recommendations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_remediations" ADD CONSTRAINT "ai_remediations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_resource_id_cloud_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."cloud_resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_accounts" ADD CONSTRAINT "cloud_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_resources" ADD CONSTRAINT "cloud_resources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_resources" ADD CONSTRAINT "cloud_resources_cloud_account_id_cloud_accounts_id_fk" FOREIGN KEY ("cloud_account_id") REFERENCES "public"."cloud_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_cost_history" ADD CONSTRAINT "resource_cost_history_resource_id_cloud_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."cloud_resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_jobs" ADD CONSTRAINT "scan_jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_jobs" ADD CONSTRAINT "scan_jobs_cloud_account_id_cloud_accounts_id_fk" FOREIGN KEY ("cloud_account_id") REFERENCES "public"."cloud_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");