import { createOpenRouterModel } from "@/app/lib/ai";
import { auth } from "@/app/lib/auth";
import { aiRecommendations, chatMessages, chatSessions, cloudAccounts, cloudResources, organizations } from "@/db/auth-schema";
import { db } from "@/db/db";
import { generateText, stepCountIs, tool } from "ai";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

function metricGapForResource(resource: typeof cloudResources.$inferSelect) {
  const metadata = resource.metadata as {
    s3Activity?: { requestMetricsAvailable?: boolean };
    cloudWatchMetrics?: { enabled?: boolean; cpu?: { datapoints?: number } };
    attachments?: number;
    cpu?: { datapoints?: number };
  } | null;

  if (resource.resourceType === "s3-bucket" && metadata?.s3Activity?.requestMetricsAvailable !== true) {
    return {
      resourceId: resource.resourceId,
      resourceName: resource.resourceName,
      service: "s3",
      message: "Enable S3 request metrics or server access logging before deleting or archiving this bucket.",
    };
  }

  const hasEc2Metrics =
    (metadata?.cloudWatchMetrics?.enabled === true && Boolean(metadata.cloudWatchMetrics.cpu?.datapoints)) ||
    Boolean(metadata?.cpu?.datapoints);
  if (resource.resourceType === "ec2-instance" && !hasEc2Metrics) {
    return {
      resourceId: resource.resourceId,
      resourceName: resource.resourceName,
      service: "ec2",
      message: "CloudWatch EC2 CPU datapoints were not available, so rightsizing confidence is limited.",
    };
  }

  if (resource.resourceType === "ec2-volume" && Number(metadata?.attachments ?? 0) > 0 && metadata?.cloudWatchMetrics?.enabled !== true) {
    return {
      resourceId: resource.resourceId,
      resourceName: resource.resourceName,
      service: "ebs",
      message: "CloudWatch EBS volume metrics were not available, so idle-volume confidence is limited.",
    };
  }

  if (
    ["rds-instance", "load-balancer", "lambda-function"].includes(resource.resourceType) &&
    metadata?.cloudWatchMetrics?.enabled !== true
  ) {
    return {
      resourceId: resource.resourceId,
      resourceName: resource.resourceName,
      service: resource.service,
      message: `CloudWatch metrics were not available for this ${resource.resourceType}, so optimization confidence is limited.`,
    };
  }

  return null;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ orgId: string; accountId: string }> },
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { orgId, accountId } = await params;
  const body = await request.json().catch(() => ({}));
  const messages = Array.isArray(body.messages) ? body.messages as ChatMessage[] : [];
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : null;
  const latestMessage = messages.at(-1);

  if (!latestMessage?.content?.trim()) {
    return Response.json({ message: "Chat message is required" }, { status: 400 });
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

  const resources = await db
    .select()
    .from(cloudResources)
    .where(and(eq(cloudResources.organizationId, orgId), eq(cloudResources.cloudAccountId, accountId)))
    .orderBy(desc(cloudResources.lastSeenAt));

  const recommendations = await db
    .select()
    .from(aiRecommendations)
    .where(and(eq(aiRecommendations.organizationId, orgId), eq(aiRecommendations.status, "pending")))
    .orderBy(desc(aiRecommendations.createdAt))
    .limit(8);

  const model = createOpenRouterModel();
  if (!model) {
    return Response.json({ message: "OPENROUTER_API_KEY is not configured" }, { status: 500 });
  }

  const monthlyCost = resources.reduce((total, resource) => total + Number(resource.monthlyCost ?? 0), 0);
  const metricGaps = resources.map(metricGapForResource).filter(Boolean);

  const [existingChatSession] = sessionId
    ? await db
        .select()
        .from(chatSessions)
        .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.organizationId, orgId), eq(chatSessions.cloudAccountId, accountId)))
        .limit(1)
    : [];

  const [chatSession] = existingChatSession
    ? [existingChatSession]
    : await db
        .insert(chatSessions)
        .values({ organizationId: orgId, cloudAccountId: accountId, title: latestMessage.content.slice(0, 80) })
        .returning();

  await db.insert(chatMessages).values({
    sessionId: chatSession.id,
    role: "user",
    content: latestMessage.content,
    metadata: { accountId },
  });

  const result = await generateText({
    model,
    stopWhen: stepCountIs(3),
    tools: {
      summarizeAccount: tool({
        description: "Return the current Cloud Saver account context.",
        inputSchema: z.object({}),
        execute: async () => ({
          account: {
            name: account.accountName,
            id: account.accountIdentifier,
            status: account.status,
            lastScanAt: account.lastScanAt,
          },
          totals: {
            resourcesFound: resources.length,
            estimatedMonthlyCost: monthlyCost,
          },
          metricGaps,
          topResources: resources.slice(0, 20).map((resource) => ({
            id: resource.resourceId,
            name: resource.resourceName,
            type: resource.resourceType,
            service: resource.service,
            monthlyCost: resource.monthlyCost,
            utilization: resource.utilization,
            metadata: resource.metadata,
          })),
          recommendations: recommendations.map((recommendation) => ({
            title: recommendation.title,
            recommendation: recommendation.recommendation,
            estimatedSavings: recommendation.estimatedSavings,
            severity: recommendation.severity,
            confidence: recommendation.confidence,
          })),
        }),
      }),
    },
    system:
      "You are the Cloud Saver agent. Answer from the provided account context. Be direct and operational. If CloudWatch metrics are missing, ask the user to enable the required metric before recommending destructive or rightsizing actions.",
    prompt: messages
      .slice(-8)
      .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
      .join("\n"),
  });

  await db.insert(chatMessages).values({
    sessionId: chatSession.id,
    role: "assistant",
    content: result.text,
    metadata: { accountId },
  });

  return Response.json({ sessionId: chatSession.id, message: result.text });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ orgId: string; accountId: string }> },
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { orgId, accountId } = await params;
  const [organization] = await db
    .select()
    .from(organizations)
    .where(and(eq(organizations.id, orgId), eq(organizations.ownerId, session.user.id)))
    .limit(1);

  if (!organization) {
    return Response.json({ message: "Organization not found" }, { status: 404 });
  }

  const [chatSession] = await db
    .select()
    .from(chatSessions)
    .where(and(eq(chatSessions.organizationId, orgId), eq(chatSessions.cloudAccountId, accountId)))
    .orderBy(desc(chatSessions.createdAt))
    .limit(1);

  if (!chatSession) {
    return Response.json({ sessionId: null, messages: [] });
  }

  const messages = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, chatSession.id))
    .orderBy(chatMessages.createdAt);

  return Response.json({
    sessionId: chatSession.id,
    messages: messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  });
}
