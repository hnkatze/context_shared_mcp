import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import pg from "pg";

const DATABASE_URL = "postgres://mcp_app:mcp@localhost:55432/context_shared";
const API_KEY = "ctx_dev_key";
const RIVAL_KEY = "ctx_rival_key";

const WHY =
  "The Swagger shows a plain string field, but the key is only unique within a " +
  "merchant and expires after 24h, so a retry the next day silently creates a " +
  "second order instead of returning the first one.";

const POOLER_WHY =
  "Nothing in the connection string says so, but a serverless instance must dial " +
  "the transaction pooler on 6543 and cap its pool at one, because many isolated " +
  "instances exhaust Postgres long before the traffic does.";

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

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function cardPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project: "checkout",
    module: "checkout",
    card_key: "idempotency-scope",
    summary: "Idempotency keys are scoped per merchant",
    why_not_obvious: WHY,
    decisions: [
      {
        choice: "Scope the key to the merchant",
        rejected: "Globally unique keys",
        reason: "Two merchants legitimately reuse the same client-generated id",
      },
    ],
    gotchas: ["A retry after 24h creates a second order"],
    consumer_notes: ["The FE must regenerate the key per attempt, not per session"],
    source_refs: [{ kind: "endpoint", ref: "POST /v1/orders" }],
    tags: ["idempotency", "orders"],
    author: "be-dev",
    ...overrides,
  };
}

function makeTransport(apiKey: string): StdioClientTransport {
  return new StdioClientTransport({
    command: process.execPath,
    args: ["dist/stdio.js"],
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
      CONTEXT_SHARED_DATABASE_URL: DATABASE_URL,
      CONTEXT_SHARED_API_KEY: apiKey,
    },
  });
}


/**
 * The suite asserts insert-versus-update and first-time project creation, so it
 * cannot inherit either from a previous run. Clearing through the same tenant
 * mechanism the server uses keeps the test honest about what an ordinary role may do.
 */
async function resetCards(): Promise<void> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  try {
    for (const key of [API_KEY, RIVAL_KEY]) {
      const resolved = await pool.query<{ org_id: string | null }>(
        "select app.resolve_api_key($1) as org_id",
        [key],
      );
      const orgId = resolved.rows[0]?.org_id;
      if (orgId === null || orgId === undefined) {
        throw new Error(`seed key ${key} did not resolve to an org; run scripts/dev-up.sh`);
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

async function main(): Promise<void> {
  await resetCards();

  const client = new Client({ name: "context-shared-e2e", version: "0.1.0" });
  const transport = makeTransport(API_KEY);

  await client.connect(transport);

  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  check(
    "exposes the four tools",
    names.join(",") === "list_projects,publish_context,search_context,usage_guide",
    `got: ${names.join(",")}`,
  );

  const projects = textOf(await client.callTool({ name: "list_projects", arguments: {} }));
  check(
    "list_projects shows the seeded projects",
    projects.includes("checkout") && projects.includes("billing"),
    projects,
  );

  const created = await client.callTool({
    name: "publish_context",
    arguments: cardPayload(),
  });
  check("publish creates a card", textOf(created).startsWith("Published"), textOf(created));

  const found = textOf(
    await client.callTool({
      name: "search_context",
      arguments: { query: "idempotency" },
    }),
  );
  check("search finds it by text", found.includes("scoped per merchant"), found);
  check("search renders the why first", found.includes("Why this is not obvious"));
  check("search renders the rejected alternative", found.includes("Globally unique keys"));

  const republished = await client.callTool({
    name: "publish_context",
    arguments: cardPayload({ summary: "Idempotency keys are scoped per merchant and expire in 24h" }),
  });
  check(
    "republishing the same key updates",
    textOf(republished).startsWith("Updated"),
    textOf(republished),
  );

  const afterUpdate = textOf(
    await client.callTool({ name: "search_context", arguments: { query: "idempotency" } }),
  );
  check(
    "republishing did not duplicate",
    occurrences(afterUpdate, "key: `idempotency-scope`") === 1,
    afterUpdate,
  );
  check("the update is visible", afterUpdate.includes("expire in 24h"), afterUpdate);

  // The reason the board exists: an agent asks in prose, not in boolean syntax.
  const naturalQuestion = textOf(
    await client.callTool({
      name: "search_context",
      arguments: { query: "how do idempotency keys behave when a request is retried" },
    }),
  );
  check(
    "a natural-language question finds the card",
    naturalQuestion.includes("idempotency-scope"),
    naturalQuestion,
  );

  const quotedPhrase = textOf(
    await client.callTool({
      name: "search_context",
      arguments: { query: "\"scoped per merchant\"" },
    }),
  );
  check("a quoted phrase still works", quotedPhrase.includes("idempotency-scope"), quotedPhrase);

  const byTag = textOf(
    await client.callTool({ name: "search_context", arguments: { tags: ["orders"] } }),
  );
  check("search by tag works", byTag.includes("scoped per merchant"), byTag);

  const empty = textOf(
    await client.callTool({ name: "search_context", arguments: { query: "nonexistentterm" } }),
  );
  check("empty search explains itself", empty.includes("No cards matched"), empty);

  const thin = await client.callTool({
    name: "publish_context",
    arguments: cardPayload({ card_key: "thin-card", why_not_obvious: "idk" }),
  });
  check("a thin why_not_obvious is rejected", thin.isError === true, textOf(thin));

  // ------------------------------------------ a project is a name, not a registration

  const newProject = await client.callTool({
    name: "publish_context",
    arguments: cardPayload({
      project: "BipBip BackOffice",
      module: "db",
      card_key: "pooler-limit",
      summary: "Serverless callers must dial the transaction pooler",
      why_not_obvious: POOLER_WHY,
      tags: ["db"],
    }),
  });
  check(
    "publishing under an unknown name creates the project",
    textOf(newProject).startsWith("Published") &&
      textOf(newProject).includes("bipbip-backoffice"),
    textOf(newProject),
  );

  const withNew = textOf(await client.callTool({ name: "list_projects", arguments: {} }));
  check(
    "the created project keeps the name as written",
    withNew.includes("`bipbip-backoffice` — BipBip BackOffice"),
    withNew,
  );

  const confusable = await client.callTool({
    name: "publish_context",
    arguments: cardPayload({
      project: "bipbipbackoffice",
      card_key: "typo-card",
      why_not_obvious: POOLER_WHY,
    }),
  });
  check(
    "a near-miss name is refused instead of forking the board",
    confusable.isError === true && textOf(confusable).includes("bipbip-backoffice"),
    textOf(confusable),
  );

  const afterRefusal = textOf(await client.callTool({ name: "list_projects", arguments: {} }));
  check(
    "the refused name created nothing",
    !afterRefusal.includes("`bipbipbackoffice`"),
    afterRefusal,
  );

  const forced = await client.callTool({
    name: "publish_context",
    arguments: cardPayload({
      project: "bipbipbackoffice",
      card_key: "typo-card",
      why_not_obvious: POOLER_WHY,
      create_project: true,
    }),
  });
  check(
    "create_project overrides the guard when the split is deliberate",
    textOf(forced).startsWith("Published"),
    textOf(forced),
  );

  const acrossProjects = textOf(
    await client.callTool({
      name: "search_context",
      arguments: { query: "pooler", limit: 50 },
    }),
  );
  check(
    "an unfiltered search reaches every project in the org",
    acrossProjects.includes("pooler-limit"),
    acrossProjects,
  );

  // ---------------------------------------------------------------- usage guide

  const guide = textOf(await client.callTool({ name: "usage_guide", arguments: {} }));
  check("usage_guide states the quality gate", guide.includes("why_not_obvious"), guide);
  check("usage_guide names the tools it documents", guide.includes("publish_context"), guide);

  const skill = textOf(
    await client.callTool({ name: "usage_guide", arguments: { as_skill: true } }),
  );
  check("usage_guide can emit a skill file", skill.startsWith("---\nname:"), skill);


  // ---------------------------------------------------------------- isolation

  // A second org, reached with its own API key through its own server process.
  const rival = new Client({ name: "context-shared-e2e-rival", version: "0.1.0" });
  await rival.connect(makeTransport(RIVAL_KEY));

  const rivalPublish = await rival.callTool({
    name: "publish_context",
    arguments: cardPayload({
      card_key: "rival-only-fact",
      summary: "Rival pricing tiers are resolved at checkout time",
      why_not_obvious:
        "This card belongs to another organization entirely and must never surface " +
        "in the first tenant's searches, no matter how the query is phrased.",
      tags: ["orders", "rival"],
    }),
  });
  check(
    "the second org can publish into its own checkout project",
    textOf(rivalPublish).startsWith("Published"),
    textOf(rivalPublish),
  );

  const rivalSees = textOf(
    await rival.callTool({ name: "search_context", arguments: { query: "rival" } }),
  );
  check("the second org sees its own card", rivalSees.includes("rival-only-fact"), rivalSees);

  const rivalLooksForOurs = textOf(
    await rival.callTool({ name: "search_context", arguments: { query: "idempotency" } }),
  );
  check(
    "the second org cannot read the first org's cards",
    !rivalLooksForOurs.includes("idempotency-scope"),
    rivalLooksForOurs,
  );

  const weLookForTheirs = textOf(
    await client.callTool({ name: "search_context", arguments: { query: "rival" } }),
  );
  check(
    "the first org cannot read the second org's cards",
    !weLookForTheirs.includes("rival-only-fact"),
    weLookForTheirs,
  );

  const broadSweep = textOf(
    await client.callTool({ name: "search_context", arguments: { tags: ["orders"], limit: 50 } }),
  );
  check(
    "a broad tag sweep stays inside the tenant",
    broadSweep.includes("idempotency-scope") && !broadSweep.includes("rival-only-fact"),
    broadSweep,
  );

  const rivalProjects = textOf(
    await rival.callTool({ name: "list_projects", arguments: {} }),
  );
  check(
    "project listing is tenant scoped",
    rivalProjects.includes("checkout") && !rivalProjects.includes("billing"),
    rivalProjects,
  );

  await rival.close();
  await client.close();

  console.log(failures === 0 ? "\nALL MCP E2E TESTS PASSED" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
