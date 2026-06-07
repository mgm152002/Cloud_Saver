import { relations } from "drizzle-orm";
import { pgTable, text, timestamp, boolean, index,
  uuid,
  varchar,
  jsonb,
  integer,
  numeric } from "drizzle-orm/pg-core";

// ============== TABLES ==============

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const organizations = pgTable("organizations", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  plan: varchar("plan", { length: 50 }).default("free"),
  ownerId: text("owner_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const cloudAccounts = pgTable("cloud_accounts", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id")
    .references(() => organizations.id)
    .notNull(),
  provider: varchar("provider", { length: 50 }).notNull(),
  accountName: varchar("account_name", { length: 255 }).notNull(),
  accountIdentifier: varchar("account_identifier", { length: 255 }).notNull(),
  status: varchar("status", { length: 50 }).default("connected"),
  credentials: jsonb("credentials"),
  lastScanAt: timestamp("last_scan_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const scanJobs = pgTable("scan_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id")
    .references(() => organizations.id)
    .notNull(),
  cloudAccountId: uuid("cloud_account_id")
    .references(() => cloudAccounts.id)
    .notNull(),
  status: varchar("status", { length: 50 }).default("pending"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  resourcesFound: integer("resources_found"),
  scanMetadata: jsonb("scan_metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const cloudResources = pgTable("cloud_resources", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id")
    .references(() => organizations.id)
    .notNull(),
  cloudAccountId: uuid("cloud_account_id")
    .references(() => cloudAccounts.id)
    .notNull(),
  provider: varchar("provider", { length: 50 }).notNull(),
  resourceId: varchar("resource_id", { length: 500 }).notNull(),
  resourceName: varchar("resource_name", { length: 500 }),
  resourceType: varchar("resource_type", { length: 255 }).notNull(),
  region: varchar("region", { length: 100 }),
  service: varchar("service", { length: 100 }),
  status: varchar("status", { length: 100 }),
  monthlyCost: numeric("monthly_cost", { precision: 12, scale: 2 }).default("0"),
  utilization: numeric("utilization", { precision: 5, scale: 2 }),
  tags: jsonb("tags"),
  metadata: jsonb("metadata"),
  firstSeenAt: timestamp("first_seen_at"),
  lastSeenAt: timestamp("last_seen_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const resourceCostHistory = pgTable("resource_cost_history", {
  id: uuid("id").defaultRandom().primaryKey(),
  resourceId: uuid("resource_id")
    .references(() => cloudResources.id)
    .notNull(),
  costDate: timestamp("cost_date").notNull(),
  dailyCost: numeric("daily_cost", { precision: 10, scale: 2 }).notNull(),
  monthlyProjection: numeric("monthly_projection", { precision: 10, scale: 2 }),
});

export const aiRecommendations = pgTable("ai_recommendations", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id")
    .references(() => organizations.id)
    .notNull(),
  resourceId: uuid("resource_id").references(() => cloudResources.id),
  title: varchar("title", { length: 500 }),
  recommendation: text("recommendation").notNull(),
  estimatedSavings: numeric("estimated_savings", { precision: 10, scale: 2 }),
  severity: varchar("severity", { length: 50 }),
  confidence: integer("confidence"),
  status: varchar("status", { length: 50 }).default("pending"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const aiRemediations = pgTable("ai_remediations", {
  id: uuid("id").defaultRandom().primaryKey(),
  recommendationId: uuid("recommendation_id").references(() => aiRecommendations.id),
  organizationId: uuid("organization_id")
    .references(() => organizations.id)
    .notNull(),
  actionType: varchar("action_type", { length: 255 }),
  executionPlan: jsonb("execution_plan"),
  status: varchar("status", { length: 50 }).default("pending"),
  approvedByUser: boolean("approved_by_user").default(false),
  executedAt: timestamp("executed_at"),
  executionLogs: jsonb("execution_logs"),
  rollbackPlan: jsonb("rollback_plan"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const chatSessions = pgTable("chat_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id").references(() => organizations.id),
  cloudAccountId: uuid("cloud_account_id").references(() => cloudAccounts.id),
  title: varchar("title", { length: 255 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const chatMessages = pgTable("chat_messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id")
    .references(() => chatSessions.id)
    .notNull(),
  role: varchar("role", { length: 50 }).notNull(),
  content: text("content").notNull(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const alerts = pgTable("alerts", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id")
    .references(() => organizations.id)
    .notNull(),
  resourceId: uuid("resource_id").references(() => cloudResources.id),
  title: varchar("title", { length: 255 }),
  description: text("description"),
  severity: varchar("severity", { length: 50 }),
  status: varchar("status", { length: 50 }).default("open"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const usagePolicies = pgTable("usage_policies", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id")
    .references(() => organizations.id)
    .notNull(),
  cloudAccountId: uuid("cloud_account_id").references(() => cloudAccounts.id),
  monthlyLimit: numeric("monthly_limit", { precision: 12, scale: 2 }).notNull(),
  alertThresholdPercent: integer("alert_threshold_percent").default(80).notNull(),
  alertEmail: varchar("alert_email", { length: 320 }),
  enabled: boolean("enabled").default(true).notNull(),
  lastAlertSentAt: timestamp("last_alert_sent_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ============== RELATIONS ==============

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  organizations: many(organizations),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

export const organizationRelations = relations(organizations, ({ one, many }) => ({
  owner: one(user, {
    fields: [organizations.ownerId],
    references: [user.id],
  }),
  cloudAccounts: many(cloudAccounts),
  scanJobs: many(scanJobs),
  cloudResources: many(cloudResources),
  aiRecommendations: many(aiRecommendations),
  aiRemediations: many(aiRemediations),
  chatSessions: many(chatSessions),
  alerts: many(alerts),
  usagePolicies: many(usagePolicies),
}));

export const cloudAccountsRelations = relations(cloudAccounts, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [cloudAccounts.organizationId],
    references: [organizations.id],
  }),
  scanJobs: many(scanJobs),
  cloudResources: many(cloudResources),
}));

export const scanJobsRelations = relations(scanJobs, ({ one }) => ({
  organization: one(organizations, {
    fields: [scanJobs.organizationId],
    references: [organizations.id],
  }),
  cloudAccount: one(cloudAccounts, {
    fields: [scanJobs.cloudAccountId],
    references: [cloudAccounts.id],
  }),
}));

export const cloudResourcesRelations = relations(cloudResources, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [cloudResources.organizationId],
    references: [organizations.id],
  }),
  cloudAccount: one(cloudAccounts, {
    fields: [cloudResources.cloudAccountId],
    references: [cloudAccounts.id],
  }),
  resourceCostHistory: many(resourceCostHistory),
  aiRecommendations: many(aiRecommendations),
  alerts: many(alerts),
  usagePolicies: many(usagePolicies),
}));

export const resourceCostHistoryRelations = relations(resourceCostHistory, ({ one }) => ({
  resource: one(cloudResources, {
    fields: [resourceCostHistory.resourceId],
    references: [cloudResources.id],
  }),
}));

export const aiRecommendationsRelations = relations(aiRecommendations, ({ one }) => ({
  organization: one(organizations, {
    fields: [aiRecommendations.organizationId],
    references: [organizations.id],
  }),
  resource: one(cloudResources, {
    fields: [aiRecommendations.resourceId],
    references: [cloudResources.id],
  }),
}));

export const aiRemediationsRelations = relations(aiRemediations, ({ one }) => ({
  recommendation: one(aiRecommendations, {
    fields: [aiRemediations.recommendationId],
    references: [aiRecommendations.id],
  }),
  organization: one(organizations, {
    fields: [aiRemediations.organizationId],
    references: [organizations.id],
  }),
}));

export const chatSessionsRelations = relations(chatSessions, ({ one, many }) => ({
  user: one(user, {
    fields: [chatSessions.userId],
    references: [user.id],
  }),
  organization: one(organizations, {
    fields: [chatSessions.organizationId],
    references: [organizations.id],
  }),
  cloudAccount: one(cloudAccounts, {
    fields: [chatSessions.cloudAccountId],
    references: [cloudAccounts.id],
  }),
  messages: many(chatMessages),
}));

export const chatMessagesRelations = relations(chatMessages, ({ one }) => ({
  session: one(chatSessions, {
    fields: [chatMessages.sessionId],
    references: [chatSessions.id],
  }),
}));

export const alertsRelations = relations(alerts, ({ one }) => ({
  organization: one(organizations, {
    fields: [alerts.organizationId],
    references: [organizations.id],
  }),
  resource: one(cloudResources, {
    fields: [alerts.resourceId],
    references: [cloudResources.id],
  }),
}));

export const usagePoliciesRelations = relations(usagePolicies, ({ one }) => ({
  organization: one(organizations, {
    fields: [usagePolicies.organizationId],
    references: [organizations.id],
  }),
  cloudAccount: one(cloudAccounts, {
    fields: [usagePolicies.cloudAccountId],
    references: [cloudAccounts.id],
  }),
}));
