CREATE TABLE "cost_daily_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "cloud_account_id" uuid NOT NULL REFERENCES "cloud_accounts"("id"),
  "cost_date" date NOT NULL,
  "dimension_type" varchar(50) NOT NULL,
  "dimension_value" varchar(500) NOT NULL,
  "amount" numeric(14, 2) NOT NULL,
  "currency" varchar(8) NOT NULL,
  "estimated" boolean DEFAULT false NOT NULL,
  "collected_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "cost_daily_account_date_dimension_idx"
  ON "cost_daily_records" ("cloud_account_id", "cost_date", "dimension_type", "dimension_value");
CREATE INDEX "cost_daily_account_date_idx"
  ON "cost_daily_records" ("cloud_account_id", "cost_date");

CREATE TABLE "cost_forecasts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "cloud_account_id" uuid NOT NULL REFERENCES "cloud_accounts"("id"),
  "month_start" date,
  "month_end" date,
  "month_to_date" numeric(14, 2),
  "predicted_remaining" numeric(14, 2),
  "forecasted_month_end" numeric(14, 2),
  "lower_bound" numeric(14, 2),
  "upper_bound" numeric(14, 2),
  "currency" varchar(8),
  "status" varchar(50) DEFAULT 'unavailable' NOT NULL,
  "error_message" text,
  "last_synced_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "cost_forecasts_account_idx"
  ON "cost_forecasts" ("cloud_account_id");

CREATE TABLE "cost_anomalies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "cloud_account_id" uuid NOT NULL REFERENCES "cloud_accounts"("id"),
  "anomaly_date" date NOT NULL,
  "dimension_type" varchar(50) NOT NULL,
  "dimension_value" varchar(500) NOT NULL,
  "service" varchar(500),
  "actual_cost" numeric(14, 2) NOT NULL,
  "baseline_cost" numeric(14, 2) NOT NULL,
  "increase_amount" numeric(14, 2) NOT NULL,
  "increase_percent" numeric(10, 2),
  "severity" varchar(50) NOT NULL,
  "explanation" text NOT NULL,
  "likely_resource_id" varchar(500),
  "resource_increase_amount" numeric(14, 2),
  "attribution_status" varchar(100) NOT NULL,
  "status" varchar(50) DEFAULT 'open' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "cost_anomalies_account_date_dimension_idx"
  ON "cost_anomalies" ("cloud_account_id", "anomaly_date", "dimension_type", "dimension_value");
CREATE INDEX "cost_anomalies_account_date_idx"
  ON "cost_anomalies" ("cloud_account_id", "anomaly_date");
