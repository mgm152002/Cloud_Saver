ALTER TABLE "chat_sessions" ADD COLUMN "cloud_account_id" uuid;
--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_cloud_account_id_cloud_accounts_id_fk" FOREIGN KEY ("cloud_account_id") REFERENCES "public"."cloud_accounts"("id") ON DELETE no action ON UPDATE no action;
