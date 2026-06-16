import { auth } from "@/app/lib/auth";
import { aiRemediations, cloudAccounts, organizations } from "@/db/auth-schema";
import { db } from "@/db/db";
import { and, eq } from "drizzle-orm";

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

  const [plan] = await db
    .update(aiRemediations)
    .set({
      status: "completed",
      executedAt: new Date(),
    })
    .where(and(eq(aiRemediations.id, planId), eq(aiRemediations.organizationId, orgId)))
    .returning();

  if (!plan) {
    return Response.json({ message: "Action plan not found" }, { status: 404 });
  }

  return Response.json({ plan });
}
