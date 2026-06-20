import { auth } from "@/app/lib/auth";
import { aiRecommendations, aiRemediations, cloudAccounts, cloudResources, organizations } from "@/db/auth-schema";
import { db } from "@/db/db";
import { and, eq } from "drizzle-orm";
import { createOpenRouterModel } from "@/app/lib/ai";
import { z } from "zod";
import { generateObject, generateText } from "ai";

const allowedActions = new Set(["create_plan", "approve_plan", "mark_done", "dismiss"]);

const keyValueSchema = z.object({
  key: z.string(),
  value: z.union([z.string(), z.number(), z.boolean()]).nullable(),
});

const remediationSchema = z.object({
  recommendationTitle: z.string().nullable(),
  recommendation: z.string(),
  estimatedSavings: z.union([z.string(), z.number()]).nullable(),
  resourceId: z.string(),
  resourceName: z.string().nullable(),
  actionType: z.string(),
  currentState: z.array(keyValueSchema),
  targetState: z.array(keyValueSchema),
  evidence: z.array(z.string()),
  steps: z.array(z.string()),
  awsCli: z.array(z.string()),
  approvalsRequired: z.array(z.string()),
  riskNotes: z.array(z.string()),
  context: z.object({
    organizationId: z.string(),
    organizationName: z.string(),
    accountId: z.string(),
    accountName: z.string(),
    accountIdentifier: z.string(),
    provider: z.string(),
    region: z.string().nullable(),
    recommendationId: z.string(),
    resourceDatabaseId: z.string(),
    resourceType: z.string(),
    service: z.string().nullable(),
    monthlyCost: z.string().nullable(),
    utilization: z.string().nullable(),
    tags: z.array(keyValueSchema),
    tagContext: z.object({
      owner: z.string().nullable(),
      environment: z.string().nullable(),
      workload: z.string().nullable(),
      costCenter: z.string().nullable(),
      summary: z.array(z.string()),
    }),
    metadataSummary: z.array(keyValueSchema),
    draftPlan: z.string(),
  }),
  rollbackPlan: z.object({
    steps: z.array(z.string()),
    awsCli: z.array(z.string()),
  }),
});

function isValidAction(action: string): boolean {
  return allowedActions.has(action);
}

function keyValuesToRecord(items: z.infer<typeof keyValueSchema>[]) {
  return Object.fromEntries(items.map((item) => [item.key, item.value]));
}

function recordToKeyValues(record: Record<string, unknown> | null | undefined) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return [];

  return Object.entries(record).map(([key, value]) => ({
    key,
    value: typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : JSON.stringify(value),
  }));
}

function normalizeResourceTags(tags: unknown) {
  if (!tags || typeof tags !== "object" || Array.isArray(tags)) return {};

  return Object.fromEntries(
    Object.entries(tags)
      .filter(([key, value]) => key.trim() && value !== null && typeof value !== "undefined")
      .map(([key, value]) => [key, String(value)]),
  );
}

function findTagValue(tags: Record<string, string>, names: string[]) {
  const normalizedNames = new Set(names.map((name) => name.toLowerCase()));
  const match = Object.entries(tags).find(([key]) => normalizedNames.has(key.toLowerCase()));
  return match?.[1] ?? null;
}

function buildTagContext(tags: Record<string, string>) {
  return {
    owner: findTagValue(tags, ["owner", "team", "applicationOwner", "appOwner"]),
    environment: findTagValue(tags, ["environment", "env", "stage"]),
    workload: findTagValue(tags, ["workload", "application", "app", "service"]),
    costCenter: findTagValue(tags, ["costCenter", "cost-centre", "cost_center", "billingCode"]),
    summary: Object.entries(tags).map(([key, value]) => `${key}: ${value}`),
  };
}

function buildContext({
  organization,
  account,
  recommendation,
  resource,
  draftPlan,
}: {
  organization: typeof organizations.$inferSelect;
  account: typeof cloudAccounts.$inferSelect;
  recommendation: typeof aiRecommendations.$inferSelect;
  resource: typeof cloudResources.$inferSelect;
  draftPlan?: string;
}) {
  const tags = normalizeResourceTags(resource.tags);

  return {
    organization: {
      id: organization.id,
      name: organization.name,
    },
    account: {
      id: account.id,
      name: account.accountName,
      identifier: account.accountIdentifier,
      provider: account.provider,
      status: account.status,
      lastScanAt: account.lastScanAt,
    },
    recommendation: {
      id: recommendation.id,
      title: recommendation.title,
      recommendation: recommendation.recommendation,
      estimatedSavings: recommendation.estimatedSavings,
      severity: recommendation.severity,
      confidence: recommendation.confidence,
    },
    resource: {
      databaseId: resource.id,
      resourceId: resource.resourceId,
      name: resource.resourceName,
      type: resource.resourceType,
      service: resource.service,
      region: resource.region,
      status: resource.status,
      utilization: resource.utilization,
      monthlyCost: resource.monthlyCost,
      tags,
      tagContext: buildTagContext(tags),
      metadata: resource.metadata,
    },
    resourceTags: tags,
    tagContext: buildTagContext(tags),
    draftPlan,
  };
}

function inferActionType(resource: typeof cloudResources.$inferSelect, recommendation: typeof aiRecommendations.$inferSelect) {
  const text = `${recommendation.title ?? ""} ${recommendation.recommendation}`.toLowerCase();
  if (resource.resourceType === "ec2-instance" && /\b(rightsize|resize|downsize|instance type)\b/.test(text)) return "ec2_rightsize_instance";
  if (resource.resourceType === "ec2-instance" && /\b(stop|schedule)\b/.test(text)) return "ec2_schedule_or_stop_instance";
  if (resource.resourceType === "ec2-volume") return "ebs_volume_cleanup";
  if (resource.resourceType === "s3-bucket") return "s3_storage_optimization";
  if (resource.resourceType === "rds-instance") return "rds_instance_optimization";
  return "manual_review";
}

function normalizeActionType(
  generatedActionType: string | null | undefined,
  inferredActionType: string,
  resource: typeof cloudResources.$inferSelect,
) {
  const normalized = (generatedActionType ?? "").toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");

  if (resource.resourceType === "ec2-instance" && /\b(rightsize|resize|downsize|instance_type)\b/.test(normalized)) {
    return "ec2_rightsize_instance";
  }
  if (resource.resourceType === "ec2-instance" && /\b(stop|schedule|stopped_or_scheduled)\b/.test(normalized)) {
    return "ec2_schedule_or_stop_instance";
  }
  if (resource.resourceType === "ec2-volume" && /\b(ebs|volume|cleanup|delete|idle)\b/.test(normalized)) {
    return "ebs_volume_cleanup";
  }
  if (resource.resourceType === "s3-bucket" && /\b(s3|bucket|storage|lifecycle|archive)\b/.test(normalized)) {
    return "s3_storage_optimization";
  }
  if (resource.resourceType === "rds-instance" && /\b(rds|database|db|instance)\b/.test(normalized)) {
    return "rds_instance_optimization";
  }

  return inferredActionType;
}

const instanceSizeOrder = ["nano", "micro", "small", "medium", "large", "xlarge", "2xlarge", "4xlarge", "8xlarge", "12xlarge", "16xlarge", "24xlarge"];

function getCurrentInstanceType(resource: typeof cloudResources.$inferSelect) {
  const metadata = resource.metadata as { instanceType?: unknown } | null;
  return typeof metadata?.instanceType === "string" ? metadata.instanceType : null;
}

function getSmallerInstanceType(instanceType: string | null) {
  if (!instanceType?.includes(".")) return null;
  const [family, size] = instanceType.split(".");
  const currentIndex = instanceSizeOrder.indexOf(size);
  if (currentIndex <= 0) return null;
  return `${family}.${instanceSizeOrder[currentIndex - 1]}`;
}

function getConcreteEc2Target(resource: typeof cloudResources.$inferSelect) {
  return getSmallerInstanceType(getCurrentInstanceType(resource));
}

function replaceEc2TargetPlaceholders(text: string, resource: typeof cloudResources.$inferSelect) {
  if (resource.resourceType !== "ec2-instance") return text;

  const targetInstanceType = getConcreteEc2Target(resource);
  if (!targetInstanceType) return text;

  return text
    .replace(/<approved-smaller-instance-type>/gi, targetInstanceType)
    .replace(/<smaller-compatible-instance-type>/gi, targetInstanceType)
    .replace(/<target-instance-type>/gi, targetInstanceType)
    .replace(/<TARGET_INSTANCE_TYPE>/g, targetInstanceType);
}

function linesFromDraft(draftPlan: string) {
  return draftPlan
    .split("\n")
    .map((line) => line.replace(/^[-*\d.)\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, 12);
}

function buildFallbackStructuredPlan({
  organization,
  account,
  recommendation,
  resource,
  actionType,
  draftPlan,
}: {
  organization: typeof organizations.$inferSelect;
  account: typeof cloudAccounts.$inferSelect;
  recommendation: typeof aiRecommendations.$inferSelect;
  resource: typeof cloudResources.$inferSelect;
  actionType: string;
  draftPlan: string;
}): z.infer<typeof remediationSchema> {
  const tags = normalizeResourceTags(resource.tags);
  const tagContext = buildTagContext(tags);
  const draftLines = linesFromDraft(draftPlan);
  const currentInstanceType = getCurrentInstanceType(resource);
  const targetInstanceType = actionType === "ec2_rightsize_instance" ? getSmallerInstanceType(currentInstanceType) : null;

  return {
    recommendationTitle: recommendation.title,
    recommendation: recommendation.recommendation,
    estimatedSavings: recommendation.estimatedSavings,
    resourceId: resource.resourceId,
    resourceName: resource.resourceName,
    actionType,
    currentState: [
      { key: "resourceType", value: resource.resourceType },
      { key: "service", value: resource.service },
      { key: "status", value: resource.status },
      { key: "monthlyCost", value: resource.monthlyCost },
      { key: "utilization", value: resource.utilization },
      ...(currentInstanceType ? [{ key: "instanceType", value: currentInstanceType }] : []),
    ],
    targetState: [
      { key: "actionType", value: actionType },
      ...(targetInstanceType ? [{ key: "instanceType", value: targetInstanceType }] : []),
      { key: "expectedMonthlySavings", value: recommendation.estimatedSavings },
    ],
    evidence: [
      `Recommendation confidence: ${recommendation.confidence ?? 0}%`,
      `Severity: ${recommendation.severity ?? "unknown"}`,
      `Resource tags: ${Object.entries(tags).map(([key, value]) => `${key}=${value}`).join(", ") || "none"}`,
    ],
    steps: draftLines.length
      ? draftLines
      : [
          "Review the linked AWS resource and tags.",
          "Validate owner, environment, metrics, and rollback requirements.",
          "Use Approve and implement to run the registered AWS remediation tool.",
          "Refresh Cloud Saver after implementation to verify savings.",
        ],
    awsCli: draftLines.filter((line) => line.startsWith("aws ")),
    approvalsRequired: [
      tagContext.owner ? `Owner approval: ${tagContext.owner}` : "Resource owner approval",
      tagContext.environment ? `Environment approval: ${tagContext.environment}` : "Environment approval",
    ],
    riskNotes: [
      "This structured plan was generated deterministically because the model returned invalid JSON.",
      "Validate production impact before implementation.",
    ],
    context: {
      organizationId: organization.id,
      organizationName: organization.name,
      accountId: account.id,
      accountName: account.accountName,
      accountIdentifier: account.accountIdentifier,
      provider: account.provider,
      region: resource.region,
      recommendationId: recommendation.id,
      resourceDatabaseId: resource.id,
      resourceType: resource.resourceType,
      service: resource.service,
      monthlyCost: resource.monthlyCost,
      utilization: resource.utilization,
      tags: recordToKeyValues(tags),
      tagContext,
      metadataSummary: recordToKeyValues(resource.metadata as Record<string, unknown> | null).slice(0, 20),
      draftPlan,
    },
    rollbackPlan: {
      steps: [
        "Use the saved action plan and execution logs to identify the changed AWS setting.",
        "Revert the AWS setting or restore from the snapshot/backup created before the change.",
        "Run a Cloud Saver scan to confirm the resource state and cost projection.",
      ],
      awsCli: [],
    },
  };
}

function isPlaceholderValue(value: unknown) {
  return typeof value === "string" && /<.*>|placeholder|compatible|target/i.test(value);
}

function normalizeStructuredPlan(
  object: z.infer<typeof remediationSchema>,
  resource: typeof cloudResources.$inferSelect,
): z.infer<typeof remediationSchema> {
  const isEc2Rightsize =
    resource.resourceType === "ec2-instance" &&
    (object.actionType === "ec2_rightsize_instance" ||
      object.targetState.some((item) => item.key === "instanceType") ||
      `${object.recommendation} ${object.steps.join(" ")}`.toLowerCase().includes("rightsiz"));
  if (!isEc2Rightsize) return object;

  const currentInstanceType = getCurrentInstanceType(resource);
  const targetInstanceType = getConcreteEc2Target(resource);
  if (!targetInstanceType) return object;

  const currentState = [...object.currentState];
  if (!currentState.some((item) => item.key === "instanceType")) {
    currentState.push({ key: "instanceType", value: currentInstanceType });
  }

  const targetState = object.targetState.filter((item) => item.key !== "instanceType");
  targetState.unshift({ key: "instanceType", value: targetInstanceType });

  return {
    ...object,
    currentState,
    targetState: object.targetState.some((item) => item.key === "instanceType" && !isPlaceholderValue(item.value))
      ? object.targetState
      : targetState,
    evidence: [
      ...object.evidence,
      `Cloud Saver selected concrete EC2 target instance type ${targetInstanceType} from current ${currentInstanceType}.`,
    ],
  };
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ orgId: string; accountId: string; recommendationId: string }> },
) {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { orgId, accountId, recommendationId } = await params;
  const body = await req.json().catch(() => ({}));
  const action = typeof body.action === "string" ? body.action : "";
  if (!isValidAction(action)) {
    return Response.json({ message: "Invalid action" }, { status: 400 });
  }

  const [organization] = await db
    .select()
    .from(organizations)
    .where(and(eq(organizations.id, orgId), eq(organizations.ownerId, session.user.id)))
    .limit(1);

  if (!organization) {
    return Response.json({ message: "Organization not found" }, { status: 404 });
  }

  const [account] = await db
    .select()
    .from(cloudAccounts)
    .where(and(eq(cloudAccounts.id, accountId), eq(cloudAccounts.organizationId, orgId)))
    .limit(1);

  if (!account) {
    return Response.json({ message: "Cloud account not found" }, { status: 404 });
  }

  const [recommendation] = await db
    .select()
    .from(aiRecommendations)
    .where(
      and(
        eq(aiRecommendations.id, recommendationId),
        eq(aiRecommendations.accountId, accountId),
        eq(aiRecommendations.organizationId, orgId),
      ),
    )
    .limit(1);

  if (!recommendation) {
    return Response.json({ message: "Recommendation not found" }, { status: 404 });
  }

  if (action === "mark_done" || action === "dismiss") {
    const [updatedRecommendation] = await db
      .update(aiRecommendations)
      .set({ status: action === "mark_done" ? "completed" : "dismissed" })
      .where(eq(aiRecommendations.id, recommendationId))
      .returning();

    return Response.json({ recommendation: updatedRecommendation });
  }

  const requestedResourceId = typeof body.resourceId === "string" ? body.resourceId : recommendation.resourceId;
  if (!requestedResourceId) {
    return Response.json({ message: "Resource id is required" }, { status: 400 });
  }

  const [resource] = await db
    .select()
    .from(cloudResources)
    .where(
      and(
        eq(cloudResources.id, requestedResourceId),
        eq(cloudResources.cloudAccountId, accountId),
        eq(cloudResources.organizationId, orgId),
      ),
    )
    .limit(1);

  if (!resource) {
    return Response.json({ message: "Resource not found" }, { status: 404 });
  }

  const model = createOpenRouterModel();
  if (!model) {
    return Response.json({ message: "OPENROUTER_API_KEY is not configured" }, { status: 500 });
  }

  const actionType = inferActionType(resource, recommendation);
  const draftPlan = replaceEc2TargetPlaceholders(typeof body.draftPlan === "string" ? body.draftPlan : "", resource);
  const context = buildContext({ organization, account, recommendation, resource, draftPlan });

  if (action === "create_plan") {
    const result = await generateText({
      model,
      system:
        "You create concise cloud cost action plans for approval. Return formatted plain text only. Include summary, resource context, resource tags such as owner/environment/workload/cost center when present, expected savings, validation steps, implementation steps, risk notes, and rollback. Do not output JSON.",
      prompt: `Build an approval-ready action plan from this Cloud Saver context:\n${JSON.stringify(context, null, 2)}`,
    });

    const formattedDraftPlan = replaceEc2TargetPlaceholders(result.text, resource);

    return Response.json({
      actionType,
      draftPlan: formattedDraftPlan,
      context,
    });
  }

  let object: z.infer<typeof remediationSchema>;
  let usedFallback = false;

  try {
    const result = await generateObject({
      model,
      schema: remediationSchema,
      prompt:
        "Generate a structured JSON remediation object for the approved Cloud Saver action plan. Preserve all given context, including resource tags and tagContext. Use owner/environment/workload/cost-center tags to shape approvals, risk notes, and validation steps when present. AWS CLI commands must be conservative and include placeholders where destructive or environment-specific values are required.\n\n" +
        JSON.stringify(context, null, 2),
    });
    object = result.object;
  } catch (error) {
    usedFallback = true;
    console.error("Falling back to deterministic remediation plan", error);
    object = buildFallbackStructuredPlan({
      organization,
      account,
      recommendation,
      resource,
      actionType,
      draftPlan,
    });
  }
  object = normalizeStructuredPlan(object, resource);
  const normalizedActionType = normalizeActionType(object.actionType, actionType, resource);

  const [remediation] = await db
    .insert(aiRemediations)
    .values({
      recommendationId,
      organizationId: orgId,
      actionType: normalizedActionType,
      executionPlan: {
        recommendationTitle: object.recommendationTitle,
        recommendation: object.recommendation,
        estimatedSavings: object.estimatedSavings,
        resourceId: object.resourceId,
        resourceName: object.resourceName,
        currentState: keyValuesToRecord(object.currentState),
        targetState: keyValuesToRecord(object.targetState),
        evidence: object.evidence,
        steps: object.steps,
        awsCli: object.awsCli,
        approvalsRequired: object.approvalsRequired,
        riskNotes: usedFallback ? [...object.riskNotes, "AI structured output failed, so Cloud Saver preserved the approved draft as a deterministic structured plan."] : object.riskNotes,
        context: object.context,
      },
      rollbackPlan: object.rollbackPlan,
      status: "approved",
      approvedByUser: true,
    })
    .returning();

  await db.update(aiRecommendations).set({ status: "approved" }).where(eq(aiRecommendations.id, recommendationId));

  return Response.json({ remediation, structuredPlan: object });
}
