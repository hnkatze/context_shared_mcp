import type { PoolClient } from "pg";

import { looseQuery } from "../fts.js";
import { resolveProject } from "../projects.js";
import type { SourceRef } from "../refs.js";
import type { SearchInput } from "../search.js";
import type { PublishChangeInput, RecentChangesInput } from "./schema.js";

export type TestCase = {
  readonly scenario: string;
  readonly expected: string;
};

export type ChangeNote = {
  readonly changeKey: string;
  readonly project: string;
  readonly module: string;
  readonly title: string;
  readonly whatChanged: string;
  readonly why: string;
  readonly impact: string | null;
  readonly doThis: readonly string[];
  readonly doNot: readonly string[];
  readonly testCases: readonly TestCase[];
  readonly sourceRefs: readonly SourceRef[];
  readonly supersedesCards: readonly string[];
  readonly tags: readonly string[];
  readonly author: string;
  readonly occurredAt: string;
  readonly updatedAt: string;
};

export type PublishChangeResult = {
  readonly changeKey: string;
  readonly created: boolean;
  readonly project: string;
  readonly projectCreated: boolean;
  readonly supersededCards: readonly string[];
};

export async function publishChange(
  client: PoolClient,
  orgId: string,
  input: PublishChangeInput,
): Promise<PublishChangeResult> {
  const project = await resolveProject(client, orgId, input.project, input.create_project);

  // xmax is zero on a freshly inserted row, so it distinguishes an insert from
  // an update without a second round trip.
  const result = await client.query<{ change_key: string; created: boolean }>(
    `insert into change_notes (
       org_id, project_id, module, change_key, title, what_changed, why, impact,
       do_this, do_not, test_cases, source_refs, supersedes_cards, tags, author,
       occurred_at
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8,
       $9, $10, $11::jsonb, $12::jsonb, $13, $14, $15,
       coalesce($16::timestamptz, now())
     )
     on conflict (project_id, change_key) do update set
       module           = excluded.module,
       title            = excluded.title,
       what_changed     = excluded.what_changed,
       why              = excluded.why,
       impact           = excluded.impact,
       do_this          = excluded.do_this,
       do_not           = excluded.do_not,
       test_cases       = excluded.test_cases,
       source_refs      = excluded.source_refs,
       supersedes_cards = excluded.supersedes_cards,
       tags             = excluded.tags,
       author           = excluded.author,
       -- The parameter is read again rather than taken from excluded, which
       -- already carries now() from the coalesce above. Correcting the wording
       -- of a note must not move the date the change actually landed.
       occurred_at      = coalesce($16::timestamptz, change_notes.occurred_at)
     returning change_key, (xmax = 0) as created`,
    [
      orgId,
      project.id,
      input.module,
      input.change_key,
      input.title,
      input.what_changed,
      input.why,
      input.impact ?? null,
      input.do_this,
      input.do_not,
      JSON.stringify(input.test_cases),
      JSON.stringify(input.source_refs),
      input.supersedes_cards,
      input.tags,
      input.author,
      input.occurred_at ?? null,
    ],
  );

  const row = result.rows[0];
  if (row === undefined) throw new Error("publish change returned no row");
  return {
    changeKey: row.change_key,
    created: row.created,
    project: project.slug,
    projectCreated: project.created,
    supersededCards: input.supersedes_cards,
  };
}

type ChangeRow = {
  change_key: string;
  project: string;
  module: string;
  title: string;
  what_changed: string;
  why: string;
  impact: string | null;
  do_this: readonly string[];
  do_not: readonly string[];
  test_cases: readonly TestCase[];
  source_refs: readonly SourceRef[];
  supersedes_cards: readonly string[];
  tags: readonly string[];
  author: string;
  occurred_at: Date;
  updated_at: Date;
};

const SELECT_COLUMNS = `
  select n.change_key, p.slug as project, n.module, n.title, n.what_changed, n.why,
         n.impact, n.do_this, n.do_not, n.test_cases, n.source_refs,
         n.supersedes_cards, n.tags, n.author, n.occurred_at, n.updated_at
    from change_notes n
    join projects p on p.id = n.project_id`;

function toChangeNote(row: ChangeRow): ChangeNote {
  return {
    changeKey: row.change_key,
    project: row.project,
    module: row.module,
    title: row.title,
    whatChanged: row.what_changed,
    why: row.why,
    impact: row.impact,
    doThis: row.do_this,
    doNot: row.do_not,
    testCases: row.test_cases,
    sourceRefs: row.source_refs,
    supersedesCards: row.supersedes_cards,
    tags: row.tags,
    author: row.author,
    occurredAt: row.occurred_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function runSearch(
  client: PoolClient,
  input: SearchInput,
  queryText: string | null,
  loose: boolean,
): Promise<readonly ChangeNote[]> {
  const result = await client.query<ChangeRow>(
    `${SELECT_COLUMNS}
      where ($1::text is null or p.slug = $1)
        and ($2::text is null or n.module = $2)
        and ($3::text[] is null or n.tags && $3)
        and ($4::text is null
             or n.search_vector @@ (case when $6::bool then to_tsquery('simple', $4) else websearch_to_tsquery('simple', $4) end))
      order by case
                 when $4::text is null then 0
                 else ts_rank(n.search_vector, (case when $6::bool then to_tsquery('simple', $4) else websearch_to_tsquery('simple', $4) end))
               end desc,
               n.occurred_at desc
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
  return result.rows.map(toChangeNote);
}

export async function searchChanges(
  client: PoolClient,
  input: SearchInput,
): Promise<readonly ChangeNote[]> {
  const strict = await runSearch(client, input, input.query ?? null, false);
  if (strict.length > 0 || input.query === undefined) return strict;

  const loose = looseQuery(input.query);
  if (loose === null) return strict;
  return runSearch(client, input, loose, true);
}

/**
 * The feed. This is what a reader calls when they know something moved but not
 * what to search for, which is the state everybody is in the morning after
 * somebody else's deploy.
 */
export async function recentChanges(
  client: PoolClient,
  input: RecentChangesInput,
): Promise<readonly ChangeNote[]> {
  const result = await client.query<ChangeRow>(
    `${SELECT_COLUMNS}
      where ($1::text is null or p.slug = $1)
        and ($2::text is null or n.module = $2)
        and ($3::timestamptz is null or n.occurred_at >= $3)
      order by n.occurred_at desc
      limit $4`,
    [input.project ?? null, input.module ?? null, input.since ?? null, input.limit],
  );
  return result.rows.map(toChangeNote);
}
