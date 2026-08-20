import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";

import { createPool, resolveOrgId } from "./db/pool.js";
import { buildOauthConfig, challengeHeader } from "./oauth/metadata.js";
import { hashSecret } from "./oauth/crypto.js";
import { handleOauthRoute, isAccessToken } from "./oauth/routes.js";
import { resolveAccess } from "./oauth/store.js";
import { createContextServer } from "./server.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing environment variable ${name}`);
  }
  return value;
}

const db = createPool(requireEnv("CONTEXT_SHARED_DATABASE_URL"));
const port = Number(process.env["PORT"] ?? "8080");

/**
 * `resource` must equal the URL a user types into Claude character for
 * character, so a missing value is announced rather than silently guessed.
 */
const configuredUrl = process.env["CONTEXT_SHARED_PUBLIC_URL"];
if (configuredUrl === undefined || configuredUrl === "") {
  process.stdout.write(
    "warning: CONTEXT_SHARED_PUBLIC_URL is unset; OAuth discovery will advertise localhost\n",
  );
}
const oauth = buildOauthConfig(
  configuredUrl === undefined || configuredUrl === "" ? `http://127.0.0.1:${port}` : configuredUrl,
);

function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const [scheme, value] = header.split(" ");
  if (scheme === undefined || scheme.toLowerCase() !== "bearer") return null;
  if (value === undefined || value === "") return null;
  return value;
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    ...(status === 401 ? { "www-authenticate": challengeHeader(oauth) } : {}),
  });
  res.end(payload);
}

/** Node types method and url as optional; the MCP handler requires both. */
function hasMethod(
  req: IncomingMessage,
): req is IncomingMessage & { method: string; url: string } {
  return typeof req.method === "string" && typeof req.url === "string";
}

/**
 * An OAuth token is audience-bound and expires; a raw API key is neither, and
 * is kept because Claude Code can send one and the connector UI cannot.
 */
async function orgForToken(token: string): Promise<string | null> {
  return isAccessToken(token)
    ? resolveAccess(db, hashSecret(token), oauth.resource)
    : resolveOrgId(db, token);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? "/").split("?")[0] ?? "/";

  if (path === "/health") {
    try {
      await db.query("select 1");
      respond(res, 200, { status: "ok" });
    } catch {
      respond(res, 503, { status: "database unreachable" });
    }
    return;
  }

  // Authorization endpoints have to answer before any credential check: they
  // are how a caller with no credential gets one.
  if (await handleOauthRoute(req, res, db, oauth, path)) return;

  // The org is resolved per request and handed to a server built for that
  // request alone, so no caller can ever observe another tenant's board.
  const token = bearerToken(req.headers.authorization);
  if (token === null) {
    respond(res, 401, { error: "missing bearer token" });
    return;
  }

  const orgId = await orgForToken(token);
  if (orgId === null) {
    respond(res, 401, { error: "invalid or revoked credential" });
    return;
  }

  if (!hasMethod(req)) {
    respond(res, 400, { error: "request has no method or url" });
    return;
  }

  const handler = createMcpHandler(() => createContextServer(db, orgId));
  await toNodeHandler(handler)(req, res);
}

const httpServer = createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    if (!res.headersSent) {
      respond(res, 500, { error: error instanceof Error ? error.message : String(error) });
    } else {
      res.end();
    }
  });
});

httpServer.listen(port, () => {
  process.stdout.write(`context-shared MCP listening on :${port}\n`);
  process.stdout.write(`  resource: ${oauth.resource}\n`);
});
