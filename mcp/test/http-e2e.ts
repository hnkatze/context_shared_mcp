import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import pg from "pg";

const DATABASE_URL = "postgres://mcp_app:mcp@localhost:55432/context_shared";
const DEV_KEY = "ctx_dev_key";
const RIVAL_KEY = "ctx_rival_key";
const PORT = 4399;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;

function check(name: string, passed: boolean, detail?: string): void {
  if (passed) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? "" : `\n       ${detail}`}`);
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

async function resetCards(): Promise<void> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  try {
    for (const key of [DEV_KEY, RIVAL_KEY]) {
      const resolved = await pool.query<{ org_id: string | null }>(
        "select app.resolve_api_key($1) as org_id",
        [key],
      );
      const orgId = resolved.rows[0]?.org_id;
      if (orgId === null || orgId === undefined) {
        throw new Error(`seed key ${key} did not resolve; run scripts/dev-up.sh`);
      }
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("select set_config('app.current_org_id', $1, true)", [orgId]);
        await client.query("delete from cards");
        await client.query("delete from projects where slug not in ('checkout', 'billing')");
        await client.query("commit");
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
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

function connect(apiKey: string): Promise<Client> {
  const client = new Client({ name: `http-e2e-${apiKey}`, version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
  });
  return client.connect(transport).then(() => client);
}

function card(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    project: "checkout",
    module: "checkout",
    summary: "placeholder",
    why_not_obvious:
      "A card long enough to clear the database quality gate, published only so " +
      "the isolation assertions below have something concrete to look for.",
    author: "e2e",
    tags: ["orders"],
    ...overrides,
  };
}

async function main(): Promise<void> {
  await resetCards();

  const child = spawn(process.execPath, ["dist/http.js"], {
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
      CONTEXT_SHARED_DATABASE_URL: DATABASE_URL,
      PORT: String(PORT),
    },
    stdio: "ignore",
  });

  try {
    check("server becomes healthy", await waitForHealth(40));

    const anonymous = await fetch(`${BASE}/mcp`, { method: "POST" });
    check("no token is rejected", anonymous.status === 401, `got ${anonymous.status}`);

    const bogus = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer not-a-real-key" },
    });
    check("an unknown token is rejected", bogus.status === 401, `got ${bogus.status}`);

    const dev = await connect(DEV_KEY);
    const rival = await connect(RIVAL_KEY);

    const devPublish = await dev.callTool({
      name: "publish_context",
      arguments: card({ card_key: "dev-only-fact", summary: "Dev org fact about retries" }),
    });
    check("first tenant publishes", textOf(devPublish).startsWith("Published"), textOf(devPublish));

    const rivalPublish = await rival.callTool({
      name: "publish_context",
      arguments: card({ card_key: "rival-only-fact", summary: "Rival org fact about pricing" }),
    });
    check(
      "second tenant publishes",
      textOf(rivalPublish).startsWith("Published"),
      textOf(rivalPublish),
    );

    // The point of the whole exercise: one process, two callers, no bleed.
    const devSees = textOf(await dev.callTool({ name: "search_context", arguments: { limit: 50 } }));
    check("first tenant sees its own card", devSees.includes("dev-only-fact"), devSees);
    check("first tenant cannot see the second's", !devSees.includes("rival-only-fact"), devSees);

    const rivalSees = textOf(
      await rival.callTool({ name: "search_context", arguments: { limit: 50 } }),
    );
    check("second tenant sees its own card", rivalSees.includes("rival-only-fact"), rivalSees);
    check("second tenant cannot see the first's", !rivalSees.includes("dev-only-fact"), rivalSees);

    // Re-query the first client after the second one connected: a cached org
    // would have been overwritten by whoever connected last.
    const devAgain = textOf(
      await dev.callTool({ name: "search_context", arguments: { limit: 50 } }),
    );
    check(
      "the first tenant is unchanged after the second connects",
      devAgain.includes("dev-only-fact") && !devAgain.includes("rival-only-fact"),
      devAgain,
    );

    await dev.close();
    await rival.close();
  } finally {
    child.kill();
  }

  console.log(failures === 0 ? "\nALL HTTP E2E TESTS PASSED" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
