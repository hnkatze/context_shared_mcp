import * as z from "zod/v4";

const envSchema = z.object({
  CONTEXT_SHARED_DATABASE_URL: z.string().min(1),
  CONTEXT_SHARED_API_KEY: z.string().min(1),
});

export type Config = {
  readonly databaseUrl: string;
  readonly apiKey: string;
};

/**
 * Fails at startup rather than on the first tool call, so a misconfigured
 * server never presents itself to the client as healthy.
 */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Missing or invalid environment variables: ${names}`);
  }
  return {
    databaseUrl: parsed.data.CONTEXT_SHARED_DATABASE_URL,
    apiKey: parsed.data.CONTEXT_SHARED_API_KEY,
  };
}
