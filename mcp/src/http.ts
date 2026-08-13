import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";

import { createPool, resolveOrgId } from "./db/pool.js";
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
    ...(status === 401 ? { "www-authenticate": 'Bearer realm="context-shared"' } : {}),
  });
  res.end(payload);
}

/** Node types method and url as optional; the MCP handler requires both. */
function hasMethod(
  req: IncomingMessage,
): req is IncomingMessage & { method: string; url: string } {
  return typeof req.method === "string" && typeof req.url === "string";
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? "/").split("?")[0];

  if (path === "/health") {
    try {
      await db.query("select 1");
      respond(res, 200, { status: "ok" });
    } catch {
      respond(res, 503, { status: "database unreachable" });
    }
    return;
  }

  // Every request carries its own credential. The org is resolved here and
  // handed to a server instance built for this request alone, so no caller can
  // ever observe another tenant's board.
  const token = bearerToken(req.headers.authorization);
  if (token === null) {
    respond(res, 401, { error: "missing bearer token" });
    return;
  }

  const orgId = await resolveOrgId(db, token);
  if (orgId === null) {
    respond(res, 401, { error: "invalid or revoked key" });
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
});
