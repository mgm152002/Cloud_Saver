import { auth } from "@/app/lib/auth";
import { cloudAccounts, jobHistory, organizations, scanJobs } from "@/db/auth-schema";
import { db } from "@/db/db";
import { and, desc, eq } from "drizzle-orm";

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

  const [historyRows, scanRows] = await Promise.all([
    db
      .select()
      .from(jobHistory)
      .where(and(eq(jobHistory.organizationId, orgId), eq(jobHistory.cloudAccountId, accountId)))
      .orderBy(desc(jobHistory.createdAt))
      .limit(100),
    db
      .select()
      .from(scanJobs)
      .where(and(eq(scanJobs.organizationId, orgId), eq(scanJobs.cloudAccountId, accountId)))
      .orderBy(desc(scanJobs.createdAt))
      .limit(100),
  ]);

  return Response.json({
    account: {
      id: account.id,
      provider: account.provider,
      accountName: account.accountName,
      accountId: account.accountIdentifier,
      status: account.status,
      lastScanAt: account.lastScanAt,
    },
    history: historyRows,
    scans: scanRows,
  });
}
