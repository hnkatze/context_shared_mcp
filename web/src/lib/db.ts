import pg from "pg";
import type { PoolClient } from "pg";

function readEnv(name: string): string {
  const fromProcess = process.env[name];
  const fromVite = (import.meta.env as Record<string, string | undefined>)[name];
  const value = fromProcess ?? fromVite;
  if (value === undefined || value === "") {
    throw new Error(`Missing environment variable ${name}`);
  }
  return value;
}

/**
 * One connection per function instance. Vercel runs many isolated instances and
 * a larger pool per instance exhausts Postgres; CONTEXT_SHARED_DATABASE_URL must
 * point at a transaction-mode pooler, never at the direct connection.
 */
const pool = new pg.Pool({
  connectionString: readEnv("CONTEXT_SHARED_DATABASE_URL"),
  max: 1,
});

export async function resolveOrgId(token: string): Promise<string | null> {
  const result = await pool.query<{ org_id: string | null }>(
    "select app.resolve_api_key($1) as org_id",
    [token],
  );
  return result.rows[0]?.org_id ?? null;
}

/**
 * set_config's third argument scopes the value to this transaction, which is
 * also what makes it safe under transaction-mode pooling: a session-scoped
 * setting would leak one tenant's id onto the next request sharing the backend.
 */
export async function withTenant<TResult>(
  orgId: string,
  run: (client: PoolClient) => Promise<TResult>,
): Promise<TResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.current_org_id', $1, true)", [orgId]);
    const result = await run(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function currentOrgId(): Promise<string> {
  const orgId = await resolveOrgId(readEnv("CONTEXT_SHARED_API_KEY"));
  if (orgId === null) {
    throw new Error("CONTEXT_SHARED_API_KEY is not a valid or active key");
  }
  return orgId;
}
