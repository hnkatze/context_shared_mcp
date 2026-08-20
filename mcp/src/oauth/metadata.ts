export type OauthConfig = {
  /** Origin of this deployment; also the OAuth issuer identifier. */
  readonly issuer: string;
  /** The audience a token is minted for — must equal the URL a user types
   *  into Claude, path included, or discovery silently fails. */
  readonly resource: string;
  readonly mcpPath: string;
  readonly scope: string;
  readonly codeTtlSeconds: number;
  readonly accessTtlSeconds: number;
  readonly refreshTtlSeconds: number;
  /** How long after rotation a presented token is read as a duplicate submit
   *  rather than a replay. The two are indistinguishable server-side. */
  readonly reuseGraceSeconds: number;
};

const DEFAULTS = {
  mcpPath: "/mcp",
  scope: "board",
  codeTtlSeconds: 300,
  accessTtlSeconds: 3600,
  refreshTtlSeconds: 60 * 60 * 24 * 30,
  reuseGraceSeconds: 10,
} as const;

/** Trailing slashes break the exact-match rule on `resource`, so the issuer is
 *  normalised once here rather than at every comparison. */
export function buildOauthConfig(publicUrl: string): OauthConfig {
  const issuer = publicUrl.replace(/\/+$/, "");
  return {
    issuer,
    resource: `${issuer}${DEFAULTS.mcpPath}`,
    ...DEFAULTS,
  };
}

export function protectedResourceMetadata(config: OauthConfig): Record<string, unknown> {
  return {
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: [config.scope],
    bearer_methods_supported: ["header"],
    resource_documentation: `${config.issuer}/`,
  };
}

export function authorizationServerMetadata(config: OauthConfig): Record<string, unknown> {
  return {
    issuer: config.issuer,
    authorization_endpoint: `${config.issuer}/authorize`,
    token_endpoint: `${config.issuer}/token`,
    registration_endpoint: `${config.issuer}/register`,
    scopes_supported: [config.scope],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    authorization_response_iss_parameter_supported: true,
  };
}

/** The `resource_metadata` parameter is the whole handshake: without it Claude
 *  never learns where the authorization server lives. */
export function challengeHeader(config: OauthConfig, error?: string): string {
  const parts = [
    `Bearer resource_metadata="${config.issuer}/.well-known/oauth-protected-resource${config.mcpPath}"`,
    `scope="${config.scope}"`,
  ];
  if (error !== undefined) parts.push(`error="${error}"`);
  return parts.join(", ");
}
