import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import pg from "pg";

const DATABASE_URL = "postgres://mcp_app:mcp@localhost:55432/context_shared";
const DEV_KEY = "ctx_dev_key";
const RIVAL_KEY = "ctx_rival_key";
const PORT = 4400;
const BASE = `http://127.0.0.1:${PORT}`;
const RESOURCE = `${BASE}/mcp`;
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";

let failures = 0;

function check(name: string, passed: boolean, detail?: string): void {
  if (passed) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? "" : `\n       ${detail}`}`);
}

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type Pkce = { readonly verifier: string; readonly challenge: string };

function pkce(): Pkce {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

async function waitForHealth(attempts: number): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return true;
    } catch {
      // server not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return { __raw: text };
  }
}

function str(doc: Record<string, unknown>, key: string): string {
  const value = doc[key];
  return typeof value === "string" ? value : "";
}

async function registerClient(): Promise<string> {
  const response = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "oauth-e2e",
      redirect_uris: [CALLBACK],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  check("DCR returns 201", response.status === 201, `got ${response.status}`);
  const body = await json(response);
  return str(body, "client_id");
}

type Authorized = { readonly status: number; readonly location: string };

async function authorize(
  clientId: string,
  challenge: string,
  apiKey: string,
  state: string,
): Promise<Authorized> {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    resource: RESOURCE,
    scope: "board",
  });
  const response = await fetch(`${BASE}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...Object.fromEntries(query), api_key: apiKey }).toString(),
    redirect: "manual",
  });
  return { status: response.status, location: response.headers.get("location") ?? "" };
}

async function token(form: Record<string, string>): Promise<{
  readonly status: number;
  readonly body: Record<string, unknown>;
}> {
  const response = await fetch(`${BASE}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  return { status: response.status, body: await json(response) };
}

function connect(accessToken: string): Promise<Client> {
  const client = new Client({ name: "oauth-e2e", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  return client.connect(transport).then(() => client);
}

type CallResult = Awaited<ReturnType<Client["callTool"]>>;

function textOf(result: CallResult): string {
  const content: unknown = result.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: unknown) => {
      if (typeof block !== "object" || block === null) return "";
      const record = block as Record<string, unknown>;
      return record["type"] === "text" && typeof record["text"] === "string"
        ? record["text"]
        : "";
    })
    .join("\n");
}

/**
 * api_keys is under RLS, so an UPDATE without the tenant GUC silently touches
 * zero rows — which would make the revocation assertion below pass vacuously.
 */
async function setKeyRevoked(
  pool: pg.Pool,
  rawKey: string,
  orgId: string,
  revoked: boolean,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.current_org_id', $1, true)", [orgId]);
    const result = await client.query(
      `update api_keys
          set revoked_at = case when $2 then now() else null end
        where key_hash = encode(sha256(convert_to($1, 'utf8')), 'hex')`,
      [rawKey, revoked],
    );
    await client.query("commit");
    if (result.rowCount !== 1) {
      throw new Error(`revocation touched ${String(result.rowCount)} rows, expected 1`);
    }
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const child = spawn(process.execPath, ["dist/http.js"], {
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
      CONTEXT_SHARED_DATABASE_URL: DATABASE_URL,
      CONTEXT_SHARED_PUBLIC_URL: BASE,
      PORT: String(PORT),
    },
    stdio: "ignore",
  });

  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  try {
    check("server becomes healthy", await waitForHealth(40));

    // ------------------------------------------------------------ discovery

    const challenge401 = await fetch(RESOURCE, { method: "POST" });
    const wwwAuth = challenge401.headers.get("www-authenticate") ?? "";
    check("unauthenticated MCP request is 401", challenge401.status === 401);
    check(
      "401 points at the protected resource metadata",
      wwwAuth.includes(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`),
      wwwAuth,
    );

    const prm = await json(await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`));
    check("protected resource metadata names the exact resource", str(prm, "resource") === RESOURCE, JSON.stringify(prm));
    const servers = prm["authorization_servers"];
    check(
      "protected resource metadata lists the authorization server",
      Array.isArray(servers) && servers[0] === BASE,
      JSON.stringify(servers),
    );

    const asm = await json(await fetch(`${BASE}/.well-known/oauth-authorization-server`));
    check("authorization server metadata issuer matches", str(asm, "issuer") === BASE, JSON.stringify(asm));
    const methods = asm["code_challenge_methods_supported"];
    check(
      "authorization server advertises S256",
      Array.isArray(methods) && methods.includes("S256"),
      JSON.stringify(methods),
    );
    check(
      "authorization server advertises iss in responses",
      asm["authorization_response_iss_parameter_supported"] === true,
      JSON.stringify(asm["authorization_response_iss_parameter_supported"]),
    );

    // ------------------------------------------------------------ registration

    const clientId = await registerClient();
    check("DCR issues a client id", clientId.length > 0, clientId);

    const form = await fetch(
      `${BASE}/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: CALLBACK,
        code_challenge: pkce().challenge,
        code_challenge_method: "S256",
        resource: RESOURCE,
      }).toString()}`,
    );
    const formHtml = await form.text();
    check("the consent page renders", form.status === 200 && formHtml.includes("<form"), `${form.status}`);
    check("the consent page asks for the api key", formHtml.includes("api_key"), formHtml.slice(0, 200));

    // 'self' resolves to nothing when the page runs with an opaque origin, and
    // the browser then blocks the page's own submit. Absolute origins survive.
    const csp = form.headers.get("content-security-policy") ?? "";
    check(
      "the CSP lets the consent form post to this server",
      csp.includes(`form-action ${BASE}`),
      csp,
    );
    check(
      "the CSP does not rely on 'self' for form-action",
      !csp.includes("form-action 'self'"),
      csp,
    );
    check(
      "the CSP allows the callback origin, for browsers that check the redirect",
      csp.includes("https://claude.ai"),
      csp,
    );

    // `;` is a legal hostname character, so a registered redirect_uri can smuggle
    // one into the CSP header unless the derived origin is filtered.
    const injector = await fetch(`${BASE}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "injector",
        redirect_uris: ["https://evil.example;style-src/cb"],
        token_endpoint_auth_method: "none",
      }),
    });
    if (injector.status === 201) {
      const injectorId = str(await json(injector), "client_id");
      const injected = await fetch(
        `${BASE}/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: injectorId,
          redirect_uri: "https://evil.example;style-src/cb",
          code_challenge: pkce().challenge,
          code_challenge_method: "S256",
          resource: RESOURCE,
        }).toString()}`,
      );
      const injectedCsp = injected.headers.get("content-security-policy") ?? "";
      check(
        "a semicolon in a redirect_uri host cannot open a CSP directive",
        !injectedCsp.includes("evil.example"),
        injectedCsp,
      );
    } else {
      check("a semicolon host is refused at registration", injector.status === 400, `${injector.status}`);
    }

    const unknownClient = await fetch(
      `${BASE}/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: "not-registered",
        redirect_uri: CALLBACK,
        code_challenge: pkce().challenge,
        code_challenge_method: "S256",
        resource: RESOURCE,
      }).toString()}`,
    );
    check("an unknown client is rejected", unknownClient.status === 400, `got ${unknownClient.status}`);

    const badRedirect = await fetch(
      `${BASE}/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: "https://attacker.example/steal",
        code_challenge: pkce().challenge,
        code_challenge_method: "S256",
        resource: RESOURCE,
      }).toString()}`,
    );
    check(
      "an unregistered redirect_uri is rejected without redirecting",
      badRedirect.status === 400,
      `got ${badRedirect.status}`,
    );

    // ------------------------------------------------------------ authorize

    const wrongKey = await authorize(clientId, pkce().challenge, "ctx_not_a_key", "s0");
    check(
      "a bad api key does not mint a code",
      wrongKey.status === 200 && wrongKey.location === "",
      `${wrongKey.status} ${wrongKey.location}`,
    );

    const devPkce = pkce();
    const granted = await authorize(clientId, devPkce.challenge, DEV_KEY, "state-123");
    check("a good api key redirects", granted.status === 302, `got ${granted.status}`);
    const redirect = new URL(granted.location === "" ? "https://placeholder.invalid" : granted.location);
    const code = redirect.searchParams.get("code") ?? "";
    check("the redirect carries a code", code.length > 0, granted.location);
    check("the redirect preserves state", redirect.searchParams.get("state") === "state-123", granted.location);
    check("the redirect carries iss", redirect.searchParams.get("iss") === BASE, granted.location);
    check(
      "the code never travels to the resource as a query param",
      !granted.location.includes(RESOURCE),
      granted.location,
    );

    // ------------------------------------------------------------ token

    const wrongVerifier = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: CALLBACK,
      client_id: clientId,
      code_verifier: pkce().verifier,
      resource: RESOURCE,
    });
    check(
      "PKCE rejects a mismatched verifier",
      wrongVerifier.status === 400 && wrongVerifier.body["error"] === "invalid_grant",
      JSON.stringify(wrongVerifier),
    );

    // A mismatched verifier means the holder did not start the flow, so the
    // code is spent on that attempt. A real client never sends the wrong one.
    const afterBadVerifier = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: CALLBACK,
      client_id: clientId,
      code_verifier: devPkce.verifier,
      resource: RESOURCE,
    });
    check(
      "a failed PKCE attempt burns the code for good",
      afterBadVerifier.status === 400 && afterBadVerifier.body["error"] === "invalid_grant",
      JSON.stringify(afterBadVerifier.body),
    );

    const exchangePkce = pkce();
    const exchangeGrant = await authorize(clientId, exchangePkce.challenge, DEV_KEY, "s1");
    const exchangeCode = new URL(exchangeGrant.location).searchParams.get("code") ?? "";
    const exchanged = await token({
      grant_type: "authorization_code",
      code: exchangeCode,
      redirect_uri: CALLBACK,
      client_id: clientId,
      code_verifier: exchangePkce.verifier,
      resource: RESOURCE,
    });
    check("the code exchanges for a token", exchanged.status === 200, JSON.stringify(exchanged.body));
    const accessToken = str(exchanged.body, "access_token");
    const refreshToken = str(exchanged.body, "refresh_token");
    check("an access token is issued", accessToken.length > 0);
    check("a refresh token is issued", refreshToken.length > 0);
    check("the token type is Bearer", str(exchanged.body, "token_type") === "Bearer");
    check(
      "the access token expires",
      typeof exchanged.body["expires_in"] === "number" && (exchanged.body["expires_in"] as number) > 0,
      JSON.stringify(exchanged.body["expires_in"]),
    );
    check(
      "the api key is not echoed back",
      !JSON.stringify(exchanged.body).includes(DEV_KEY),
      JSON.stringify(exchanged.body),
    );

    // A consumed code must not work twice, and the reuse must burn the tokens
    // it already minted: a replayed code is evidence the code leaked.
    const replayed = await token({
      grant_type: "authorization_code",
      code: exchangeCode,
      redirect_uri: CALLBACK,
      client_id: clientId,
      code_verifier: exchangePkce.verifier,
      resource: RESOURCE,
    });
    check(
      "a replayed code is rejected",
      replayed.status === 400 && replayed.body["error"] === "invalid_grant",
      JSON.stringify(replayed.body),
    );

    const afterReplay = await fetch(RESOURCE, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    check(
      "replaying a code revokes the tokens it already minted",
      afterReplay.status === 401,
      `got ${afterReplay.status}`,
    );

    // ------------------------------------------------------------ real usage

    const devPkce2 = pkce();
    const granted2 = await authorize(clientId, devPkce2.challenge, DEV_KEY, "s2");
    const code2 = new URL(granted2.location).searchParams.get("code") ?? "";
    const live = await token({
      grant_type: "authorization_code",
      code: code2,
      redirect_uri: CALLBACK,
      client_id: clientId,
      code_verifier: devPkce2.verifier,
      resource: RESOURCE,
    });
    const liveAccess = str(live.body, "access_token");
    const liveRefresh = str(live.body, "refresh_token");
    check("a second grant issues a usable token", liveAccess.length > 0, JSON.stringify(live.body));

    const client = await connect(liveAccess);
    const listed = textOf(await client.callTool({ name: "list_projects", arguments: {} }));
    check("an OAuth token can call a tool", listed.includes("checkout"), listed);

    // The whole point of audience binding: the org behind the token, not the
    // org behind whoever asks last.
    const rivalPkce = pkce();
    const rivalGrant = await authorize(clientId, rivalPkce.challenge, RIVAL_KEY, "s3");
    const rivalCode = new URL(rivalGrant.location).searchParams.get("code") ?? "";
    const rivalToken = await token({
      grant_type: "authorization_code",
      code: rivalCode,
      redirect_uri: CALLBACK,
      client_id: clientId,
      code_verifier: rivalPkce.verifier,
      resource: RESOURCE,
    });
    const rivalAccess = str(rivalToken.body, "access_token");
    const rivalClient = await connect(rivalAccess);
    const rivalListed = textOf(await rivalClient.callTool({ name: "list_projects", arguments: {} }));
    check(
      "two OAuth tokens land in different orgs",
      rivalListed.includes("Rival Checkout") && !listed.includes("Rival Checkout"),
      `${rivalListed}\n---\n${listed}`,
    );

    await client.close();
    await rivalClient.close();

    // ------------------------------------------------------------ refresh

    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: liveRefresh,
      client_id: clientId,
      resource: RESOURCE,
    });
    check("a refresh token exchanges", refreshed.status === 200, JSON.stringify(refreshed.body));
    const newAccess = str(refreshed.body, "access_token");
    const newRefresh = str(refreshed.body, "refresh_token");
    check("refresh returns a new access token", newAccess.length > 0 && newAccess !== liveAccess);
    check("refresh rotates the refresh token", newRefresh.length > 0 && newRefresh !== liveRefresh);

    const replayedRefresh = await token({
      grant_type: "refresh_token",
      refresh_token: liveRefresh,
      client_id: clientId,
      resource: RESOURCE,
    });
    check(
      "a rotated-away refresh token is rejected",
      replayedRefresh.status === 400 && replayedRefresh.body["error"] === "invalid_grant",
      JSON.stringify(replayedRefresh.body),
    );

    // Inside the grace window a re-presented token is one client submitting
    // twice. The burn is covered in 0003_oauth_test.sql, at grace zero.
    const afterRefreshReuse = await fetch(RESOURCE, {
      method: "POST",
      headers: { Authorization: `Bearer ${newAccess}` },
    });
    check(
      "a duplicate submit inside the grace window spares the live session",
      afterRefreshReuse.status !== 401,
      `got ${afterRefreshReuse.status}`,
    );

    // Rotation only defends anything if it is atomic. Two requests presenting
    // the same refresh token must not both walk away with a live chain.
    const racePkce = pkce();
    const raceGrant = await authorize(clientId, racePkce.challenge, DEV_KEY, "s-race");
    const raceCode = new URL(raceGrant.location).searchParams.get("code") ?? "";
    const raceIssued = await token({
      grant_type: "authorization_code",
      code: raceCode,
      redirect_uri: CALLBACK,
      client_id: clientId,
      code_verifier: racePkce.verifier,
      resource: RESOURCE,
    });
    const raceRefresh = str(raceIssued.body, "refresh_token");

    const raced = await Promise.all([
      token({ grant_type: "refresh_token", refresh_token: raceRefresh, client_id: clientId }),
      token({ grant_type: "refresh_token", refresh_token: raceRefresh, client_id: clientId }),
    ]);
    const winners = raced.filter((attempt) => attempt.status === 200).length;
    check(
      "concurrent refresh of one token produces exactly one winner",
      winners === 1,
      `${winners} of 2 succeeded`,
    );

    // Counting winners is not enough: the loser's chain cleanup can reach the
    // pair the winner just minted, handing back a token that is already dead.
    const raceWinner = raced.find((attempt) => attempt.status === 200);
    const raceAccess = raceWinner === undefined ? "" : str(raceWinner.body, "access_token");
    const raceUsable = await fetch(RESOURCE, {
      method: "POST",
      headers: { Authorization: `Bearer ${raceAccess}` },
    });
    check(
      "the token handed to the concurrency winner actually works",
      raceAccess !== "" && raceUsable.status !== 401,
      `got ${raceUsable.status}`,
    );

    // ------------------------------------------------------------ revocation

    const revokePkce = pkce();
    const revokeGrant = await authorize(clientId, revokePkce.challenge, DEV_KEY, "s4");
    const revokeCode = new URL(revokeGrant.location).searchParams.get("code") ?? "";
    const revokeIssued = await token({
      grant_type: "authorization_code",
      code: revokeCode,
      redirect_uri: CALLBACK,
      client_id: clientId,
      code_verifier: revokePkce.verifier,
      resource: RESOURCE,
    });
    const doomed = str(revokeIssued.body, "access_token");

    const beforeRevoke = await fetch(RESOURCE, {
      method: "POST",
      headers: { Authorization: `Bearer ${doomed}` },
    });
    check("the token works before the key is revoked", beforeRevoke.status !== 401, `got ${beforeRevoke.status}`);

    const resolvedDev = await pool.query<{ org_id: string }>(
      "select org_id from app.resolve_api_key_ref($1)",
      [DEV_KEY],
    );
    const devOrg = resolvedDev.rows[0]?.org_id ?? "";
    check("the dev key resolves before revocation", devOrg !== "", devOrg);

    await setKeyRevoked(pool, DEV_KEY, devOrg, true);
    try {
      const afterRevoke = await fetch(RESOURCE, {
        method: "POST",
        headers: { Authorization: `Bearer ${doomed}` },
      });
      check(
        "revoking the api key kills tokens minted from it",
        afterRevoke.status === 401,
        `got ${afterRevoke.status}`,
      );
    } finally {
      await setKeyRevoked(pool, DEV_KEY, devOrg, false);
    }

    // ------------------------------------------------------------ compatibility

    const legacy = await fetch(RESOURCE, {
      method: "POST",
      headers: { Authorization: `Bearer ${DEV_KEY}` },
    });
    check(
      "a raw api key still authenticates, for Claude Code",
      legacy.status !== 401,
      `got ${legacy.status}`,
    );
  } finally {
    await pool.end();
    child.kill();
  }

  console.log(failures === 0 ? "\nALL OAUTH E2E TESTS PASSED" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
