import { createOpenAI } from "@ai-sdk/openai";

export function createOpenRouterModel() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  const openrouter = createOpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    headers: {
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://localhost:3000",
      "X-Title": process.env.OPENROUTER_APP_NAME ?? "Cloud Saver",
    },
  });

  return openrouter.chat(process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini");
}
