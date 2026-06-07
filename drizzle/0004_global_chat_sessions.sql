ALTER TABLE "chat_sessions" ADD COLUMN "user_id" text;
--> statement-breakpoint
ALTER TABLE "chat_sessions" ALTER COLUMN "organization_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
