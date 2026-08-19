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

const WINDOW_CHANGE =
  "The idempotency key used to survive 24h. It now expires after 60 minutes, and a " +
  "key reused past that point creates a second order instead of returning the first.";

/**
 * Deliberately anchored to the same endpoint the card names, and only in
 * source_refs: neither the title nor the prose repeats the route, so a search
 * that finds this note proves the ref reached the index rather than the title.
 */
function changePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project: "checkout",
    module: "orders",
    change_key: "idempotency-window-2026-08",
    title: "The idempotency window on the order-creation endpoint dropped to 1h",
    what_changed: WINDOW_CHANGE,
    why: "The 24h window held merchant keys long enough to collide during batch replays",
    impact: "Any caller that retries an order more than an hour after the first attempt",
    do_this: ["Regenerate the idempotency key per attempt, not per session"],
    do_not: ["Do not reuse a stale key to check whether an order already exists"],
    test_cases: [
      {
        scenario: "Retry with the same key after 61 minutes",
        expected: "A second order is created, not the original returned",
      },
    ],
    source_refs: [
      { kind: "pr", ref: "https://github.com/acme/api/pull/412" },
      { kind: "endpoint", ref: "POST /v1/orders" },
    ],
    supersedes_cards: ["idempotency-scope"],
    tags: ["orders", "idempotency"],
    author: "gustavo",
    occurred_at: "2026-08-14",
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
        await client.query("delete from change_notes");
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
    "exposes the six tools",
    names.join(",") ===
      "list_projects,publish_change,publish_context,recent_changes,search_context,usage_guide",
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
  check(
    "empty search explains itself",
    empty.includes("Nothing on the board matched"),
    empty,
  );

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

  // ------------------------------------------------- change notes: what someone shipped

  const changePublished = await client.callTool({
    name: "publish_change",
    arguments: changePayload(),
  });
  check(
    "publish_change creates a note and reports what it made stale",
    textOf(changePublished).startsWith("Published change") &&
      textOf(changePublished).includes("idempotency-scope"),
    textOf(changePublished),
  );

  const unanchored = await client.callTool({
    name: "publish_change",
    arguments: changePayload({ change_key: "unanchored-note", source_refs: [] }),
  });
  check(
    "a change note with no source_refs is refused",
    unanchored.isError === true,
    textOf(unanchored),
  );

  // The question the board exists to answer: what happened to an endpoint I
  // consume. Neither entry names the route anywhere but in source_refs, so this
  // fails the moment the index fix is reverted.
  const byEndpoint = textOf(
    await client.callTool({
      name: "search_context",
      arguments: { query: "POST /v1/orders", limit: 50 },
    }),
  );
  check(
    "an endpoint named only in source_refs finds the change note",
    byEndpoint.includes("change: `idempotency-window-2026-08`"),
    byEndpoint,
  );
  check(
    "and finds the card that names the same endpoint",
    byEndpoint.includes("key: `idempotency-scope`"),
    byEndpoint,
  );
  check(
    "changes are rendered above cards",
    byEndpoint.indexOf("# Changes") < byEndpoint.indexOf("# Cards"),
    byEndpoint,
  );
  check("the note carries what not to do", byEndpoint.includes("**Do not**"), byEndpoint);
  check(
    "the note carries its test cases",
    byEndpoint.includes("Retry with the same key after 61 minutes"),
    byEndpoint,
  );
  check(
    "the note names the card it made stale",
    byEndpoint.includes("Supersedes cards"),
    byEndpoint,
  );

  const changesOnly = textOf(
    await client.callTool({
      name: "search_context",
      arguments: { query: "idempotency", kind: "change", limit: 50 },
    }),
  );
  check(
    "kind narrows the sweep to change notes",
    changesOnly.includes("change: `idempotency-window-2026-08`") &&
      !changesOnly.includes("# Cards"),
    changesOnly,
  );

  const cardsOnly = textOf(
    await client.callTool({
      name: "search_context",
      arguments: { query: "idempotency", kind: "card", limit: 50 },
    }),
  );
  check(
    "kind narrows the sweep to cards",
    cardsOnly.includes("key: `idempotency-scope`") && !cardsOnly.includes("# Changes"),
    cardsOnly,
  );

  // ------------------------------------------------------------------------ the feed

  const newer = await client.callTool({
    name: "publish_change",
    arguments: changePayload({
      change_key: "order-status-enum-2026-08",
      title: "A fifth value joined the order status enum",
      what_changed: 'status can now be "held", between "pending" and "paid"',
      why: "Manual review for flagged merchants needed a state of its own",
      source_refs: [{ kind: "commit", ref: "9f2c1ab" }],
      supersedes_cards: [],
      occurred_at: "2026-08-17",
    }),
  });
  check(
    "a later change to the same module is a second note, not an edit",
    textOf(newer).startsWith("Published change"),
    textOf(newer),
  );

  const feed = textOf(
    await client.callTool({ name: "recent_changes", arguments: { limit: 50 } }),
  );
  check(
    "the feed is newest first",
    feed.indexOf("order-status-enum-2026-08") < feed.indexOf("idempotency-window-2026-08"),
    feed,
  );

  const sinceFilter = textOf(
    await client.callTool({
      name: "recent_changes",
      arguments: { since: "2026-08-16", limit: 50 },
    }),
  );
  check(
    "since drops what happened before it",
    sinceFilter.includes("order-status-enum-2026-08") &&
      !sinceFilter.includes("idempotency-window-2026-08"),
    sinceFilter,
  );

  // ------------------------------------------------------- correcting, not overwriting

  const withoutDate = changePayload();
  delete withoutDate["occurred_at"];
  const corrected = await client.callTool({
    name: "publish_change",
    arguments: {
      ...withoutDate,
      what_changed: "Corrected: the window runs from first receipt, not from response",
    },
  });
  check(
    "republishing a change_key corrects the note",
    textOf(corrected).startsWith("Updated change"),
    textOf(corrected),
  );

  const afterCorrection = textOf(
    await client.callTool({ name: "recent_changes", arguments: { limit: 50 } }),
  );
  check(
    "correcting a note did not duplicate it",
    occurrences(afterCorrection, "change: `idempotency-window-2026-08`") === 1,
    afterCorrection,
  );
  check(
    "the correction is visible",
    afterCorrection.includes("from first receipt"),
    afterCorrection,
  );
  check(
    "correcting a note left the date the change landed alone",
    afterCorrection.includes("happened 2026-08-14"),
    afterCorrection,
  );

  const counted = textOf(await client.callTool({ name: "list_projects", arguments: {} }));
  check(
    "list_projects counts changes beside cards",
    /`checkout` — Checkout \(\d+ cards, 2 changes\)/.test(counted),
    counted,
  );

  // ---------------------------------------------------------------- usage guide

  const guide = textOf(await client.callTool({ name: "usage_guide", arguments: {} }));
  check("usage_guide states the card quality gate", guide.includes("why_not_obvious"), guide);
  check(
    "usage_guide states the change note gate",
    guide.includes("source_refs") && guide.includes("rumour"),
    guide,
  );
  check(
    "usage_guide names the tools it documents",
    guide.includes("publish_context") &&
      guide.includes("publish_change") &&
      guide.includes("recent_changes"),
    guide,
  );

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

  const rivalFeed = textOf(
    await rival.callTool({ name: "recent_changes", arguments: { limit: 50 } }),
  );
  check(
    "the second org's feed holds none of the first org's changes",
    !rivalFeed.includes("idempotency-window-2026-08"),
    rivalFeed,
  );

  const rivalSearchesChanges = textOf(
    await rival.callTool({
      name: "search_context",
      arguments: { query: "POST /v1/orders", kind: "change", limit: 50 },
    }),
  );
  check(
    "change notes do not cross the tenant boundary on search either",
    !rivalSearchesChanges.includes("idempotency-window-2026-08"),
    rivalSearchesChanges,
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
