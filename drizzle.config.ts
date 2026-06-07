import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Add it to your .env.local file.");
}

export default defineConfig({
  out: './drizzle',
  schema: './src/db/auth-schema.ts',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
