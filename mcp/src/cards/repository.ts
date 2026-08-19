import type { PoolClient } from "pg";

import { looseQuery } from "../fts.js";
import { resolveProject } from "../projects.js";
import type { SourceRef } from "../refs.js";
import type { SearchInput } from "../search.js";
import type { PublishInput } from "./schema.js";

export type Decision = {
  readonly choice: string;
  readonly rejected: string;
  readonly reason: string;
};

export type Card = {
  readonly cardKey: string;
  readonly project: string;
  readonly module: string;
  readonly summary: string;
  readonly whyNotObvious: string;
  readonly decisions: readonly Decision[];
  readonly gotchas: readonly string[];
  readonly consumerNotes: readonly string[];
  readonly sourceRefs: readonly SourceRef[];
  readonly tags: readonly string[];
  readonly author: string;
  readonly updatedAt: string;
};

export type PublishResult = {
  readonly cardKey: string;
  readonly created: boolean;
  readonly project: string;
  readonly projectCreated: boolean;
};

export async function publishCard(
  client: PoolClient,
  orgId: string,
  input: PublishInput,
): Promise<PublishResult> {
  const project = await resolveProject(client, orgId, input.project, input.create_project);
  const projectId = project.id;

  // xmax is zero on a freshly inserted row, so it distinguishes an insert from
  // an update without a second round trip.
  const result = await client.query<{ card_key: string; created: boolean }>(
    `insert into cards (
       org_id, project_id, module, card_key, summary, why_not_obvious,
       decisions, gotchas, consumer_notes, source_refs, tags, author
     ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb, $11, $12)
     on conflict (project_id, card_key) do update set
       module          = excluded.module,
       summary         = excluded.summary,
       why_not_obvious = excluded.why_not_obvious,
       decisions       = excluded.decisions,
       gotchas         = excluded.gotchas,
       consumer_notes  = excluded.consumer_notes,
       source_refs     = excluded.source_refs,
       tags            = excluded.tags,
       author          = excluded.author
     returning card_key, (xmax = 0) as created`,
    [
      orgId,
      projectId,
      input.module,
      input.card_key,
      input.summary,
      input.why_not_obvious,
      JSON.stringify(input.decisions),
      input.gotchas,
      input.consumer_notes,
      JSON.stringify(input.source_refs),
      input.tags,
      input.author,
    ],
  );

  const row = result.rows[0];
  if (row === undefined) throw new Error("publish returned no row");
  return {
    cardKey: row.card_key,
    created: row.created,
    project: project.slug,
    projectCreated: project.created,
  };
}

type CardRow = {
  card_key: string;
  project: string;
  module: string;
  summary: string;
  why_not_obvious: string;
  decisions: readonly Decision[];
  gotchas: readonly string[];
  consumer_notes: readonly string[];
  source_refs: readonly SourceRef[];
  tags: readonly string[];
  author: string;
  updated_at: Date;
};

async function runSearch(
  client: PoolClient,
  input: SearchInput,
  queryText: string | null,
  loose: boolean,
): Promise<readonly Card[]> {
  const result = await client.query<CardRow>(
    `select c.card_key, p.slug as project, c.module, c.summary, c.why_not_obvious,
            c.decisions, c.gotchas, c.consumer_notes, c.source_refs, c.tags,
            c.author, c.updated_at
       from cards c
       join projects p on p.id = c.project_id
      where ($1::text is null or p.slug = $1)
        and ($2::text is null or c.module = $2)
        and ($3::text[] is null or c.tags && $3)
        and ($4::text is null
             or c.search_vector @@ (case when $6::bool then to_tsquery('simple', $4) else websearch_to_tsquery('simple', $4) end))
      order by case
                 when $4::text is null then 0
                 else ts_rank(c.search_vector, (case when $6::bool then to_tsquery('simple', $4) else websearch_to_tsquery('simple', $4) end))
               end desc,
               c.updated_at desc
      limit $5`,
    [
      input.project ?? null,
      input.module ?? null,
      input.tags ?? null,
      queryText,
      input.limit,
      loose,
    ],
  );

  return result.rows.map((row) => ({
    cardKey: row.card_key,
    project: row.project,
    module: row.module,
    summary: row.summary,
    whyNotObvious: row.why_not_obvious,
    decisions: row.decisions,
    gotchas: row.gotchas,
    consumerNotes: row.consumer_notes,
    sourceRefs: row.source_refs,
    tags: row.tags,
    author: row.author,
    updatedAt: row.updated_at.toISOString(),
  }));
}

export async function searchCards(
  client: PoolClient,
  input: SearchInput,
): Promise<readonly Card[]> {
  const strict = await runSearch(client, input, input.query ?? null, false);
  if (strict.length > 0 || input.query === undefined) return strict;

  const loose = looseQuery(input.query);
  if (loose === null) return strict;
  return runSearch(client, input, loose, true);
}
