import { auth } from "@/app/lib/auth";
import { sendUsageAlertEmail } from "@/app/lib/email-alerts";
import { alerts, cloudAccounts, cloudResources, organizations, usagePolicies } from "@/db/auth-schema";
import { db } from "@/db/db";
import { and, eq } from "drizzle-orm";

function toNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function getAuthorizedAccount(headers: Headers, orgId: string, accountId: string) {
  const session = await auth.api.getSession({ headers });
  if (!session) return { error: new Response("Unauthorized", { status: 401 }) };

  const [organization] = await db
    .select()
    .from(organizations)
    .where(and(eq(organizations.id, orgId), eq(organizations.ownerId, session.user.id)))
    .limit(1);

  if (!organization) return { error: Response.json({ message: "Organization not found" }, { status: 404 }) };

  const [account] = await db
    .select()
    .from(cloudAccounts)
    .where(and(eq(cloudAccounts.id, accountId), eq(cloudAccounts.organizationId, orgId)))
    .limit(1);

  if (!account) return { error: Response.json({ message: "Cloud account not found" }, { status: 404 }) };

  return { account, userEmail: session.user.email };
}

async function getCurrentMonthlyCost(orgId: string, accountId: string) {
  const resources = await db
    .select({ monthlyCost: cloudResources.monthlyCost })
    .from(cloudResources)
    .where(and(eq(cloudResources.organizationId, orgId), eq(cloudResources.cloudAccountId, accountId)));

  return resources.reduce((total, resource) => total + toNumber(resource.monthlyCost), 0);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ orgId: string; accountId: string }> },
) {
  const { orgId, accountId } = await params;
  const authorized = await getAuthorizedAccount(request.headers, orgId, accountId);
  if (authorized.error) return authorized.error;

  const [policy] = await db
    .select()
    .from(usagePolicies)
    .where(and(eq(usagePolicies.organizationId, orgId), eq(usagePolicies.cloudAccountId, accountId)))
    .limit(1);

  const currentMonthlyCost = await getCurrentMonthlyCost(orgId, accountId);
  const monthlyLimit = toNumber(policy?.monthlyLimit);
  const thresholdPercent = policy?.alertThresholdPercent ?? 80;
  const thresholdAmount = monthlyLimit * (thresholdPercent / 100);

  return Response.json({
    policy: policy ?? null,
    currentMonthlyCost,
    thresholdAmount,
    overThreshold: Boolean(policy?.enabled && monthlyLimit > 0 && currentMonthlyCost >= thresholdAmount),
  });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ orgId: string; accountId: string }> },
) {
  const { orgId, accountId } = await params;
  const authorized = await getAuthorizedAccount(request.headers, orgId, accountId);
  if (authorized.error) return authorized.error;

  const body = await request.json().catch(() => ({}));
  const monthlyLimit = toNumber(body.monthlyLimit);
  const alertThresholdPercent = Math.min(100, Math.max(1, Math.round(toNumber(body.alertThresholdPercent, 80))));
  const alertEmail = typeof body.alertEmail === "string" && body.alertEmail.trim() ? body.alertEmail.trim() : authorized.userEmail;
  const enabled = body.enabled !== false;

  if (monthlyLimit <= 0) {
    return Response.json({ message: "Monthly limit must be greater than 0" }, { status: 400 });
  }

  const [existingPolicy] = await db
    .select()
    .from(usagePolicies)
    .where(and(eq(usagePolicies.organizationId, orgId), eq(usagePolicies.cloudAccountId, accountId)))
    .limit(1);

  const values = {
    organizationId: orgId,
    cloudAccountId: accountId,
    monthlyLimit: String(monthlyLimit),
    alertThresholdPercent,
    alertEmail,
    enabled,
    updatedAt: new Date(),
  };

  const [policy] = existingPolicy
    ? await db.update(usagePolicies).set(values).where(eq(usagePolicies.id, existingPolicy.id)).returning()
    : await db.insert(usagePolicies).values(values).returning();

  const currentMonthlyCost = await getCurrentMonthlyCost(orgId, accountId);
  const thresholdAmount = monthlyLimit * (alertThresholdPercent / 100);
  let emailSent = false;
  let emailError: string | null = null;

  if (enabled && alertEmail && currentMonthlyCost >= thresholdAmount) {
    await db.insert(alerts).values({
      organizationId: orgId,
      title: "Usage limit threshold crossed",
      description: `${authorized.account.accountName} is projected at $${currentMonthlyCost.toFixed(2)} against a $${monthlyLimit.toFixed(2)} monthly limit.`,
      severity: currentMonthlyCost >= monthlyLimit ? "high" : "medium",
      status: "open",
    });

    try {
      await sendUsageAlertEmail({
        to: alertEmail,
        accountName: authorized.account.accountName,
        monthlyCost: currentMonthlyCost,
        monthlyLimit,
        thresholdPercent: alertThresholdPercent,
      });
      emailSent = true;
      await db.update(usagePolicies).set({ lastAlertSentAt: new Date() }).where(eq(usagePolicies.id, policy.id));
    } catch (error) {
      emailError = error instanceof Error ? error.message : "Failed to send SES email";
    }
  }

  return Response.json({
    policy,
    currentMonthlyCost,
    thresholdAmount,
    overThreshold: enabled && currentMonthlyCost >= thresholdAmount,
    emailSent,
    emailError,
  });
}
