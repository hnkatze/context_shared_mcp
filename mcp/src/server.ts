import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { publishCard, searchCards } from "./cards/repository.js";
import { publishInputSchema } from "./cards/schema.js";
import { formatChanges } from "./changes/format.js";
import { publishChange, recentChanges, searchChanges } from "./changes/repository.js";
import { publishChangeInputSchema, recentChangesInputSchema } from "./changes/schema.js";
import type { Db } from "./db/pool.js";
import { withTenant } from "./db/pool.js";
import { SKILL_DOC, USAGE_GUIDE } from "./guide.js";
import {
  ConfusableProjectError,
  formatProjects,
  listProjects,
  UnusableProjectNameError,
} from "./projects.js";
import { formatResults, searchInputSchema } from "./search.js";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function fail(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The two refusals a publisher can act on; anything else is a real failure. */
function describePublishError(error: unknown): string {
  if (error instanceof ConfusableProjectError) return error.message;
  if (error instanceof UnusableProjectNameError) return error.message;
  return describe(error);
}

/**
 * The org is bound at construction, never read from shared state. Over HTTP one
 * instance serves exactly one caller's request, so a cached org would hand the
 * first caller's tenant to everyone after them.
 */
export function createContextServer(db: Db, orgId: string): McpServer {
  const server = new McpServer({ name: "context-shared", version: "0.2.0" });

  server.registerTool(
    "list_projects",
    {
      description:
        "List the projects in this organization, with how many context cards and how " +
        "many change notes each holds. Call this before publishing to see which names " +
        "are already in use.",
      inputSchema: z.object({}),
    },
    async (): Promise<ToolResult> => {
      try {
        return ok(formatProjects(await withTenant(db, orgId, listProjects)));
      } catch (error) {
        return fail(describe(error));
      }
    },
  );

  server.registerTool(
    "publish_context",
    {
      description:
        "Publish a context card: what a consumer of this module cannot learn from the " +
        "code or the OpenAPI spec. This is for a durable fact about how the module " +
        "behaves. To record something that just changed, use publish_change instead. " +
        "Republishing the same card_key updates the card rather than creating a " +
        "duplicate. The project is created on first use.",
      inputSchema: publishInputSchema,
    },
    async (input): Promise<ToolResult> => {
      try {
        const result = await withTenant(db, orgId, (client) =>
          publishCard(client, orgId, input),
        );
        const verb = result.created ? "Published" : "Updated";
        const note = result.projectCreated
          ? ` New project on the board: \`${result.project}\`.`
          : "";
        return ok(
          `${verb} \`${result.cardKey}\` in ${result.project}/${input.module}.${note}`,
        );
      } catch (error) {
        return fail(describePublishError(error));
      }
    },
  );

  server.registerTool(
    "publish_change",
    {
      description:
        "Publish a change note: something you changed, when it landed, and what the " +
        "people who consume it must do and must not do about it. This is the tool for " +
        "'I shipped X, here is what my teammates need to know' — including the test " +
        "cases that prove it works. At least one source_ref is required. Republishing " +
        "the same change_key corrects the note; a later change is a new key.",
      inputSchema: publishChangeInputSchema,
    },
    async (input): Promise<ToolResult> => {
      try {
        const result = await withTenant(db, orgId, (client) =>
          publishChange(client, orgId, input),
        );
        const verb = result.created ? "Published" : "Updated";
        const projectNote = result.projectCreated
          ? ` New project on the board: \`${result.project}\`.`
          : "";
        const staleNote =
          result.supersededCards.length > 0
            ? ` Marked stale: ${result.supersededCards.map((k) => `\`${k}\``).join(", ")}.`
            : "";
        return ok(
          `${verb} change \`${result.changeKey}\` in ` +
            `${result.project}/${input.module}.${projectNote}${staleNote}`,
        );
      } catch (error) {
        return fail(describePublishError(error));
      }
    },
  );

  server.registerTool(
    "search_context",
    {
      description:
        "Search the shared board — cards and change notes together. Use it before " +
        "asking a teammate how a module behaves, before assuming an OpenAPI spec tells " +
        "the whole story, and to find out what somebody changed. Ask in plain prose. " +
        "Omitting project sweeps every project in the organization.",
      inputSchema: searchInputSchema,
    },
    async (input): Promise<ToolResult> => {
      try {
        const results = await withTenant(db, orgId, async (client) => ({
          cards: input.kind === "change" ? [] : await searchCards(client, input),
          changes: input.kind === "card" ? [] : await searchChanges(client, input),
        }));
        return ok(formatResults(results.cards, results.changes));
      } catch (error) {
        return fail(describe(error));
      }
    },
  );

  server.registerTool(
    "recent_changes",
    {
      description:
        "The feed: what changed lately, newest first. Call this when you know somebody " +
        "touched something but not what to search for — after a deploy, before picking " +
        "up work on a module a teammate has been in, or when returning from time off.",
      inputSchema: recentChangesInputSchema,
    },
    async (input): Promise<ToolResult> => {
      try {
        const changes = await withTenant(db, orgId, (client) =>
          recentChanges(client, input),
        );
        return ok(formatChanges(changes));
      } catch (error) {
        return fail(describe(error));
      }
    },
  );

  server.registerTool(
    "usage_guide",
    {
      description:
        "How this board expects to be used: when to publish a card and when a change " +
        "note, what clears each quality gate, how a project gets named, and how to " +
        "search before asking a teammate. Read it once per session, before the first " +
        "publish.",
      inputSchema: z.object({
        as_skill: z
          .boolean()
          .default(false)
          .describe("Return the guide as a SKILL.md file, ready to drop into an agent"),
      }),
    },
    (input): ToolResult => ok(input.as_skill ? SKILL_DOC : USAGE_GUIDE),
  );

  return server;
}
