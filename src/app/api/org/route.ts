import { auth } from '@/app/lib/auth'
import { cloudAccounts, cloudResources, organizations } from '@/db/auth-schema';
import { db } from '@/db/db'
import crypto from "crypto";
import { eq, inArray } from "drizzle-orm";

export async function POST(request: Request) {
   const session = await auth.api.getSession({
        headers: request.headers
    });
     if (!session) {
        return new Response("Unauthorized", { status: 401 });
    }
    const body = await request.json();
    const { name } = body;
    const plan = "free"; // Default plan for new orgs
    const ownerId = session.user.id; // Assuming session contains user info
    const newOrg = { id: crypto.randomUUID(), name, plan, ownerId };
    await db.insert(organizations).values(newOrg);
    return new Response(JSON.stringify(newOrg), {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
    });

}
export async function GET(request: Request) {
    const session = await auth.api.getSession({
        headers: request.headers
    });
     if (!session) {
        return new Response("Unauthorized", { status: 401 });
    }
    const userId = session.user.id;
    const orgs = await db.select().from(organizations).where(eq(organizations.ownerId, userId));
    const orgIds = orgs.map((org) => org.id);

    if (orgIds.length === 0) {
        return Response.json([]);
    }

    const accounts = await db
        .select({
            id: cloudAccounts.id,
            organizationId: cloudAccounts.organizationId,
        })
        .from(cloudAccounts)
        .where(inArray(cloudAccounts.organizationId, orgIds));

    const resources = await db
        .select({
            organizationId: cloudResources.organizationId,
            service: cloudResources.service,
            monthlyCost: cloudResources.monthlyCost,
        })
        .from(cloudResources)
        .where(inArray(cloudResources.organizationId, orgIds));

    const enrichedOrgs = orgs.map((org) => {
        const orgResources = resources.filter((resource) => resource.organizationId === org.id);
        const costByService = new Map<string, number>();
        for (const resource of orgResources) {
            const service = resource.service || "other";
            costByService.set(service, (costByService.get(service) ?? 0) + Number(resource.monthlyCost ?? 0));
        }

        return {
            ...org,
            accountCount: accounts.filter((account) => account.organizationId === org.id).length,
            resourceCount: orgResources.length,
            estimatedMonthlyCost: orgResources.reduce((total, resource) => total + Number(resource.monthlyCost ?? 0), 0),
            costByService: [...costByService.entries()]
                .map(([service, cost]) => ({ service, cost }))
                .sort((left, right) => right.cost - left.cost),
        };
    });

    return new Response(JSON.stringify(enrichedOrgs), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
    });
}
