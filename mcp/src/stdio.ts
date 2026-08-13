import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { loadConfig } from "./config.js";
import { createPool, resolveOrgId } from "./db/pool.js";
import { createContextServer } from "./server.js";

/**
 * Local transport: one process serves one developer, so the org is resolved
 * once at startup. A revoked key must stop the server, not degrade it.
 */
const config = loadConfig(process.env);
const db = createPool(config.databaseUrl);

const orgId = await resolveOrgId(db, config.apiKey);
if (orgId === null) {
  throw new Error("CONTEXT_SHARED_API_KEY is not a valid or active key");
}

serveStdio(() => createContextServer(db, orgId));
