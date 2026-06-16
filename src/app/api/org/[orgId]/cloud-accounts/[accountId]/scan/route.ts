import { auth } from "@/app/lib/auth";
import { type AwsCredentialsMetadata } from "@/app/lib/aws-onboarding";
import { cloudAccounts, jobHistory, organizations } from "@/db/auth-schema";
import { db } from "@/db/db";
import { tasks } from "@trigger.dev/sdk/v3";
import { and, eq } from "drizzle-orm";
import type { awsInitialScan } from "../../../../../../../../trigger/aws-initial-scan";

export async function POST(
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

  const credentials = account.credentials as AwsCredentialsMetadata | null;
  if (!credentials?.roleArn || !credentials.externalId) {
    return Response.json(
      { message: "This cloud account is missing Role ARN or External ID. Reconnect the account first." },
      { status: 400 },
    );
  }

  const triggerHandle = await tasks.trigger<typeof awsInitialScan>("aws-initial-scan", {
    organizationId: orgId,
    cloudAccountId: accountId,
    roleArn: credentials.roleArn,
    externalId: credentials.externalId,
    region: "ap-south-1",
  });

  await db.insert(jobHistory).values({
    organizationId: orgId,
    cloudAccountId: accountId,
    triggerRunId: triggerHandle.id,
    taskIdentifier: "aws-initial-scan",
    jobType: "aws_inventory_scan",
    status: "queued",
    message: "AWS inventory scan queued in Trigger.dev.",
    metadata: {
      provider: account.provider,
      accountIdentifier: account.accountIdentifier,
    },
  });

  await db
    .update(cloudAccounts)
    .set({
      status: "scan_queued",
      credentials: {
        ...credentials,
        triggerRunId: triggerHandle.id,
      },
    })
    .where(eq(cloudAccounts.id, accountId));

  return Response.json({ queued: true, triggerRun: triggerHandle });
}
