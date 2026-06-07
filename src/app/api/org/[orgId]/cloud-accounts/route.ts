import { auth } from "@/app/lib/auth";
import { cloudAccounts, organizations, scanJobs } from "@/db/auth-schema";
import { db } from "@/db/db";
import { and, desc, eq } from "drizzle-orm";

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

  const accounts = await db
    .select()
    .from(cloudAccounts)
    .where(eq(cloudAccounts.organizationId, orgId))
    .orderBy(desc(cloudAccounts.createdAt));

  const latestScanJobs = await db
    .select()
    .from(scanJobs)
    .where(eq(scanJobs.organizationId, orgId))
    .orderBy(desc(scanJobs.createdAt));

  return Response.json(
    accounts.map((account) => ({
      id: account.id,
      provider: account.provider,
      accountName: account.accountName,
      accountId: account.accountIdentifier,
      region: "ap-south-1",
      status: account.status,
      createdAt: account.createdAt,
      lastScanAt: account.lastScanAt,
      latestScanJob: latestScanJobs.find((job) => job.cloudAccountId === account.id) ?? null,
    })),
  );
}
