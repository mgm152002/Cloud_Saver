import { auth } from "@/app/lib/auth";
import { aiRemediations, cloudAccounts, jobHistory, organizations } from "@/db/auth-schema";
import { db } from "@/db/db";
import { tasks } from "@trigger.dev/sdk/v3";
import { and, eq } from "drizzle-orm";
import type { awsRemediation } from "../../../../../../../../../../trigger/aws-remediation";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ orgId: string; accountId: string; planId: string }> },
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { orgId, accountId, planId } = await params;
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

  const [existingPlan] = await db
    .select()
    .from(aiRemediations)
    .where(and(eq(aiRemediations.id, planId), eq(aiRemediations.organizationId, orgId)))
    .limit(1);

  if (!existingPlan) {
    return Response.json({ message: "Action plan not found" }, { status: 404 });
  }

  if (!existingPlan.actionType) {
    return Response.json({ message: "Action plan is missing an action type" }, { status: 400 });
  }

  const triggerHandle = await tasks.trigger<typeof awsRemediation>("aws-remediation", {
    organizationId: orgId,
    cloudAccountId: accountId,
    remediationId: planId,
    requestedByUserId: session.user.id,
  });

  const [plan] = await db
    .update(aiRemediations)
    .set({
      status: "queued",
      approvedByUser: true,
      executionLogs: [
        {
          at: new Date().toISOString(),
          message: "AWS remediation queued in Trigger.dev.",
          triggerRunId: triggerHandle.id,
        },
      ],
    })
    .where(eq(aiRemediations.id, planId))
    .returning();

  await db.insert(jobHistory).values({
    organizationId: orgId,
    cloudAccountId: accountId,
    triggerRunId: triggerHandle.id,
    taskIdentifier: "aws-remediation",
    jobType: "aws_remediation",
    status: "queued",
    message: `AWS remediation queued for ${existingPlan.actionType}.`,
    metadata: {
      remediationId: planId,
      actionType: existingPlan.actionType,
      accountIdentifier: account.accountIdentifier,
    },
  });

  return Response.json({ plan, triggerRun: triggerHandle });
}
