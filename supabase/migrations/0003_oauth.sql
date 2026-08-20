-- context_shared 0003: an authorization server, so the board can be added as a
-- Claude custom connector.
--
-- The connector UI has no field for a bearer token: it offers a URL and, at
-- most, OAuth client credentials. An API key pasted into a config file is the
-- thing we are trying to stop doing anyway — it never expires, it is copied
-- into every machine that wants access, and revoking it is the only way to end
-- a session.
--
-- So the key stops being the credential and becomes the login. A human proves
-- they hold it once, on the consent page, and walks away with a short-lived
-- access token bound to this exact resource. The key itself never reaches
-- Claude, never lands in a config file, and never travels after that first
-- exchange.
--
-- Everything here lives in the `app` schema on purpose. The dev seed runs
-- `grant ... on all tables in schema public` for the application role; keeping
-- these tables out of `public` means that grant cannot reach them, so the only
-- way in is through the SECURITY DEFINER functions below. That is also why
-- they carry no RLS policies: no role that RLS would constrain can read them
-- at all.

-- ---------------------------------------------------------------- api key ref

-- resolve_api_key answers "which org", which is all the MCP transport ever
-- needed. Issuing a token needs one more fact: which key authorized it, so
-- that revoking the key collapses every token minted from it.
create or replace function app.resolve_api_key_ref(raw_token text)
returns table (org_id uuid, api_key_id uuid)
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  update api_keys k
     set last_used_at = now()
   where k.key_hash = encode(sha256(convert_to(raw_token, 'utf8')), 'hex')
     and k.revoked_at is null
  returning k.org_id, k.id
$$;

-- ---------------------------------------------------------------- clients

-- Claude registers itself dynamically (RFC 7591) on every fresh connection, so
-- this table grows one row per connection attempt rather than one per install.
-- It is deliberately thin: a client id, the redirect URIs it may use, and a
-- secret only if it asked to be confidential.
create table app.oauth_clients (
  client_id           text primary key,
  client_secret_hash  text,
  client_name         text not null default '',
  redirect_uris       text[] not null check (cardinality(redirect_uris) > 0),
  created_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------- auth codes

-- Only the hash is stored, for the same reason api_keys stores only a hash: a
-- database dump must not be a pile of working credentials.
create table app.oauth_auth_codes (
  code_hash       text primary key,
  client_id       text not null references app.oauth_clients(client_id) on delete cascade,
  org_id          uuid not null references organizations(id) on delete cascade,
  api_key_id      uuid not null references api_keys(id) on delete cascade,
  redirect_uri    text not null,

  -- S256 only. A plain challenge is no challenge at all, and the MCP spec
  -- requires S256 support, so there is no reason to accept the weaker mode.
  code_challenge  text not null,

  scope           text not null default '',

  -- The audience. A token minted here is valid at this URI and nowhere else,
  -- which is what stops a token from being replayed against another server.
  resource        text not null,

  expires_at      timestamptz not null,
  consumed_at     timestamptz,
  created_at      timestamptz not null default now()
);

create index oauth_auth_codes_expiry_idx on app.oauth_auth_codes (expires_at);

-- ---------------------------------------------------------------- tokens

create table app.oauth_tokens (
  id                  uuid primary key default gen_random_uuid(),
  access_hash         text not null unique,
  refresh_hash        text unique,

  client_id           text not null references app.oauth_clients(client_id) on delete cascade,
  org_id              uuid not null references organizations(id) on delete cascade,
  api_key_id          uuid not null references api_keys(id) on delete cascade,

  resource            text not null,
  scope               text not null default '',

  -- Every token rotated out of the same authorization keeps this value, which
  -- is what makes a stolen-token chain revocable as one unit.
  origin_code_hash    text not null,

  access_expires_at   timestamptz not null,
  refresh_expires_at  timestamptz,
  revoked_at          timestamptz,
  last_used_at        timestamptz,
  created_at          timestamptz not null default now()
);

create index oauth_tokens_chain_idx  on app.oauth_tokens (origin_code_hash);
create index oauth_tokens_org_idx    on app.oauth_tokens (org_id);
create index oauth_tokens_expiry_idx on app.oauth_tokens (access_expires_at);

-- ---------------------------------------------------------------- client ops

create or replace function app.oauth_register_client(
  p_client_id          text,
  p_client_secret_hash text,
  p_client_name        text,
  p_redirect_uris      text[]
)
returns void
language sql
volatile
security definer
set search_path = app, public, pg_temp
as $$
  insert into app.oauth_clients (client_id, client_secret_hash, client_name, redirect_uris)
  values (p_client_id, p_client_secret_hash, coalesce(p_client_name, ''), p_redirect_uris)
$$;

create or replace function app.oauth_find_client(p_client_id text)
returns table (client_id text, client_secret_hash text, redirect_uris text[])
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select c.client_id, c.client_secret_hash, c.redirect_uris
    from app.oauth_clients c
   where c.client_id = p_client_id
$$;

-- ---------------------------------------------------------------- code ops

create or replace function app.oauth_issue_code(
  p_code_hash      text,
  p_client_id      text,
  p_org_id         uuid,
  p_api_key_id     uuid,
  p_redirect_uri   text,
  p_code_challenge text,
  p_scope          text,
  p_resource       text,
  p_ttl            interval
)
returns void
language sql
volatile
security definer
set search_path = app, public, pg_temp
as $$
  insert into app.oauth_auth_codes (
    code_hash, client_id, org_id, api_key_id, redirect_uri,
    code_challenge, scope, resource, expires_at
  )
  values (
    p_code_hash, p_client_id, p_org_id, p_api_key_id, p_redirect_uri,
    p_code_challenge, coalesce(p_scope, ''), p_resource, now() + p_ttl
  )
$$;

-- Single use, enforced by the UPDATE itself rather than by a read followed by
-- a write: two token requests racing on the same code must not both win.
--
-- A code presented a second time is not a mistake to shrug at. Either it
-- leaked, or someone is replaying it — so the tokens it already minted are
-- burned. Losing a live session is the correct price for that ambiguity.
create or replace function app.oauth_redeem_code(p_code_hash text)
returns table (
  client_id      text,
  org_id         uuid,
  api_key_id     uuid,
  redirect_uri   text,
  code_challenge text,
  scope          text,
  resource       text
)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $fn$
declare
  was_consumed boolean;
begin
  return query
    update app.oauth_auth_codes c
       set consumed_at = now()
     where c.code_hash = p_code_hash
       and c.consumed_at is null
       and c.expires_at > now()
    returning c.client_id, c.org_id, c.api_key_id, c.redirect_uri,
              c.code_challenge, c.scope, c.resource;

  if not found then
    select true
      into was_consumed
      from app.oauth_auth_codes
     where code_hash = p_code_hash
       and consumed_at is not null;

    if was_consumed then
      update app.oauth_tokens
         set revoked_at = now()
       where origin_code_hash = p_code_hash
         and revoked_at is null;
    end if;
  end if;
end
$fn$;

-- ---------------------------------------------------------------- token ops

create or replace function app.oauth_issue_tokens(
  p_access_hash     text,
  p_refresh_hash    text,
  p_client_id       text,
  p_org_id          uuid,
  p_api_key_id      uuid,
  p_resource        text,
  p_scope           text,
  p_origin_code     text,
  p_access_ttl      interval,
  p_refresh_ttl     interval
)
returns void
language sql
volatile
security definer
set search_path = app, public, pg_temp
as $$
  insert into app.oauth_tokens (
    access_hash, refresh_hash, client_id, org_id, api_key_id,
    resource, scope, origin_code_hash, access_expires_at, refresh_expires_at
  )
  values (
    p_access_hash, p_refresh_hash, p_client_id, p_org_id, p_api_key_id,
    p_resource, coalesce(p_scope, ''), p_origin_code,
    now() + p_access_ttl, now() + p_refresh_ttl
  )
$$;

-- The join onto api_keys is the point of the whole table: revoking the key a
-- token was minted from must end that token in the same instant, without any
-- process having to hunt tokens down.
create or replace function app.oauth_resolve_access(p_access_hash text, p_resource text)
returns uuid
language sql
volatile
security definer
set search_path = app, public, pg_temp
as $$
  update app.oauth_tokens t
     set last_used_at = now()
    from api_keys k
   where t.access_hash = p_access_hash
     and t.resource = p_resource
     and t.revoked_at is null
     and t.access_expires_at > now()
     and k.id = t.api_key_id
     and k.revoked_at is null
  returning t.org_id
$$;

-- Rotation, as OAuth 2.1 requires for public clients. The old refresh token
-- dies in the same transaction that mints its replacement, so a token that
-- shows up after rotation can only be a copy — and a copy means the chain is
-- compromised, so the chain ends.
create or replace function app.oauth_rotate_refresh(
  p_refresh_hash     text,
  p_client_id        text,
  p_new_access_hash  text,
  p_new_refresh_hash text,
  p_access_ttl       interval,
  p_refresh_ttl      interval,
  p_reuse_grace      interval
)
returns table (org_id uuid, resource text, scope text)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $fn$
declare
  claimed      app.oauth_tokens%rowtype;
  chain        text;
  revoked_when timestamptz;
begin
  -- The token is claimed by revoking it, in one statement. Reading the row
  -- first and checking revoked_at in memory lets two concurrent callers both
  -- pass the check and both mint a chain, which is the failure rotation exists
  -- to prevent. Here the UPDATE's own WHERE is the lock: under READ COMMITTED
  -- the loser re-evaluates it against the winner's row and matches nothing.
  update app.oauth_tokens t
     set revoked_at = now()
   where t.refresh_hash = p_refresh_hash
     and t.client_id = p_client_id
     and t.revoked_at is null
     and t.refresh_expires_at > now()
  returning t.* into claimed;

  if not found then
    select origin_code_hash, revoked_at into chain, revoked_when
      from app.oauth_tokens
     where refresh_hash = p_refresh_hash
       and client_id = p_client_id;

    -- A token rotated moments ago was almost certainly presented twice by one
    -- client, not replayed by a thief: the two are indistinguishable from the
    -- server's side, so the grace window decides which to assume. Outside it,
    -- the whole chain dies — evaluated now, not from an earlier snapshot, so a
    -- descendant minted while this call was in flight is still caught.
    -- clock_timestamp(), not now(): now() is frozen at transaction start, so a
    -- caller that revoked and re-presented inside one transaction would compare
    -- an instant against itself and never see the window elapse.
    if chain is not null
       and (revoked_when is null or revoked_when < clock_timestamp() - p_reuse_grace) then
      update app.oauth_tokens
         set revoked_at = now()
       where origin_code_hash = chain
         and revoked_at is null;
    end if;
    return;
  end if;

  insert into app.oauth_tokens (
    access_hash, refresh_hash, client_id, org_id, api_key_id,
    resource, scope, origin_code_hash, access_expires_at, refresh_expires_at
  )
  values (
    p_new_access_hash, p_new_refresh_hash, claimed.client_id, claimed.org_id,
    claimed.api_key_id, claimed.resource, claimed.scope, claimed.origin_code_hash,
    now() + p_access_ttl, now() + p_refresh_ttl
  );

  return query select claimed.org_id, claimed.resource, claimed.scope;
end
$fn$;

-- Housekeeping. Nothing calls this on a timer: expired rows are harmless, and
-- a deployment that wants them gone can schedule it (pg_cron on Supabase).
create or replace function app.oauth_purge_expired()
returns void
language sql
volatile
security definer
set search_path = app, public, pg_temp
as $$
  with dead_codes as (
    delete from app.oauth_auth_codes
     where expires_at < now() - interval '1 day'
    returning 1
  )
  delete from app.oauth_tokens
   where coalesce(refresh_expires_at, access_expires_at) < now() - interval '30 days'
$$;

-- ---------------------------------------------------------------- grants

-- The application role gets no table privileges here at all — only the right
-- to call the definer functions above. The tables are reachable exclusively
-- through them, which is what lets them hold pre-tenant state safely.
do $grants$
declare
  app_role text;
begin
  foreach app_role in array array['context_app', 'mcp_app'] loop
    if exists (select 1 from pg_roles where rolname = app_role) then
      execute format('grant usage on schema app to %I', app_role);
      execute format(
        'grant execute on function app.resolve_api_key_ref(text) to %I', app_role);
      execute format(
        'grant execute on function app.oauth_register_client(text, text, text, text[]) to %I', app_role);
      execute format(
        'grant execute on function app.oauth_find_client(text) to %I', app_role);
      execute format(
        'grant execute on function app.oauth_issue_code(text, text, uuid, uuid, text, text, text, text, interval) to %I', app_role);
      execute format(
        'grant execute on function app.oauth_redeem_code(text) to %I', app_role);
      execute format(
        'grant execute on function app.oauth_issue_tokens(text, text, text, uuid, uuid, text, text, text, interval, interval) to %I', app_role);
      execute format(
        'grant execute on function app.oauth_resolve_access(text, text) to %I', app_role);
      execute format(
        'grant execute on function app.oauth_rotate_refresh(text, text, text, text, interval, interval, interval) to %I', app_role);
    end if;
  end loop;
end
$grants$;
