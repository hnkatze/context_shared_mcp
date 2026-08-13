-- Behaviour tests for the tenancy guarantees. Run against a database that has
-- 0001_init.sql applied. Every assertion raises, so psql -v ON_ERROR_STOP=1
-- turns a broken guarantee into a non-zero exit code.

\set ORG_A '11111111-1111-1111-1111-111111111111'
\set ORG_B '22222222-2222-2222-2222-222222222222'

insert into organizations (id, slug, name) values
  (:'ORG_A', 'acme',   'Acme'),
  (:'ORG_B', 'globex', 'Globex');

insert into projects (id, org_id, slug, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', :'ORG_A', 'checkout', 'Checkout'),
  ('bbbbbbbb-0000-0000-0000-000000000001', :'ORG_B', 'billing',  'Billing');

insert into cards (org_id, project_id, module, card_key, summary, why_not_obvious, author, tags)
values
  (:'ORG_A', 'aaaaaaaa-0000-0000-0000-000000000001', 'checkout', 'idempotency-scope',
   'Idempotency keys are scoped per merchant',
   'The Swagger shows a plain string field, but the key is only unique within a merchant and expires after 24h, so a retry the next day silently creates a second order.',
   'be-dev', array['idempotency','orders']),
  (:'ORG_B', 'bbbbbbbb-0000-0000-0000-000000000001', 'billing', 'invoice-pretax-totals',
   'Invoice totals exclude tax until issued',
   'Totals returned before the invoice is issued are pre-tax, which the response shape does not signal at all; the FE must not render them as final amounts.',
   'be-dev', array['invoices']);

-- A role that is neither superuser nor table owner: the only way RLS is real.
create role mcp_app nologin;
grant usage on schema public, app to mcp_app;
grant select, insert, update, delete on all tables in schema public to mcp_app;
grant execute on all functions in schema app to mcp_app;

set role mcp_app;

-- ---------------------------------------------------------------- isolation

select set_config('app.current_org_id', :'ORG_A', false);

do $$
declare n int;
begin
  select count(*) into n from cards;
  if n <> 1 then raise exception 'org A must see exactly its own card, saw %', n; end if;

  select count(*) into n from cards where module = 'billing';
  if n <> 0 then raise exception 'org A leaked org B data'; end if;

  select count(*) into n from projects;
  if n <> 1 then raise exception 'project isolation broken, saw %', n; end if;
end $$;

-- With no tenant set, current_org_id() is null and every policy must deny.
select set_config('app.current_org_id', '', false);

do $$
declare n int;
begin
  select count(*) into n from cards;
  if n <> 0 then raise exception 'unauthenticated connection saw % cards', n; end if;
end $$;

-- ---------------------------------------------------------------- write guards

select set_config('app.current_org_id', :'ORG_A', false);

-- Writing into another org must be rejected by the policy's WITH CHECK.
do $$
begin
  insert into cards (org_id, project_id, module, card_key, summary, why_not_obvious, author)
  values ('22222222-2222-2222-2222-222222222222',
          'bbbbbbbb-0000-0000-0000-000000000001', 'billing', 'probe', 'x',
          'a string long enough to clear the quality check constraint on this column',
          'attacker');
  raise exception 'cross-tenant insert was allowed';
exception when insufficient_privilege then null;
end $$;

-- Borrowing the project of another org while keeping your own org_id is now
-- refused by the composite foreign key, which no role can talk its way past.
do $$
begin
  insert into cards (org_id, project_id, module, card_key, summary, why_not_obvious, author)
  values ('11111111-1111-1111-1111-111111111111',
          'bbbbbbbb-0000-0000-0000-000000000001', 'billing', 'probe', 'x',
          'a string long enough to clear the quality check constraint on this column',
          'confused');
  raise exception 'card was attached to a foreign project';
exception
  when foreign_key_violation then null;
end $$;

-- The quality gate: a thin why_not_obvious is not a card.
do $$
begin
  insert into cards (org_id, project_id, module, card_key, summary, why_not_obvious, author)
  values ('11111111-1111-1111-1111-111111111111',
          'aaaaaaaa-0000-0000-0000-000000000001', 'checkout', 'probe', 'x', 'idk', 'lazy');
  raise exception 'empty why_not_obvious was accepted';
exception when check_violation then null;
end $$;

-- The server creates a project on first publish, so that write is part of the
-- tenant surface now: allowed inside your own org, refused outside it.
do $$
declare n int;
begin
  insert into projects (org_id, slug, name)
  values ('11111111-1111-1111-1111-111111111111', 'orders', 'Orders');

  select count(*) into n from projects;
  if n <> 2 then raise exception 'the app role cannot create a project in its own org'; end if;
end $$;

do $$
begin
  insert into projects (org_id, slug, name)
  values ('22222222-2222-2222-2222-222222222222', 'smuggled', 'Smuggled');
  raise exception 'cross-tenant project insert was allowed';
exception when insufficient_privilege then null;
end $$;

-- ---------------------------------------------------------------- search

do $$
declare n int;
begin
  select count(*) into n from cards
   where search_vector @@ websearch_to_tsquery('simple', 'idempotency');
  if n <> 1 then raise exception 'full-text search found % rows, expected 1', n; end if;

  select count(*) into n from cards
   where search_vector @@ websearch_to_tsquery('simple', 'invoice');
  if n <> 0 then raise exception 'search crossed the tenant boundary'; end if;
end $$;

-- ---------------------------------------------------------------- idempotency

-- Republishing the same fact must update the card, not add a second one.
do $$
declare
  original uuid;
  updated  uuid;
  n        int;
begin
  select id into original from cards where card_key = 'idempotency-scope';

  insert into cards (org_id, project_id, module, card_key, summary, why_not_obvious, author)
  values ('11111111-1111-1111-1111-111111111111',
          'aaaaaaaa-0000-0000-0000-000000000001', 'checkout', 'idempotency-scope',
          'Idempotency keys are scoped per merchant and expire in 24h',
          'Same fact as before, restated after the BE clarified the expiry window, so this must land on the existing card.',
          'be-dev')
  on conflict (project_id, card_key) do update
     set summary = excluded.summary,
         why_not_obvious = excluded.why_not_obvious
  returning id into updated;

  if original is distinct from updated then
    raise exception 'republish created a new card instead of updating';
  end if;

  select count(*) into n from cards where card_key = 'idempotency-scope';
  if n <> 1 then raise exception 'card_key duplicated, % rows', n; end if;

  if (select updated_at from cards where id = updated)
     <= (select created_at from cards where id = updated) then
    raise exception 'updated_at was not touched on republish';
  end if;
end $$;

reset role;
-- ---------------------------------------------------------------- role safety

-- Two properties this schema depends on, asserted rather than assumed.
--
-- FORCE keeps the owner of a table subject to its own policies. It does NOT
-- stop a role carrying the BYPASSRLS attribute: Supabase grants exactly that to
-- its default `postgres` role, so connecting the app with the credentials
-- Supabase hands you leaves every policy here decorative. The application must
-- log in as a role with neither BYPASSRLS nor ownership.
do $$
declare unforced text;
begin
  select string_agg(relname, ', ')
    into unforced
    from pg_class
   where relname in ('organizations', 'projects', 'cards')
     and relrowsecurity
     and not relforcerowsecurity;

  if unforced is not null then
    raise exception 'these tables do not force RLS on their owner: %', unforced;
  end if;

  if exists (select 1 from pg_roles where rolname = 'mcp_app' and rolbypassrls) then
    raise exception 'the application role carries BYPASSRLS and would see every tenant';
  end if;

  if exists (select 1 from pg_roles where rolname = 'mcp_app' and rolsuper) then
    raise exception 'the application role is a superuser and would see every tenant';
  end if;
end $$;




-- ---------------------------------------------------------------- api keys

insert into api_keys (org_id, name, key_prefix, key_hash)
values (:'ORG_A', 'laptop', 'ctx_ab',
        encode(sha256(convert_to('ctx_abcdef', 'utf8')), 'hex')),
       (:'ORG_B', 'revoked', 'ctx_zz',
        encode(sha256(convert_to('ctx_zzzzzz', 'utf8')), 'hex'));

update api_keys set revoked_at = now() where name = 'revoked';

do $$
begin
  if app.resolve_api_key('ctx_abcdef') is distinct from
     '11111111-1111-1111-1111-111111111111'::uuid then
    raise exception 'valid key did not resolve to its org';
  end if;

  if app.resolve_api_key('ctx_zzzzzz') is not null then
    raise exception 'revoked key still resolves';
  end if;

  if app.resolve_api_key('nope') is not null then
    raise exception 'unknown key resolved';
  end if;

  if (select last_used_at from api_keys where name = 'laptop') is null then
    raise exception 'last_used_at was not recorded';
  end if;
end $$;

\echo 'ALL TENANCY TESTS PASSED'
