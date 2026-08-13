-- context_shared: curated context board.
-- Tenancy is org -> project -> card. Every row carries org_id so RLS can be
-- enforced without a join, and so no query can accidentally cross tenants.

create schema if not exists app;
create extension if not exists pgcrypto;

-- The MCP server authenticates with its own API key and sets this GUC per
-- connection. It MUST connect as a normal role: Supabase's service_role
-- bypasses RLS entirely and would defeat every policy below.
create or replace function app.current_org_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('app.current_org_id', true), '')::uuid
$$;
-- ---------------------------------------------------------------- organizations

create table organizations (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  name        text not null,
  created_at  timestamptz not null default now()
);

create table projects (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  slug        text not null,
  name        text not null,
  created_at  timestamptz not null default now(),
  unique (org_id, slug),

  -- Referenced by cards as a composite foreign key. Foreign keys are checked
  -- by the system and are not subject to RLS, so this enforces that a card and
  -- its project share an org without depending on what any role can see.
  unique (id, org_id)
);

create index projects_org_idx on projects (org_id);

-- ---------------------------------------------------------------- api keys

-- Only the hash is stored. key_prefix is the first few visible chars, kept so
-- a human can tell two keys apart in the admin UI without exposing either.
create table api_keys (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  name          text not null,
  key_prefix    text not null,
  key_hash      text not null unique,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);

create index api_keys_org_idx on api_keys (org_id);

-- Resolves a raw token to its org. Returns null for unknown or revoked keys.
create or replace function app.resolve_api_key(raw_token text)
returns uuid
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  update api_keys
     set last_used_at = now()
   where key_hash = encode(sha256(convert_to(raw_token, 'utf8')), 'hex')
     and revoked_at is null
  returning org_id
$$;

-- array_to_string is only STABLE because element output can depend on session
-- settings such as DateStyle. Narrowed to text[] it is deterministic, and a
-- generated column requires an immutable expression.
create or replace function app.join_text(arr text[])
returns text
language sql
immutable
parallel safe
as $$ select array_to_string(arr, ' ') $$;

-- ---------------------------------------------------------------- cards

create table cards (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  project_id  uuid not null,

  module      text not null,

  -- Stable slug for the fact this card states, chosen by the publisher.
  -- Republishing the same fact updates the card instead of duplicating it.
  card_key    text not null check (card_key ~ '^[a-z0-9][a-z0-9-]{1,62}$'),

  summary     text not null,

  -- The quality gate, enforced here rather than in application code: if the
  -- agent cannot say what the code and the Swagger fail to convey, the card
  -- has no reason to exist.
  why_not_obvious text not null check (length(btrim(why_not_obvious)) >= 40),

  -- [{ "choice": ..., "rejected": ..., "reason": ... }]
  decisions       jsonb not null default '[]'::jsonb,
  gotchas         text[] not null default '{}',
  consumer_notes  text[] not null default '{}',

  -- [{ "kind": "commit"|"pr"|"endpoint", "ref": ... }] — verifiable anchors,
  -- so a card written from a compacted session can still be checked.
  source_refs     jsonb not null default '[]'::jsonb,

  tags        text[] not null default '{}',
  author      text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- 'simple' rather than a language config: cards mix Spanish and English, and
  -- stemming for the wrong language is worse than no stemming at all.
  search_vector tsvector generated always as (
    to_tsvector('simple',
      coalesce(module, '') || ' ' ||
      coalesce(summary, '') || ' ' ||
      coalesce(why_not_obvious, '') || ' ' ||
      app.join_text(gotchas) || ' ' ||
      app.join_text(consumer_notes) || ' ' ||
      app.join_text(tags)
    )
  ) stored,

  unique (project_id, card_key),

  foreign key (project_id, org_id)
    references projects (id, org_id) on delete cascade
);

create index cards_org_project_idx on cards (org_id, project_id);
create index cards_module_idx      on cards (org_id, module);
create index cards_tags_idx        on cards using gin (tags);
create index cards_search_idx      on cards using gin (search_vector);

create or replace function app.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

create trigger cards_touch_updated_at
  before update on cards
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------- rls

alter table organizations enable row level security;
alter table projects      enable row level security;
alter table api_keys      enable row level security;
alter table cards         enable row level security;

-- Postgres exempts the owner of a table from its own policies, and Supabase
-- connects as that owner. Without forcing, the whole tenancy model is
-- decorative. api_keys stays unforced on purpose: resolve_api_key has to read
-- it before any tenant is known.
alter table organizations force row level security;
alter table projects      force row level security;
alter table cards         force row level security;

create policy org_is_current on organizations
  for all using (id = app.current_org_id())
  with check (id = app.current_org_id());

create policy projects_in_org on projects
  for all using (org_id = app.current_org_id())
  with check (org_id = app.current_org_id());

-- Readable so the admin UI can list them; the hash is never sent to a client.
create policy api_keys_in_org on api_keys
  for all using (org_id = app.current_org_id())
  with check (org_id = app.current_org_id());

create policy cards_in_org on cards
  for all using (org_id = app.current_org_id())
  with check (org_id = app.current_org_id());
