import type { IncomingMessage, ServerResponse } from "node:http";

import type { Db } from "../db/pool.js";
import { consentPage } from "./consent.js";
import { constantTimeEquals, hashSecret, newSecret, verifyPkce } from "./crypto.js";
import type { OauthConfig } from "./metadata.js";
import { authorizationServerMetadata, protectedResourceMetadata } from "./metadata.js";
import {
  findClient,
  issueCode,
  issueTokens,
  redeemCode,
  registerClient,
  resolveApiKeyRef,
  rotateRefresh,
} from "./store.js";

const BODY_LIMIT_BYTES = 64 * 1024;

const ACCESS_PREFIX = "cso_at_";
const REFRESH_PREFIX = "cso_rt_";
const CODE_PREFIX = "cso_ac_";
const CLIENT_PREFIX = "cso_id_";
const CLIENT_SECRET_PREFIX = "cso_cs_";

/** Recognises a token this server minted, so the transport can tell an OAuth
 *  access token apart from a raw API key without a database round trip. */
export function isAccessToken(token: string): boolean {
  return token.startsWith(ACCESS_PREFIX);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/**
 * `;` is a legal hostname character, so `new URL("https://x;style-src").origin`
 * carries it straight into the header and opens a CSP directive.
 */
const ORIGIN_PATTERN = /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i;

/**
 * Absolute origins, never 'self': in an embedded window the origin can be
 * opaque, and there 'self' matches nothing and blocks the form's own submit.
 * @param redirectUri - listed because some browsers apply form-action across
 *   the redirect that follows the POST
 */
function formActionSources(config: OauthConfig, redirectUri: string): string {
  const sources = [config.issuer];
  try {
    const origin = new URL(redirectUri).origin;
    if (ORIGIN_PATTERN.test(origin)) sources.push(origin);
  } catch {
    // A redirect_uri that will not parse never reached a registered client.
  }
  return sources.join(" ");
}

function sendHtml(res: ServerResponse, status: number, html: string, formAction: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    // The consent page carries a credential and embeds no scripts of its own.
    "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}`,
    "referrer-policy": "no-referrer",
  });
  res.end(html);
}

function oauthError(
  res: ServerResponse,
  status: number,
  error: string,
  description: string,
): void {
  sendJson(res, status, { error, error_description: description });
}

function redirectTo(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, "cache-control": "no-store" });
  res.end();
}

function param(source: URLSearchParams, name: string): string {
  return source.get(name) ?? "";
}

type AuthorizeRequest = {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly state: string;
  readonly scope: string;
  readonly resource: string;
};

type AuthorizeRejection = {
  /** Redirecting an error to an unvalidated URI turns the server into an open
   *  redirector, so these are shown to the human instead. */
  readonly kind: "show" | "redirect";
  readonly error: string;
  readonly description: string;
  readonly redirectUri: string;
  readonly state: string;
};

type AuthorizeParse =
  | { readonly ok: true; readonly value: AuthorizeRequest }
  | { readonly ok: false; readonly rejection: AuthorizeRejection };

async function parseAuthorize(
  db: Db,
  config: OauthConfig,
  source: URLSearchParams,
): Promise<AuthorizeParse> {
  const clientId = param(source, "client_id");
  const state = param(source, "state");

  const show = (error: string, description: string): AuthorizeParse => ({
    ok: false,
    rejection: { kind: "show", error, description, redirectUri: "", state },
  });

  if (clientId === "") return show("invalid_request", "client_id is required");

  const client = await findClient(db, clientId);
  if (client === null) return show("invalid_client", "unknown client_id");

  const requested = param(source, "redirect_uri");
  const [only] = client.redirectUris;
  const redirectUri = requested === "" && client.redirectUris.length === 1 && only !== undefined
    ? only
    : requested;

  if (!client.redirectUris.includes(redirectUri)) {
    return show("invalid_request", "redirect_uri does not match a registered value");
  }

  const reject = (error: string, description: string): AuthorizeParse => ({
    ok: false,
    rejection: { kind: "redirect", error, description, redirectUri, state },
  });

  if (param(source, "response_type") !== "code") {
    return reject("unsupported_response_type", "only the authorization code flow is supported");
  }

  const method = param(source, "code_challenge_method");
  if (method !== "S256") {
    return reject("invalid_request", "code_challenge_method must be S256");
  }

  const codeChallenge = param(source, "code_challenge");
  if (codeChallenge.length < 43) {
    return reject("invalid_request", "code_challenge is required");
  }

  const resource = param(source, "resource");
  if (resource !== "" && resource !== config.resource) {
    return reject("invalid_target", `this server only issues tokens for ${config.resource}`);
  }

  const scope = param(source, "scope");
  if (scope !== "" && !scope.split(" ").every((entry) => entry === config.scope)) {
    return reject("invalid_scope", `the only supported scope is ${config.scope}`);
  }

  return {
    ok: true,
    value: {
      clientId,
      redirectUri,
      codeChallenge,
      state,
      scope: scope === "" ? config.scope : scope,
      resource: config.resource,
    },
  };
}

function denyAuthorize(res: ServerResponse, rejection: AuthorizeRejection): void {
  if (rejection.kind === "show") {
    sendJson(res, 400, { error: rejection.error, error_description: rejection.description });
    return;
  }
  const target = new URL(rejection.redirectUri);
  target.searchParams.set("error", rejection.error);
  target.searchParams.set("error_description", rejection.description);
  if (rejection.state !== "") target.searchParams.set("state", rejection.state);
  redirectTo(res, target.toString());
}

function fieldsOf(request: AuthorizeRequest): {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly state: string;
  readonly scope: string;
  readonly resource: string;
} {
  return {
    clientId: request.clientId,
    redirectUri: request.redirectUri,
    codeChallenge: request.codeChallenge,
    state: request.state,
    scope: request.scope,
    resource: request.resource,
  };
}

async function handleAuthorizeSubmit(
  res: ServerResponse,
  db: Db,
  config: OauthConfig,
  form: URLSearchParams,
): Promise<void> {
  const parsed = await parseAuthorize(db, config, form);
  if (!parsed.ok) {
    denyAuthorize(res, parsed.rejection);
    return;
  }
  const request = parsed.value;

  const apiKey = param(form, "api_key");
  const ref = apiKey === "" ? null : await resolveApiKeyRef(db, apiKey);
  if (ref === null) {
    // Re-rendering rather than redirecting keeps a failed attempt off the
    // client's callback, where a wrong key would look like a server error.
    sendHtml(
      res,
      200,
      consentPage(fieldsOf(request), "That key is not valid or has been revoked."),
      formActionSources(config, request.redirectUri),
    );
    return;
  }

  const code = newSecret(CODE_PREFIX);
  await issueCode(db, {
    codeHash: hashSecret(code),
    clientId: request.clientId,
    orgId: ref.orgId,
    apiKeyId: ref.apiKeyId,
    redirectUri: request.redirectUri,
    codeChallenge: request.codeChallenge,
    scope: request.scope,
    resource: request.resource,
    ttlSeconds: config.codeTtlSeconds,
  });

  const target = new URL(request.redirectUri);
  target.searchParams.set("code", code);
  if (request.state !== "") target.searchParams.set("state", request.state);
  target.searchParams.set("iss", config.issuer);
  redirectTo(res, target.toString());
}

async function authenticateClient(
  db: Db,
  clientId: string,
  presentedSecret: string,
): Promise<boolean> {
  const client = await findClient(db, clientId);
  if (client === null) return false;
  if (client.secretHash === null) return true;
  if (presentedSecret === "") return false;
  return constantTimeEquals(hashSecret(presentedSecret), client.secretHash);
}

async function handleAuthorizationCodeGrant(
  res: ServerResponse,
  db: Db,
  config: OauthConfig,
  form: URLSearchParams,
): Promise<void> {
  const clientId = param(form, "client_id");
  const code = param(form, "code");
  const verifier = param(form, "code_verifier");

  if (clientId === "" || code === "" || verifier === "") {
    oauthError(res, 400, "invalid_request", "client_id, code and code_verifier are required");
    return;
  }
  if (!(await authenticateClient(db, clientId, param(form, "client_secret")))) {
    oauthError(res, 401, "invalid_client", "client authentication failed");
    return;
  }

  const codeHash = hashSecret(code);
  const redeemed = await redeemCode(db, codeHash);
  if (redeemed === null) {
    oauthError(res, 400, "invalid_grant", "the code is unknown, expired or already used");
    return;
  }
  if (redeemed.clientId !== clientId) {
    oauthError(res, 400, "invalid_grant", "the code was issued to another client");
    return;
  }

  const presentedRedirect = param(form, "redirect_uri");
  if (presentedRedirect !== "" && presentedRedirect !== redeemed.redirectUri) {
    oauthError(res, 400, "invalid_grant", "redirect_uri does not match the authorization request");
    return;
  }
  if (!verifyPkce(verifier, redeemed.codeChallenge)) {
    oauthError(res, 400, "invalid_grant", "the code verifier does not match the challenge");
    return;
  }

  const requestedResource = param(form, "resource");
  if (requestedResource !== "" && requestedResource !== redeemed.resource) {
    oauthError(res, 400, "invalid_target", "the token was requested for another resource");
    return;
  }

  const accessToken = newSecret(ACCESS_PREFIX);
  const refreshToken = newSecret(REFRESH_PREFIX);
  await issueTokens(db, {
    accessHash: hashSecret(accessToken),
    refreshHash: hashSecret(refreshToken),
    clientId,
    orgId: redeemed.orgId,
    apiKeyId: redeemed.apiKeyId,
    resource: redeemed.resource,
    scope: redeemed.scope,
    originCodeHash: codeHash,
    accessTtlSeconds: config.accessTtlSeconds,
    refreshTtlSeconds: config.refreshTtlSeconds,
  });

  sendJson(res, 200, {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: config.accessTtlSeconds,
    refresh_token: refreshToken,
    scope: redeemed.scope,
  });
}

async function handleRefreshGrant(
  res: ServerResponse,
  db: Db,
  config: OauthConfig,
  form: URLSearchParams,
): Promise<void> {
  const clientId = param(form, "client_id");
  const presented = param(form, "refresh_token");
  if (clientId === "" || presented === "") {
    oauthError(res, 400, "invalid_request", "client_id and refresh_token are required");
    return;
  }
  if (!(await authenticateClient(db, clientId, param(form, "client_secret")))) {
    oauthError(res, 401, "invalid_client", "client authentication failed");
    return;
  }

  const accessToken = newSecret(ACCESS_PREFIX);
  const refreshToken = newSecret(REFRESH_PREFIX);
  const rotated = await rotateRefresh(db, {
    refreshHash: hashSecret(presented),
    clientId,
    newAccessHash: hashSecret(accessToken),
    newRefreshHash: hashSecret(refreshToken),
    accessTtlSeconds: config.accessTtlSeconds,
    refreshTtlSeconds: config.refreshTtlSeconds,
    reuseGraceSeconds: config.reuseGraceSeconds,
  });
  if (rotated === null) {
    oauthError(res, 400, "invalid_grant", "the refresh token is unknown, expired or revoked");
    return;
  }

  sendJson(res, 200, {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: config.accessTtlSeconds,
    refresh_token: refreshToken,
    scope: rotated.scope,
  });
}

function parseRegistration(raw: string): { readonly uris: readonly string[]; readonly name: string;
  readonly confidential: boolean } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const doc = parsed as Record<string, unknown>;

  const uris = doc["redirect_uris"];
  if (!Array.isArray(uris) || uris.length === 0) return null;
  const validated: string[] = [];
  for (const entry of uris) {
    if (typeof entry !== "string") return null;
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      return null;
    }
    // A loopback exception is required for native clients (RFC 8252); anything
    // else on plain http would leak the code to the network.
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    validated.push(entry);
  }

  const name = doc["client_name"];
  const authMethod = doc["token_endpoint_auth_method"];
  return {
    uris: validated,
    name: typeof name === "string" ? name.slice(0, 200) : "",
    confidential: authMethod === "client_secret_post" || authMethod === "client_secret_basic",
  };
}

async function handleRegister(res: ServerResponse, db: Db, raw: string): Promise<void> {
  const registration = parseRegistration(raw);
  if (registration === null) {
    oauthError(
      res,
      400,
      "invalid_client_metadata",
      "redirect_uris must be a non-empty array of https (or loopback http) URLs",
    );
    return;
  }

  const clientId = newSecret(CLIENT_PREFIX);
  const secret = registration.confidential ? newSecret(CLIENT_SECRET_PREFIX) : null;
  await registerClient(
    db,
    clientId,
    secret === null ? null : hashSecret(secret),
    registration.name,
    registration.uris,
  );

  sendJson(res, 201, {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    ...(secret === null ? {} : { client_secret: secret, client_secret_expires_at: 0 }),
    client_name: registration.name,
    redirect_uris: registration.uris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: secret === null ? "none" : "client_secret_post",
  });
}

/** Returns false when the path belongs to the MCP transport rather than to the
 *  authorization server, so the caller keeps owning its own routes. */
export async function handleOauthRoute(
  req: IncomingMessage,
  res: ServerResponse,
  db: Db,
  config: OauthConfig,
  path: string,
): Promise<boolean> {
  const method = req.method ?? "GET";

  if (
    path === "/.well-known/oauth-protected-resource" ||
    path === `/.well-known/oauth-protected-resource${config.mcpPath}`
  ) {
    sendJson(res, 200, protectedResourceMetadata(config));
    return true;
  }

  if (
    path === "/.well-known/oauth-authorization-server" ||
    path === `/.well-known/oauth-authorization-server${config.mcpPath}` ||
    path === "/.well-known/openid-configuration"
  ) {
    sendJson(res, 200, authorizationServerMetadata(config));
    return true;
  }

  if (path === "/register") {
    if (method !== "POST") {
      oauthError(res, 405, "invalid_request", "registration accepts POST only");
      return true;
    }
    await handleRegister(res, db, await readBody(req));
    return true;
  }

  if (path === "/authorize") {
    if (method === "GET") {
      const query = new URL(req.url ?? "/", config.issuer).searchParams;
      const parsed = await parseAuthorize(db, config, query);
      if (!parsed.ok) {
        denyAuthorize(res, parsed.rejection);
        return true;
      }
      sendHtml(
        res,
        200,
        consentPage(fieldsOf(parsed.value)),
        formActionSources(config, parsed.value.redirectUri),
      );
      return true;
    }
    if (method === "POST") {
      await handleAuthorizeSubmit(res, db, config, new URLSearchParams(await readBody(req)));
      return true;
    }
    oauthError(res, 405, "invalid_request", "authorize accepts GET and POST only");
    return true;
  }

  if (path === "/token") {
    if (method !== "POST") {
      oauthError(res, 405, "invalid_request", "the token endpoint accepts POST only");
      return true;
    }
    const contentType = req.headers["content-type"] ?? "";
    if (!contentType.includes("application/x-www-form-urlencoded")) {
      oauthError(res, 415, "invalid_request", "the token endpoint requires form encoding");
      return true;
    }
    const form = new URLSearchParams(await readBody(req));
    const grant = param(form, "grant_type");
    if (grant === "authorization_code") {
      await handleAuthorizationCodeGrant(res, db, config, form);
      return true;
    }
    if (grant === "refresh_token") {
      await handleRefreshGrant(res, db, config, form);
      return true;
    }
    oauthError(res, 400, "unsupported_grant_type", `grant_type ${grant} is not supported`);
    return true;
  }

  return false;
}
