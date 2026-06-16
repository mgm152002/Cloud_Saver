import { auth } from "@/app/lib/auth";
import { cloudAccounts, cloudResources, organizations } from "@/db/auth-schema";
import { db } from "@/db/db";
import { and, eq } from "drizzle-orm";

type TagsBody = {
  tags?: Record<string, unknown>;
};

function normalizeTags(tags: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(tags)
      .map(([key, value]) => [key.trim(), String(value).trim()])
      .filter(([key, value]) => key.length > 0 && value.length > 0),
  );
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ orgId: string; accountId: string; resourceId: string }> },
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { orgId, accountId, resourceId } = await params;
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

  const body = (await request.json()) as TagsBody;
  if (!body.tags || typeof body.tags !== "object" || Array.isArray(body.tags)) {
    return Response.json({ message: "tags must be a JSON object" }, { status: 400 });
  }

  const tags = normalizeTags(body.tags);
  const [resource] = await db
    .update(cloudResources)
    .set({ tags })
    .where(
      and(
        eq(cloudResources.id, resourceId),
        eq(cloudResources.organizationId, orgId),
        eq(cloudResources.cloudAccountId, accountId),
      ),
    )
    .returning();

  if (!resource) {
    return Response.json({ message: "Resource not found" }, { status: 404 });
  }

  return Response.json({ resource });
}
