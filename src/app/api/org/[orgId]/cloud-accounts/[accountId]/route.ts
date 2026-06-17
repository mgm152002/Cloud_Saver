import { auth } from "@/app/lib/auth";
import { getS3MetricState } from "@/app/lib/s3-metrics";
import {
  aiRecommendations,
  aiRemediations,
  alerts,
  cloudAccounts,
  cloudResources,
  jobHistory,
  organizations,
  resourceCostHistory,
  scanJobs,
  usagePolicies,
} from "@/db/auth-schema";
import { db } from "@/db/db";
import { and, desc, eq, inArray } from "drizzle-orm";

function shouldShowRecommendation(
  recommendation: { title: string | null; recommendation: string },
  resources: { resourceId: string; resourceName: string | null; resourceType: string; metadata: unknown }[],
) {
  const text = `${recommendation.title ?? ""} ${recommendation.recommendation}`.toLowerCase();
  const mentionedResource = resources.find((candidate) =>
    text.includes(candidate.resourceId.toLowerCase()) || Boolean(candidate.resourceName && text.includes(candidate.resourceName.toLowerCase())),
  );
  const mentionedS3Resource = mentionedResource?.resourceType === "s3-bucket" ? mentionedResource : undefined;
  const isS3ActivityRecommendation =
    /\bs3\b|\bbucket\b/.test(text) &&
    /\b(delete|remove|terminate|archive|idle|inactive|unused|decommission|tier|storage class|lifecycle|expire)\b/.test(text);

  if (isS3ActivityRecommendation) {
    if (!mentionedS3Resource) return false;
    const metrics = getS3MetricState(mentionedS3Resource?.metadata as Record<string, unknown> | null);
    return metrics.requestMetricsAvailable === true && metrics.hasRecentRequests === false;
  }

  if (!/\b(delete|remove|terminate)\b/.test(text) || !/\bs3\b|\bbucket\b/.test(text)) {
    const ec2Resource = mentionedResource?.resourceType === "ec2-instance" ? mentionedResource : undefined;
    const isEc2Optimization = Boolean(ec2Resource) && /\b(rightsize|resize|downsize|stop|terminate|delete|schedule|reserved|savings plan)\b/.test(text);
    if (isEc2Optimization) {
      const metadata = ec2Resource?.metadata as {
        cloudWatchMetrics?: { enabled?: boolean; cpu?: { datapoints?: number; average?: number; maximum?: number } };
        cpu?: { datapoints?: number; average?: number; maximum?: number };
      } | null;
      const cpu = metadata?.cloudWatchMetrics?.cpu ?? metadata?.cpu;
      const hasMetrics =
        (metadata?.cloudWatchMetrics?.enabled === true && Boolean(metadata.cloudWatchMetrics.cpu?.datapoints)) ||
        Boolean(metadata?.cpu?.datapoints);
      return hasMetrics && Number(cpu?.average ?? 100) < 8 && Number(cpu?.maximum ?? 100) < 25;
    }

    if (mentionedResource?.resourceType === "ec2-volume" && /\b(idle|delete|remove|detach)\b/.test(text)) {
      const metadata = mentionedResource.metadata as {
        attachments?: number;
        cloudWatchMetrics?: { enabled?: boolean; readOps?: { sum?: number }; writeOps?: { sum?: number } };
      } | null;
      if (Number(metadata?.attachments ?? 0) === 0) return true;
      const totalOps = Number(metadata?.cloudWatchMetrics?.readOps?.sum ?? 0) + Number(metadata?.cloudWatchMetrics?.writeOps?.sum ?? 0);
      return metadata?.cloudWatchMetrics?.enabled === true && totalOps === 0;
    }

    if (mentionedResource?.resourceType === "rds-instance" && /\b(rightsize|resize|downsize|stop|delete|remove)\b/.test(text)) {
      const metadata = mentionedResource.metadata as {
        cloudWatchMetrics?: {
          enabled?: boolean;
          cpu?: { average?: number; maximum?: number };
          databaseConnections?: { average?: number };
        };
      } | null;
      return (
        metadata?.cloudWatchMetrics?.enabled === true &&
        Number(metadata.cloudWatchMetrics.cpu?.average ?? 100) < 10 &&
        Number(metadata.cloudWatchMetrics.cpu?.maximum ?? 100) < 35 &&
        Number(metadata.cloudWatchMetrics.databaseConnections?.average ?? 100) < 1
      );
    }

    if (mentionedResource?.resourceType === "load-balancer" && /\b(delete|remove|consolidate)\b/.test(text)) {
      const metadata = mentionedResource.metadata as { cloudWatchMetrics?: { enabled?: boolean; requestCount?: { sum?: number } } } | null;
      return metadata?.cloudWatchMetrics?.enabled === true && Number(metadata.cloudWatchMetrics.requestCount?.sum ?? 1) === 0;
    }

    if (mentionedResource?.resourceType === "lambda-function" && /\b(delete|remove|decommission|reduce)\b/.test(text)) {
      const metadata = mentionedResource.metadata as { cloudWatchMetrics?: { enabled?: boolean; invocations?: { sum?: number } } } | null;
      return metadata?.cloudWatchMetrics?.enabled === true && Number(metadata.cloudWatchMetrics.invocations?.sum ?? 1) === 0;
    }

    return true;
  }

  const resource = mentionedS3Resource;

  if (!resource) return false;

  const metadata = resource.metadata as Record<string, unknown> | null;
  const s3Metrics = getS3MetricState(metadata);
  return s3Metrics.requestMetricsAvailable === true && s3Metrics.hasRecentRequests === false;
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

  const allRecommendations = await db
    .select()
    .from(aiRecommendations)
    .where(and(eq(aiRecommendations.organizationId, orgId), eq(aiRecommendations.status, "pending")))
    .orderBy(desc(aiRecommendations.createdAt));
  const recommendations = allRecommendations.filter((recommendation) => shouldShowRecommendation(recommendation, resources));

  const [usagePolicy] = await db
    .select()
    .from(usagePolicies)
    .where(and(eq(usagePolicies.organizationId, orgId), eq(usagePolicies.cloudAccountId, accountId)))
    .limit(1);

  const recentAlerts = await db
    .select()
    .from(alerts)
    .where(and(eq(alerts.organizationId, orgId), eq(alerts.status, "open")))
    .orderBy(desc(alerts.createdAt))
    .limit(5);

  const actionPlans = await db
    .select()
    .from(aiRemediations)
    .where(and(eq(aiRemediations.organizationId, orgId), eq(aiRemediations.status, "approved")))
    .orderBy(desc(aiRemediations.createdAt))
    .limit(5);

  const estimatedMonthlyCost = resources.reduce((total, resource) => total + Number(resource.monthlyCost ?? 0), 0);
  const estimatedSavings = Math.min(
    estimatedMonthlyCost,
    recommendations.reduce((total, recommendation) => total + Number(recommendation.estimatedSavings ?? 0), 0),
  );

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
    actionPlans,
    usagePolicy: usagePolicy ?? null,
    alerts: recentAlerts,
    totals: {
      estimatedMonthlyCost,
      estimatedSavings,
    },
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

  await db.delete(usagePolicies).where(and(eq(usagePolicies.cloudAccountId, accountId), eq(usagePolicies.organizationId, orgId)));
  await db.delete(jobHistory).where(and(eq(jobHistory.cloudAccountId, accountId), eq(jobHistory.organizationId, orgId)));
  await db.delete(scanJobs).where(and(eq(scanJobs.cloudAccountId, accountId), eq(scanJobs.organizationId, orgId)));
  await db.delete(cloudAccounts).where(eq(cloudAccounts.id, accountId));

  return Response.json({ deleted: true, accountId });
}
