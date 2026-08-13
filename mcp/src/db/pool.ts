import pg from "pg";
import type { PoolClient } from "pg";

export type Db = pg.Pool;

export function createPool(databaseUrl: string): Db {
  return new pg.Pool({ connectionString: databaseUrl, max: 4 });
}

/**
 * Runs before any tenant is known, which is why resolve_api_key is SECURITY
 * DEFINER on the database side. Returns null for unknown or revoked keys.
 */
export async function resolveOrgId(db: Db, token: string): Promise<string | null> {
  const result = await db.query<{ org_id: string | null }>(
    "select app.resolve_api_key($1) as org_id",
    [token],
  );
  return result.rows[0]?.org_id ?? null;
}

/**
 * The third argument to set_config scopes the value to this transaction. A
 * pooled connection must never carry one tenant's id into the next checkout.
 */
export async function withTenant<TResult>(
  db: Db,
  orgId: string,
  run: (client: PoolClient) => Promise<TResult>,
): Promise<TResult> {
  const client = await db.connect();
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
