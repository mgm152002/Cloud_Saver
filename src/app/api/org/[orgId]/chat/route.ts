import { createOpenRouterModel } from "@/app/lib/ai";
import { auth } from "@/app/lib/auth";
import { aiRecommendations, chatMessages, chatSessions, cloudAccounts, cloudResources, organizations } from "@/db/auth-schema";
import { db } from "@/db/db";
import { generateText, stepCountIs, tool } from "ai";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { orgId } = await params;
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

  const accounts = await db.select().from(cloudAccounts).where(eq(cloudAccounts.organizationId, orgId));
  const resources = await db.select().from(cloudResources).where(eq(cloudResources.organizationId, orgId));
  const recommendations = await db
    .select()
    .from(aiRecommendations)
    .where(and(eq(aiRecommendations.organizationId, orgId), eq(aiRecommendations.status, "pending")))
    .orderBy(desc(aiRecommendations.createdAt))
    .limit(10);

  const model = createOpenRouterModel();
  if (!model) {
    return Response.json({ message: "OPENROUTER_API_KEY is not configured" }, { status: 500 });
  }

  const [existingChatSession] = sessionId
    ? await db
        .select()
        .from(chatSessions)
        .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.organizationId, orgId), isNull(chatSessions.cloudAccountId)))
        .limit(1)
    : [];

  const [chatSession] = existingChatSession
    ? [existingChatSession]
    : await db
        .insert(chatSessions)
        .values({ organizationId: orgId, title: latestMessage.content.slice(0, 80) })
        .returning();

  await db.insert(chatMessages).values({
    sessionId: chatSession.id,
    role: "user",
    content: latestMessage.content,
    metadata: { scope: "organization" },
  });

  const result = await generateText({
    model,
    stopWhen: stepCountIs(3),
    tools: {
      summarizeOrganization: tool({
        description: "Return current Cloud Saver organization context.",
        inputSchema: z.object({}),
        execute: async () => {
          const totalMonthlyCost = resources.reduce((total, resource) => total + Number(resource.monthlyCost ?? 0), 0);
          const costsByAccount = accounts.map((account) => {
            const accountResources = resources.filter((resource) => resource.cloudAccountId === account.id);
            return {
              accountName: account.accountName,
              accountId: account.accountIdentifier,
              resources: accountResources.length,
              estimatedMonthlyCost: accountResources.reduce((total, resource) => total + Number(resource.monthlyCost ?? 0), 0),
            };
          });

          return {
            organization: { name: organization.name, plan: organization.plan },
            totals: {
              accounts: accounts.length,
              resources: resources.length,
              estimatedMonthlyCost: totalMonthlyCost,
            },
            costsByAccount,
            recommendations: recommendations.map((recommendation) => ({
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
      "You are the Cloud Saver organization agent. Answer using the organization context. Compare accounts, explain cost drivers, and ask for missing CloudWatch metrics when needed before suggesting destructive or rightsizing actions.",
    prompt: messages
      .slice(-8)
      .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
      .join("\n"),
  });

  await db.insert(chatMessages).values({
    sessionId: chatSession.id,
    role: "assistant",
    content: result.text,
    metadata: { scope: "organization" },
  });

  return Response.json({ sessionId: chatSession.id, message: result.text });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { orgId } = await params;
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
    .where(and(eq(chatSessions.organizationId, orgId), isNull(chatSessions.cloudAccountId)))
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
