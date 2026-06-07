import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./auth-schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Add it to your .env.local file.");
}

export const db = drizzle(process.env.DATABASE_URL, { schema });
