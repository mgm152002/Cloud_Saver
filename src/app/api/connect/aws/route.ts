import { auth } from "@/app/lib/auth";
import {
  buildCloudFormationLaunchUrl,
  CLOUDSAVER_TEMPLATE_URL,
  generateExternalId,
  parseAwsAccountId,
  validateAssumeRole,
  type AwsCredentialsMetadata,
} from "@/app/lib/aws-onboarding";
import { cloudAccounts, organizations } from "@/db/auth-schema";
import { db } from "@/db/db";
import { tasks } from "@trigger.dev/sdk/v3";
import { and, desc, eq } from "drizzle-orm";
import type { awsInitialScan } from "../../../../../trigger/aws-initial-scan";

type ConnectAwsBody = {
  orgId?: string;
  onboardingId?: string;
  roleArn?: string;
};

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

async function getOwnedOrganization(orgId: string, ownerId: string) {
  const [organization] = await db
    .select()
    .from(organizations)
    .where(and(eq(organizations.id, orgId), eq(organizations.ownerId, ownerId)))
    .limit(1);

  return organization;
}

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = (await request.json()) as ConnectAwsBody;

  if (!body.orgId) {
    return json({ message: "orgId is required" }, 400);
  }

  const organization = await getOwnedOrganization(body.orgId, session.user.id);
  if (!organization) {
    return json({ message: "Organization not found" }, 404);
  }

  if (!body.roleArn) {
    const externalId = generateExternalId();
    const credentials: AwsCredentialsMetadata = {
      externalId,
      templateUrl: CLOUDSAVER_TEMPLATE_URL,
    };

    const [pendingAccount] = await db
      .insert(cloudAccounts)
      .values({
        organizationId: body.orgId,
        provider: "aws",
        accountName: "AWS account pending connection",
        accountIdentifier: externalId,
        status: "pending_role",
        credentials,
      })
      .returning();

    return json(
      {
        step: "launch-cloudformation",
        onboardingId: pendingAccount.id,
        externalId,
        templateUrl: CLOUDSAVER_TEMPLATE_URL,
        cloudFormationUrl: buildCloudFormationLaunchUrl(externalId),
      },
      201,
    );
  }

  const roleArn = body.roleArn.trim();
  const accountId = parseAwsAccountId(roleArn);

  if (!accountId) {
    return json({ message: "Invalid AWS Role ARN" }, 400);
  }

  const pendingAccount = body.onboardingId
    ? (
        await db
          .select()
          .from(cloudAccounts)
          .where(
            and(
              eq(cloudAccounts.id, body.onboardingId),
              eq(cloudAccounts.organizationId, body.orgId),
              eq(cloudAccounts.provider, "aws"),
            ),
          )
          .limit(1)
      )[0]
    : (
        await db
          .select()
          .from(cloudAccounts)
          .where(
            and(
              eq(cloudAccounts.organizationId, body.orgId),
              eq(cloudAccounts.provider, "aws"),
              eq(cloudAccounts.status, "pending_role"),
            ),
          )
          .orderBy(desc(cloudAccounts.createdAt))
          .limit(1)
      )[0];

  if (!pendingAccount) {
    return json({ message: "Start AWS onboarding before validating a Role ARN." }, 400);
  }

  const existingCredentials = pendingAccount.credentials as AwsCredentialsMetadata | null;
  const externalId = existingCredentials?.externalId;

  if (!externalId) {
    return json({ message: "Missing External ID for this onboarding session." }, 400);
  }

  try {
    await validateAssumeRole(roleArn, externalId);

    const triggerHandle = await tasks.trigger<typeof awsInitialScan>("aws-initial-scan", {
      organizationId: body.orgId,
      cloudAccountId: pendingAccount.id,
      roleArn,
      externalId,
      region: "ap-south-1",
    });

    const credentials: AwsCredentialsMetadata = {
      ...existingCredentials,
      externalId,
      roleArn,
      templateUrl: existingCredentials?.templateUrl ?? CLOUDSAVER_TEMPLATE_URL,
      triggerRunId: triggerHandle.id,
      validatedAt: new Date().toISOString(),
    };

    const [connectedAccount] = await db
      .update(cloudAccounts)
      .set({
        accountName: `AWS ${accountId}`,
        accountIdentifier: accountId,
        status: "scan_queued",
        credentials,
      })
      .where(eq(cloudAccounts.id, pendingAccount.id))
      .returning();

    return json({
      step: "scan-queued",
      cloudAccount: connectedAccount,
      triggerRun: triggerHandle,
    });
  } catch (error) {
    await db
      .update(cloudAccounts)
      .set({ status: "validation_failed" })
      .where(eq(cloudAccounts.id, pendingAccount.id));

    return json(
      {
        message: error instanceof Error ? error.message : "Unable to assume this AWS role",
      },
      400,
    );
  }
}
