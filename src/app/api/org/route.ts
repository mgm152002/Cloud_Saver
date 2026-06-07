import { auth } from '@/app/lib/auth'
import { organizations } from '@/db/auth-schema';
import { db } from '@/db/db'
import crypto from "crypto";
import { eq } from "drizzle-orm";

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
    const orgs = await db

  .select()

  .from(organizations)

  .where(eq(organizations.ownerId, userId));
    return new Response(JSON.stringify(orgs), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
    });
}