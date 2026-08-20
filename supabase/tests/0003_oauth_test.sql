-- Behaviour tests for the authorization server. Run against a database that
-- has every migration applied. Every assertion raises, so psql with
-- ON_ERROR_STOP=1 turns a broken guarantee into a non-zero exit code.
--
-- The e2e suite drives this same machinery over HTTP; what lives here is what
-- HTTP cannot reach without waiting: expiry, cascades, and the promise that the
-- application role cannot touch these tables at all.

\set ORG_E '77777777-7777-7777-7777-777777777777'
\set ORG_F '88888888-8888-8888-8888-888888888888'
\set RESOURCE 'https://board.example/mcp'

insert into organizations (id, slug, name) values
  (:'ORG_E', 'hooli', 'Hooli'),
  (:'ORG_F', 'piedpiper', 'Pied Piper');

insert into api_keys (org_id, name, key_prefix, key_hash) values
  (:'ORG_E', 'hooli', 'ctx_hoo', encode(sha256(convert_to('ctx_hooli_key', 'utf8')), 'hex')),
  (:'ORG_F', 'pied',  'ctx_pie', encode(sha256(convert_to('ctx_pied_key',  'utf8')), 'hex'));

create role oauth_app nologin;
grant usage on schema public, app to oauth_app;
grant select, insert, update, delete on all tables in schema public to oauth_app;
grant execute on all functions in schema app to oauth_app;

-- ---------------------------------------------------------------- isolation

-- The whole design rests on this: these tables hold pre-tenant state, so no
-- RLS policy can guard them. Unreachability is the guard.
set role oauth_app;

do $$
begin
  perform 1 from app.oauth_tokens;
  raise exception 'the application role could read app.oauth_tokens directly';
exception when insufficient_privilege then null;
end $$;

do $$
begin
  perform 1 from app.oauth_clients;
  raise exception 'the application role could read app.oauth_clients directly';
exception when insufficient_privilege then null;
end $$;

-- ---------------------------------------------------------------- key ref

do $$
declare
  found_org uuid;
  found_key uuid;
begin
  select org_id, api_key_id into found_org, found_key
    from app.resolve_api_key_ref('ctx_hooli_key');
  if found_org is null or found_key is null then
    raise exception 'a live key did not resolve to an org and a key id';
  end if;

  select org_id into found_org from app.resolve_api_key_ref('ctx_nonsense');
  if found_org is not null then
    raise exception 'an unknown key resolved';
  end if;
end $$;

-- ---------------------------------------------------------------- the flow

select app.oauth_register_client('client-hooli', null, 'Test client',
  array['https://claude.ai/api/mcp/auth_callback']);

do $$
declare
  org_e uuid;
  key_e uuid;
  redeemed record;
begin
  select org_id, api_key_id into org_e, key_e from app.resolve_api_key_ref('ctx_hooli_key');

  perform app.oauth_issue_code('code-live', 'client-hooli', org_e, key_e,
    'https://claude.ai/api/mcp/auth_callback', 'challenge-value', 'board',
    'https://board.example/mcp', interval '5 minutes');

  select * into redeemed from app.oauth_redeem_code('code-live');
  if redeemed.org_id is distinct from org_e then
    raise exception 'redeeming a code returned the wrong org';
  end if;
  if redeemed.code_challenge <> 'challenge-value' then
    raise exception 'redeeming a code lost the PKCE challenge';
  end if;
end $$;

-- An expired code is worth exactly as much as an unknown one.
do $$
declare
  org_e uuid;
  key_e uuid;
  rows_back integer;
begin
  select org_id, api_key_id into org_e, key_e from app.resolve_api_key_ref('ctx_hooli_key');
  perform app.oauth_issue_code('code-expired', 'client-hooli', org_e, key_e,
    'https://claude.ai/api/mcp/auth_callback', 'challenge-value', 'board',
    'https://board.example/mcp', interval '-1 second');

  select count(*) into rows_back from app.oauth_redeem_code('code-expired');
  if rows_back <> 0 then
    raise exception 'an expired code was redeemed';
  end if;
end $$;

-- ---------------------------------------------------------------- audience

do $$
declare
  org_e uuid;
  key_e uuid;
begin
  select org_id, api_key_id into org_e, key_e from app.resolve_api_key_ref('ctx_hooli_key');
  perform app.oauth_issue_tokens('access-live', 'refresh-live', 'client-hooli',
    org_e, key_e, 'https://board.example/mcp', 'board', 'code-live',
    interval '1 hour', interval '30 days');

  if app.oauth_resolve_access('access-live', 'https://board.example/mcp') is null then
    raise exception 'a live token did not resolve for its own audience';
  end if;

  -- Audience binding is what stops a token stolen from this board from being
  -- replayed against another MCP server that trusts the same issuer.
  if app.oauth_resolve_access('access-live', 'https://elsewhere.example/mcp') is not null then
    raise exception 'a token resolved for an audience it was not minted for';
  end if;
end $$;

-- An expired access token stops working without anything having to sweep it.
do $$
declare
  org_e uuid;
  key_e uuid;
begin
  select org_id, api_key_id into org_e, key_e from app.resolve_api_key_ref('ctx_hooli_key');
  perform app.oauth_issue_tokens('access-stale', 'refresh-stale', 'client-hooli',
    org_e, key_e, 'https://board.example/mcp', 'board', 'code-live',
    interval '-1 second', interval '30 days');

  if app.oauth_resolve_access('access-stale', 'https://board.example/mcp') is not null then
    raise exception 'an expired access token still resolved';
  end if;
end $$;

-- ---------------------------------------------------------------- rotation

do $$
declare
  rotated record;
  rows_back integer;
begin
  select * into rotated from app.oauth_rotate_refresh('refresh-live', 'client-hooli',
    'access-second', 'refresh-second', interval '1 hour', interval '30 days',
    interval '10 seconds');
  if rotated.org_id is null then
    raise exception 'rotating a live refresh token produced nothing';
  end if;

  if app.oauth_resolve_access('access-second', 'https://board.example/mcp') is null then
    raise exception 'the rotated access token does not work';
  end if;
  if app.oauth_resolve_access('access-live', 'https://board.example/mcp') is not null then
    raise exception 'the pre-rotation access token survived rotation';
  end if;

  -- Inside the grace window the same token presented twice is one client
  -- submitting twice: refused, but the session it just minted has to survive.
  select count(*) into rows_back from app.oauth_rotate_refresh('refresh-live', 'client-hooli',
    'access-third', 'refresh-third', interval '1 hour', interval '30 days',
    interval '10 seconds');
  if rows_back <> 0 then
    raise exception 'a rotated-away refresh token was accepted';
  end if;

  if app.oauth_resolve_access('access-second', 'https://board.example/mcp') is null then
    raise exception 'a duplicate submit inside the grace window killed the live session';
  end if;

  -- Outside it, the same presentation is a replay, and the live descendant is
  -- exactly what has to die: that is the whole point of reuse detection.
  select count(*) into rows_back from app.oauth_rotate_refresh('refresh-live', 'client-hooli',
    'access-fourth', 'refresh-fourth', interval '1 hour', interval '30 days',
    interval '0 seconds');
  if rows_back <> 0 then
    raise exception 'a replayed refresh token was accepted';
  end if;

  if app.oauth_resolve_access('access-second', 'https://board.example/mcp') is not null then
    raise exception 'replaying a refresh token left the live descendant alive';
  end if;
end $$;

-- The interleaving a snapshot-based cleanup could not see: a replay of an OLD
-- ancestor while the chain has already moved on. The burn must reach whatever
-- is live NOW, not whatever was live when the replay arrived.
do $$
declare
  org_e uuid;
  key_e uuid;
  rows_back integer;
begin
  select org_id, api_key_id into org_e, key_e from app.resolve_api_key_ref('ctx_hooli_key');

  perform app.oauth_issue_code('code-chain', 'client-hooli', org_e, key_e,
    'https://claude.ai/api/mcp/auth_callback', 'challenge-value', 'board',
    'https://board.example/mcp', interval '5 minutes');

  -- R0, then a legitimate rotation to R1, then another to R2.
  perform app.oauth_issue_tokens('acc-r0', 'ref-r0', 'client-hooli',
    org_e, key_e, 'https://board.example/mcp', 'board', 'code-chain',
    interval '1 hour', interval '30 days');
  perform app.oauth_rotate_refresh('ref-r0', 'client-hooli', 'acc-r1', 'ref-r1',
    interval '1 hour', interval '30 days', interval '10 seconds');
  perform app.oauth_rotate_refresh('ref-r1', 'client-hooli', 'acc-r2', 'ref-r2',
    interval '1 hour', interval '30 days', interval '10 seconds');

  if app.oauth_resolve_access('acc-r2', 'https://board.example/mcp') is null then
    raise exception 'the chain did not reach a live R2';
  end if;

  -- A thief replays R0, two rotations behind.
  select count(*) into rows_back from app.oauth_rotate_refresh('ref-r0', 'client-hooli',
    'acc-x', 'ref-x', interval '1 hour', interval '30 days', interval '0 seconds');
  if rows_back <> 0 then
    raise exception 'replaying an ancestor token was accepted';
  end if;

  if app.oauth_resolve_access('acc-r2', 'https://board.example/mcp') is not null then
    raise exception 'replaying an ancestor left the current live token alive';
  end if;
end $$;

-- A refresh token belongs to the client it was issued to, and to no other.
do $$
declare
  org_f uuid;
  key_f uuid;
  rows_back integer;
begin
  select org_id, api_key_id into org_f, key_f from app.resolve_api_key_ref('ctx_pied_key');
  perform app.oauth_issue_code('code-pied', 'client-hooli', org_f, key_f,
    'https://claude.ai/api/mcp/auth_callback', 'challenge-value', 'board',
    'https://board.example/mcp', interval '5 minutes');
  perform app.oauth_issue_tokens('access-pied', 'refresh-pied', 'client-hooli',
    org_f, key_f, 'https://board.example/mcp', 'board', 'code-pied',
    interval '1 hour', interval '30 days');

  select count(*) into rows_back from app.oauth_rotate_refresh('refresh-pied', 'another-client',
    'access-x', 'refresh-x', interval '1 hour', interval '30 days', interval '10 seconds');
  if rows_back <> 0 then
    raise exception 'a refresh token was accepted for the wrong client';
  end if;
end $$;

-- ---------------------------------------------------------------- revocation

-- Revoking the key is the whole revocation story: nothing has to hunt down the
-- tokens it authorized, because resolving one joins onto the key every time.
reset role;

update api_keys
   set revoked_at = now()
 where key_hash = encode(sha256(convert_to('ctx_pied_key', 'utf8')), 'hex');

set role oauth_app;

do $$
begin
  if app.oauth_resolve_access('access-pied', 'https://board.example/mcp') is not null then
    raise exception 'a token outlived the api key that authorized it';
  end if;
end $$;

-- ---------------------------------------------------------------- cascade

reset role;

delete from organizations where id = '88888888-8888-8888-8888-888888888888';

do $$
declare
  leftover integer;
begin
  select count(*) into leftover from app.oauth_tokens where org_id = '88888888-8888-8888-8888-888888888888';
  if leftover <> 0 then
    raise exception 'deleting an org left % oauth tokens behind', leftover;
  end if;
end $$;

reset role;

\echo 'ALL OAUTH TESTS PASSED'
