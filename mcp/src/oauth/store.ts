import type { Db } from "../db/pool.js";

export type ApiKeyRef = {
  readonly orgId: string;
  readonly apiKeyId: string;
};

export type OauthClient = {
  readonly clientId: string;
  readonly secretHash: string | null;
  readonly redirectUris: readonly string[];
};

export type RedeemedCode = {
  readonly clientId: string;
  readonly orgId: string;
  readonly apiKeyId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly scope: string;
  readonly resource: string;
};

export type RotatedTokens = {
  readonly orgId: string;
  readonly resource: string;
  readonly scope: string;
};

export type IssueCodeInput = {
  readonly codeHash: string;
  readonly clientId: string;
  readonly orgId: string;
  readonly apiKeyId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly scope: string;
  readonly resource: string;
  readonly ttlSeconds: number;
};

/** Four same-typed hashes and three same-typed durations: positionally, a
 *  transposed pair typechecks and quietly rewrites the security parameters. */
export type RotateRefreshInput = {
  readonly refreshHash: string;
  readonly clientId: string;
  readonly newAccessHash: string;
  readonly newRefreshHash: string;
  readonly accessTtlSeconds: number;
  readonly refreshTtlSeconds: number;
  /** Inside this window a re-presented token is a duplicate submit; outside
   *  it, a replay, and the chain is burned. */
  readonly reuseGraceSeconds: number;
};

export type IssueTokensInput = {
  readonly accessHash: string;
  readonly refreshHash: string;
  readonly clientId: string;
  readonly orgId: string;
  readonly apiKeyId: string;
  readonly resource: string;
  readonly scope: string;
  readonly originCodeHash: string;
  readonly accessTtlSeconds: number;
  readonly refreshTtlSeconds: number;
};

/** Every call goes through a SECURITY DEFINER function: the app role holds no
 *  privilege on the oauth tables themselves. */
export async function resolveApiKeyRef(db: Db, rawToken: string): Promise<ApiKeyRef | null> {
  const result = await db.query<{ org_id: string; api_key_id: string }>(
    "select org_id, api_key_id from app.resolve_api_key_ref($1)",
    [rawToken],
  );
  const row = result.rows[0];
  return row === undefined ? null : { orgId: row.org_id, apiKeyId: row.api_key_id };
}

export async function findClient(db: Db, clientId: string): Promise<OauthClient | null> {
  const result = await db.query<{
    client_id: string;
    client_secret_hash: string | null;
    redirect_uris: readonly string[];
  }>("select client_id, client_secret_hash, redirect_uris from app.oauth_find_client($1)", [
    clientId,
  ]);
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    clientId: row.client_id,
    secretHash: row.client_secret_hash,
    redirectUris: row.redirect_uris,
  };
}

export async function registerClient(
  db: Db,
  clientId: string,
  secretHash: string | null,
  clientName: string,
  redirectUris: readonly string[],
): Promise<void> {
  await db.query("select app.oauth_register_client($1, $2, $3, $4)", [
    clientId,
    secretHash,
    clientName,
    redirectUris,
  ]);
}

export async function issueCode(db: Db, input: IssueCodeInput): Promise<void> {
  await db.query(
    "select app.oauth_issue_code($1, $2, $3, $4, $5, $6, $7, $8, make_interval(secs => $9))",
    [
      input.codeHash,
      input.clientId,
      input.orgId,
      input.apiKeyId,
      input.redirectUri,
      input.codeChallenge,
      input.scope,
      input.resource,
      input.ttlSeconds,
    ],
  );
}

/** Returns null both for an unknown code and for a replayed one — and the
 *  replay case revokes whatever that code already minted. */
export async function redeemCode(db: Db, codeHash: string): Promise<RedeemedCode | null> {
  const result = await db.query<{
    client_id: string;
    org_id: string;
    api_key_id: string;
    redirect_uri: string;
    code_challenge: string;
    scope: string;
    resource: string;
  }>("select * from app.oauth_redeem_code($1)", [codeHash]);
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    clientId: row.client_id,
    orgId: row.org_id,
    apiKeyId: row.api_key_id,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    scope: row.scope,
    resource: row.resource,
  };
}

export async function issueTokens(db: Db, input: IssueTokensInput): Promise<void> {
  await db.query(
    `select app.oauth_issue_tokens($1, $2, $3, $4, $5, $6, $7, $8,
              make_interval(secs => $9), make_interval(secs => $10))`,
    [
      input.accessHash,
      input.refreshHash,
      input.clientId,
      input.orgId,
      input.apiKeyId,
      input.resource,
      input.scope,
      input.originCodeHash,
      input.accessTtlSeconds,
      input.refreshTtlSeconds,
    ],
  );
}

export async function resolveAccess(
  db: Db,
  accessHash: string,
  resource: string,
): Promise<string | null> {
  const result = await db.query<{ org_id: string | null }>(
    "select app.oauth_resolve_access($1, $2) as org_id",
    [accessHash, resource],
  );
  return result.rows[0]?.org_id ?? null;
}

export async function rotateRefresh(
  db: Db,
  input: RotateRefreshInput,
): Promise<RotatedTokens | null> {
  const result = await db.query<{ org_id: string; resource: string; scope: string }>(
    `select org_id, resource, scope from app.oauth_rotate_refresh($1, $2, $3, $4,
       make_interval(secs => $5), make_interval(secs => $6), make_interval(secs => $7))`,
    [
      input.refreshHash,
      input.clientId,
      input.newAccessHash,
      input.newRefreshHash,
      input.accessTtlSeconds,
      input.refreshTtlSeconds,
      input.reuseGraceSeconds,
    ],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : { orgId: row.org_id, resource: row.resource, scope: row.scope };
}
