import { createOpenRouterModel } from "@/app/lib/ai";
import { auth } from "@/app/lib/auth";
import { aiRecommendations, chatMessages, chatSessions, cloudAccounts, cloudResources, organizations } from "@/db/auth-schema";
import { db } from "@/db/db";
import { generateText, stepCountIs, tool } from "ai";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

async function getUserCloudContext(userId: string) {
  const orgs = await db.select().from(organizations).where(eq(organizations.ownerId, userId));
  const orgIds = orgs.map((org) => org.id);
  if (orgIds.length === 0) {
    return { orgs, accounts: [], resources: [], recommendations: [] };
  }

  const accounts = await db.select().from(cloudAccounts).where(inArray(cloudAccounts.organizationId, orgIds));
  const resources = await db.select().from(cloudResources).where(inArray(cloudResources.organizationId, orgIds));
  const recommendations = await db
    .select()
    .from(aiRecommendations)
    .where(and(inArray(aiRecommendations.organizationId, orgIds), eq(aiRecommendations.status, "pending")))
    .orderBy(desc(aiRecommendations.createdAt))
    .limit(12);

  return { orgs, accounts, resources, recommendations };
}

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const [chatSession] = await db
    .select()
    .from(chatSessions)
    .where(and(eq(chatSessions.userId, session.user.id), isNull(chatSessions.organizationId), isNull(chatSessions.cloudAccountId)))
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

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const messages = Array.isArray(body.messages) ? body.messages as ChatMessage[] : [];
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : null;
  const latestMessage = messages.at(-1);

  if (!latestMessage?.content?.trim()) {
    return Response.json({ message: "Chat message is required" }, { status: 400 });
  }

  const model = createOpenRouterModel();
  if (!model) {
    return Response.json({ message: "OPENROUTER_API_KEY is not configured" }, { status: 500 });
  }

  const context = await getUserCloudContext(session.user.id);

  const [existingChatSession] = sessionId
    ? await db
        .select()
        .from(chatSessions)
        .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, session.user.id), isNull(chatSessions.organizationId), isNull(chatSessions.cloudAccountId)))
        .limit(1)
    : [];

  const [chatSession] = existingChatSession
    ? [existingChatSession]
    : await db
        .insert(chatSessions)
        .values({ userId: session.user.id, title: "Global Cloud Saver chat" })
        .returning();

  await db.insert(chatMessages).values({
    sessionId: chatSession.id,
    role: "user",
    content: latestMessage.content,
    metadata: { scope: "global" },
  });

  const result = await generateText({
    model,
    stopWhen: stepCountIs(3),
    tools: {
      summarizeCloudEstate: tool({
        description: "Return the user's Cloud Saver estate across all organizations and accounts.",
        inputSchema: z.object({}),
        execute: async () => {
          const totalMonthlyCost = context.resources.reduce((total, resource) => total + Number(resource.monthlyCost ?? 0), 0);
          const orgSummaries = context.orgs.map((org) => {
            const orgAccounts = context.accounts.filter((account) => account.organizationId === org.id);
            const orgResources = context.resources.filter((resource) => resource.organizationId === org.id);
            return {
              orgId: org.id,
              name: org.name,
              accounts: orgAccounts.length,
              resources: orgResources.length,
              estimatedMonthlyCost: orgResources.reduce((total, resource) => total + Number(resource.monthlyCost ?? 0), 0),
            };
          });

          return {
            totals: {
              organizations: context.orgs.length,
              accounts: context.accounts.length,
              resources: context.resources.length,
              estimatedMonthlyCost: totalMonthlyCost,
            },
            organizations: orgSummaries,
            topResources: [...context.resources]
              .sort((left, right) => Number(right.monthlyCost ?? 0) - Number(left.monthlyCost ?? 0))
              .slice(0, 15)
              .map((resource) => ({
                id: resource.resourceId,
                name: resource.resourceName,
                type: resource.resourceType,
                service: resource.service,
                monthlyCost: resource.monthlyCost,
                utilization: resource.utilization,
                metadata: resource.metadata,
              })),
            recommendations: context.recommendations.map((recommendation) => ({
              title: recommendation.title,
              recommendation: recommendation.recommendation,
              estimatedSavings: recommendation.estimatedSavings,
              severity: recommendation.severity,
              confidence: recommendation.confidence,
            })),
          };
        },
      }),
    },
    system:
      "You are the global Cloud Saver assistant. Help the user across all organizations and cloud accounts. Be concise, operational, and user-friendly. Use CloudWatch evidence when discussing optimization actions; if metrics are missing, ask the user to enable or verify them before recommending destructive or rightsizing actions.",
    prompt: messages
      .slice(-10)
      .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
      .join("\n"),
  });

  await db.insert(chatMessages).values({
    sessionId: chatSession.id,
    role: "assistant",
    content: result.text,
    metadata: { scope: "global" },
  });

  return Response.json({ sessionId: chatSession.id, message: result.text });
}
