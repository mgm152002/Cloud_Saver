import { auth } from "@/app/lib/auth";
import {
  aiRecommendations,
  aiRemediations,
  alerts,
  cloudAccounts,
  cloudResources,
  organizations,
  resourceCostHistory,
  scanJobs,
} from "@/db/auth-schema";
import { db } from "@/db/db";
import { and, desc, eq, inArray } from "drizzle-orm";

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

  const [account] = await db
    .select()
    .from(cloudAccounts)
    .where(and(eq(cloudAccounts.id, accountId), eq(cloudAccounts.organizationId, orgId)))
    .limit(1);

  if (!account) {
    return Response.json({ message: "Cloud account not found" }, { status: 404 });
  }

  const [latestScanJob] = await db
    .select()
    .from(scanJobs)
    .where(and(eq(scanJobs.cloudAccountId, accountId), eq(scanJobs.organizationId, orgId)))
    .orderBy(desc(scanJobs.createdAt))
    .limit(1);

  const resources = await db
    .select()
    .from(cloudResources)
    .where(and(eq(cloudResources.cloudAccountId, accountId), eq(cloudResources.organizationId, orgId)))
    .orderBy(desc(cloudResources.lastSeenAt));

  const recommendations = await db
    .select()
    .from(aiRecommendations)
    .where(and(eq(aiRecommendations.organizationId, orgId), eq(aiRecommendations.status, "pending")))
    .orderBy(desc(aiRecommendations.createdAt));

  return Response.json({
    account: {
      id: account.id,
      provider: account.provider,
      accountName: account.accountName,
      accountId: account.accountIdentifier,
      region: "ap-south-1",
      status: account.status,
      createdAt: account.createdAt,
      lastScanAt: account.lastScanAt,
      latestScanJob: latestScanJob ?? null,
    },
    resources,
    recommendations,
  });
}

export async function DELETE(
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

  const [account] = await db
    .select()
    .from(cloudAccounts)
    .where(and(eq(cloudAccounts.id, accountId), eq(cloudAccounts.organizationId, orgId)))
    .limit(1);

  if (!account) {
    return Response.json({ message: "Cloud account not found" }, { status: 404 });
  }

  const resources = await db
    .select({ id: cloudResources.id })
    .from(cloudResources)
    .where(and(eq(cloudResources.cloudAccountId, accountId), eq(cloudResources.organizationId, orgId)));

  const resourceIds = resources.map((resource) => resource.id);

  if (resourceIds.length > 0) {
    const recommendations = await db
      .select({ id: aiRecommendations.id })
      .from(aiRecommendations)
      .where(inArray(aiRecommendations.resourceId, resourceIds));
    const recommendationIds = recommendations.map((recommendation) => recommendation.id);

    if (recommendationIds.length > 0) {
      await db.delete(aiRemediations).where(inArray(aiRemediations.recommendationId, recommendationIds));
      await db.delete(aiRecommendations).where(inArray(aiRecommendations.id, recommendationIds));
    }

    await db.delete(alerts).where(inArray(alerts.resourceId, resourceIds));
    await db.delete(resourceCostHistory).where(inArray(resourceCostHistory.resourceId, resourceIds));
    await db.delete(cloudResources).where(inArray(cloudResources.id, resourceIds));
  }

  await db.delete(scanJobs).where(and(eq(scanJobs.cloudAccountId, accountId), eq(scanJobs.organizationId, orgId)));
  await db.delete(cloudAccounts).where(eq(cloudAccounts.id, accountId));

  return Response.json({ deleted: true, accountId });
}
