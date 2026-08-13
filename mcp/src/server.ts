import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { Db } from "./db/pool.js";
import { withTenant } from "./db/pool.js";
import { formatCards, formatProjects } from "./cards/format.js";
import { SKILL_DOC, USAGE_GUIDE } from "./cards/guide.js";
import {
  ConfusableProjectError,
  listProjects,
  publishCard,
  searchCards,
  UnusableProjectNameError,
} from "./cards/repository.js";
import { publishInputSchema, searchInputSchema } from "./cards/schema.js";

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

/**
 * The org is bound at construction, never read from shared state. Over HTTP one
 * instance serves exactly one caller's request, so a cached org would hand the
 * first caller's tenant to everyone after them.
 */
export function createContextServer(db: Db, orgId: string): McpServer {
  const server = new McpServer({ name: "context-shared", version: "0.1.0" });

  server.registerTool(
    "list_projects",
    {
      description:
        "List the projects in this organization and how many context cards each holds. " +
        "Call this before publishing to see which names are already in use.",
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
        "code or the OpenAPI spec. Republishing the same card_key updates the card " +
        "instead of creating a duplicate. The project is created on first use, so " +
        "nothing has to be registered before publishing into it.",
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
        if (error instanceof ConfusableProjectError) return fail(error.message);
        if (error instanceof UnusableProjectNameError) return fail(error.message);
        return fail(describe(error));
      }
    },
  );

  server.registerTool(
    "search_context",
    {
      description:
        "Search the shared context board. Use it before asking a teammate how a module " +
        "behaves, and before assuming an OpenAPI spec tells the whole story. Omitting " +
        "project sweeps every project in the organization.",
      inputSchema: searchInputSchema,
    },
    async (input): Promise<ToolResult> => {
      try {
        const cards = await withTenant(db, orgId, (client) => searchCards(client, input));
        return ok(formatCards(cards));
      } catch (error) {
        return fail(describe(error));
      }
    },
  );

  server.registerTool(
    "usage_guide",
    {
      description:
        "How this board expects to be used: when to publish, what clears the quality " +
        "gate, how a project gets named, and how to search before asking a teammate. " +
        "Read it once per session, before the first publish.",
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
