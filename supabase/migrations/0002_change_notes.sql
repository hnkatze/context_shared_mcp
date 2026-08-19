-- context_shared 0002: change notes, and a search index that can find them.
--
-- A card states a durable fact about a module and is rewritten in place when
-- that fact moves. The same upsert that keeps the board free of duplicates
-- also erases history, which makes a card the wrong shape for "Gustavo changed
-- this endpoint yesterday": by the time a second change lands, the first one
-- is gone.
--
-- A change note is the other half. It is dated, it is anchored to something
-- verifiable, and it never has to describe the whole module — so it can carry
-- what a card must refuse: what a reader has to do, what they must not, and
-- how to prove it works.

-- ---------------------------------------------------------------- jsonb search

-- Pulls the chosen keys out of a jsonb array of objects, so prose buried in
-- source_refs, decisions and test_cases reaches the search index.
--
-- Two deliberate choices. The keys are named by the caller rather than
-- flattened wholesale, because indexing every value would put the literal words
-- "commit", "pr" and "endpoint" on nearly every row, and a search for
-- "endpoint" would then match the entire board. And the language is PL/pgSQL
-- rather than SQL because a single-statement SQL function is a candidate for
-- inlining, which would push a subquery into the generated-column expression
-- that calls it — and a generated column may not contain a subquery.
create or replace function app.jsonb_values(doc jsonb, keys text[])
returns text
language plpgsql
immutable
parallel safe
as $fn$
declare
  result text;
begin
  select coalesce(string_agg(entry.value, ' '), '')
    into result
    from jsonb_array_elements(coalesce(doc, '[]'::jsonb)) as element,
         lateral jsonb_each_text(element.value) as entry(key, value)
   where entry.key = any(keys);
  return result;
end
$fn$;

-- ---------------------------------------------------------------- cards backfill

-- cards.search_vector reached neither source_refs nor decisions, so the most
-- natural question a reader has — "what do we know about POST /v1/orders" —
-- returned nothing even when a card named exactly that route, and the reason an
-- alternative lost became unsearchable the moment it was written down.
--
-- A generated column cannot be altered in place, and dropping it takes its
-- index with it, so both are rebuilt.
--
-- Operationally this is the expensive statement in the file: it rewrites the
-- whole table under an ACCESS EXCLUSIVE lock and then rebuilds a GIN index over
-- every row. On a board of a few thousand cards that is a blink; if this ever
-- runs against a large one, run it in its own window rather than behind a
-- deploy that expects to be instant.
alter table cards drop column search_vector;

alter table cards add column search_vector tsvector generated always as (
  to_tsvector('simple',
    coalesce(module, '') || ' ' ||
    coalesce(summary, '') || ' ' ||
    coalesce(why_not_obvious, '') || ' ' ||
    app.join_text(gotchas) || ' ' ||
    app.join_text(consumer_notes) || ' ' ||
    app.join_text(tags) || ' ' ||
    app.jsonb_values(decisions, '{choice,rejected,reason}') || ' ' ||
    app.jsonb_values(source_refs, '{ref}')
  )
) stored;

create index cards_search_idx on cards using gin (search_vector);

-- ---------------------------------------------------------------- change notes

create table change_notes (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  project_id  uuid not null,

  module      text not null,

  -- Stable slug for this change, so a draft can be corrected without leaving
  -- two accounts of the same event on the board.
  change_key  text not null check (change_key ~ '^[a-z0-9][a-z0-9-]{1,62}$'),

  title        text not null,
  what_changed text not null,
  why          text not null,

  -- Who this breaks, and how. Optional on purpose: plenty of changes break
  -- nobody, and a required field would only teach publishers to write "none".
  impact       text,

  do_this  text[] not null default '{}',
  do_not   text[] not null default '{}',

  -- [{ "scenario": ..., "expected": ... }]
  test_cases jsonb not null default '[]'::jsonb,

  -- The gate, and the mirror of why_not_obvious on cards. A card with nothing
  -- non-obvious to say is noise; a change note with nothing verifiable behind
  -- it is a rumour, and a reader six weeks later cannot tell one from the
  -- other. No default on purpose: an empty array has to fail rather than be
  -- silently supplied.
  source_refs jsonb not null check (jsonb_array_length(source_refs) >= 1),

  -- card_keys this change made stale. Named rather than joined: the card may
  -- sit in another project, and a name that no longer resolves is more honest
  -- than a cascade that quietly deletes the pointer to it.
  supersedes_cards text[] not null default '{}',

  tags   text[] not null default '{}',
  author text not null,

  -- When the change happened, which is not when somebody got around to writing
  -- it down. Ordering a feed by created_at puts a note written late on top of
  -- the changes that actually came after it.
  occurred_at timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- Same 'simple' configuration as cards, for the same reason: notes mix
  -- Spanish and English, and stemming for the wrong language is worse than not
  -- stemming at all.
  search_vector tsvector generated always as (
    to_tsvector('simple',
      coalesce(module, '') || ' ' ||
      coalesce(title, '') || ' ' ||
      coalesce(what_changed, '') || ' ' ||
      coalesce(why, '') || ' ' ||
      coalesce(impact, '') || ' ' ||
      app.join_text(do_this) || ' ' ||
      app.join_text(do_not) || ' ' ||
      app.join_text(tags) || ' ' ||
      app.jsonb_values(test_cases, '{scenario,expected}') || ' ' ||
      app.jsonb_values(source_refs, '{ref}')
    )
  ) stored,

  unique (project_id, change_key),

  -- The same composite reference the cards table uses: foreign keys are checked
  -- by the system and are not subject to RLS, so a note and its project share
  -- an org regardless of what any role can see.
  foreign key (project_id, org_id)
    references projects (id, org_id) on delete cascade
);

create index change_notes_org_project_idx on change_notes (org_id, project_id);
create index change_notes_module_idx      on change_notes (org_id, module);
create index change_notes_recent_idx      on change_notes (org_id, occurred_at desc);
create index change_notes_tags_idx        on change_notes using gin (tags);
create index change_notes_search_idx      on change_notes using gin (search_vector);

create trigger change_notes_touch_updated_at
  before update on change_notes
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------- rls

alter table change_notes enable row level security;
alter table change_notes force row level security;

create policy change_notes_in_org on change_notes
  for all using (org_id = app.current_org_id())
  with check (org_id = app.current_org_id());

-- ---------------------------------------------------------------- grants

-- `grant ... on all tables in schema public` is a point-in-time grant: it does
-- not reach a table created after it ran. Without this block the application
-- role meets a permission error where it used to meet an empty board, and only
-- on the new tool. The roles are named explicitly and skipped when absent, so
-- this migration applies unchanged to a dev database and to a deployment.
do $grants$
declare
  app_role text;
begin
  foreach app_role in array array['context_app', 'mcp_app'] loop
    if exists (select 1 from pg_roles where rolname = app_role) then
      execute format(
        'grant select, insert, update, delete on change_notes to %I', app_role);
      execute format(
        'grant execute on function app.jsonb_values(jsonb, text[]) to %I', app_role);
    end if;
  end loop;
end
$grants$;
