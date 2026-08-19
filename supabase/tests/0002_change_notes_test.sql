-- Behaviour tests for change notes and for the search index they share with
-- cards. Run against a database that has every migration applied. Every
-- assertion raises, so psql -v ON_ERROR_STOP=1 turns a broken guarantee into a
-- non-zero exit code.
--
-- Self-contained on purpose: its own orgs and its own application role, so it
-- passes whether or not 0001_tenancy_test.sql ran against the same database.

\set ORG_C '55555555-5555-5555-5555-555555555555'
\set ORG_D '66666666-6666-6666-6666-666666666666'
\set PROJ_C 'cccccccc-0000-0000-0000-000000000001'
\set PROJ_D 'dddddddd-0000-0000-0000-000000000001'

insert into organizations (id, slug, name) values
  (:'ORG_C', 'initech', 'Initech'),
  (:'ORG_D', 'umbrella', 'Umbrella');

insert into projects (id, org_id, slug, name) values
  (:'PROJ_C', :'ORG_C', 'orders',  'Orders'),
  (:'PROJ_D', :'ORG_D', 'shipping', 'Shipping');

create role notes_app nologin;
grant usage on schema public, app to notes_app;
grant select, insert, update, delete on all tables in schema public to notes_app;
grant execute on all functions in schema app to notes_app;

set role notes_app;
select set_config('app.current_org_id', :'ORG_C', false);

-- ---------------------------------------------------------------- the gate

-- A change note with nothing verifiable behind it is a rumour, and the check
-- constraint is what makes that non-negotiable rather than a convention.
do $$
begin
  insert into change_notes (
    org_id, project_id, module, change_key, title, what_changed, why,
    source_refs, author)
  values ('55555555-5555-5555-5555-555555555555',
          'cccccccc-0000-0000-0000-000000000001', 'orders', 'unanchored',
          'Something changed', 'Fields moved around', 'Because',
          '[]'::jsonb, 'ghost');
  raise exception 'a change note with no source_refs was accepted';
exception when check_violation then null;
end $$;

-- ---------------------------------------------------------------- a real note

insert into change_notes (
  org_id, project_id, module, change_key, title, what_changed, why, impact,
  do_this, do_not, test_cases, source_refs, supersedes_cards, tags, author,
  occurred_at)
values (
  :'ORG_C', :'PROJ_C', 'orders', 'idempotency-window-2026-08',
  'The idempotency window on the order-creation endpoint dropped to 1h',
  'The key used to survive 24h. It now expires after 60 minutes, and a reused key past that point creates a second order instead of returning the first.',
  'The 24h window held a lock on merchant keys long enough to collide during batch replays.',
  'Any caller that retries an order more than an hour after the first attempt.',
  array['Regenerate the idempotency key per attempt, not per session'],
  array['Do not reuse a stale key to check whether an order already exists'],
  '[{"scenario": "Retry with the same key after 61 minutes", "expected": "A second order is created, not the original returned"}]'::jsonb,
  '[{"kind": "pr", "ref": "https://github.com/acme/api/pull/412"},
    {"kind": "endpoint", "ref": "POST /v1/orders"}]'::jsonb,
  array['idempotency-scope'],
  array['orders', 'idempotency'],
  'gustavo',
  now() - interval '3 days');

insert into change_notes (
  org_id, project_id, module, change_key, title, what_changed, why,
  source_refs, author, occurred_at)
values (
  :'ORG_C', :'PROJ_C', 'orders', 'order-status-enum-2026-08',
  'A fifth value joined the order status enum',
  'status can now be "held", between "pending" and "paid".',
  'Manual review for flagged merchants needed a state of its own.',
  '[{"kind": "commit", "ref": "9f2c1ab"}]'::jsonb,
  'gustavo',
  now() - interval '1 day');

-- ---------------------------------------------------------------- the feed

-- The feed is ordered by when the change happened, never by when somebody got
-- around to writing it down.
do $$
declare first_key text;
begin
  select change_key into first_key
    from change_notes order by occurred_at desc limit 1;
  if first_key <> 'order-status-enum-2026-08' then
    raise exception 'the feed is not ordered by occurred_at, got %', first_key;
  end if;
end $$;

-- ---------------------------------------------------------------- search

-- The question this board exists to answer: what happened to this endpoint.
-- Before source_refs reached the index, this found nothing at all.
do $$
declare n int;
begin
  select count(*) into n from change_notes
   where search_vector @@ websearch_to_tsquery('simple', 'POST /v1/orders');
  if n <> 1 then
    raise exception 'a change note was not findable by its endpoint ref, got %', n;
  end if;

  select count(*) into n from change_notes
   where search_vector @@ websearch_to_tsquery('simple', '9f2c1ab');
  if n <> 1 then
    raise exception 'a change note was not findable by its commit sha, got %', n;
  end if;

  -- do_not is indexed: the half of a change a diff never states.
  select count(*) into n from change_notes
   where search_vector @@ websearch_to_tsquery('simple', 'stale');
  if n <> 1 then raise exception 'do_not did not reach the search index'; end if;

  -- And the test case scenarios, so "how do I verify this" is searchable.
  select count(*) into n from change_notes
   where search_vector @@ websearch_to_tsquery('simple', '61 minutes');
  if n <> 1 then raise exception 'test_cases did not reach the search index'; end if;
end $$;

-- The same index fix on cards: an endpoint named only in source_refs, and an
-- alternative rejected only in decisions, both have to be findable.
insert into cards (org_id, project_id, module, card_key, summary,
                   why_not_obvious, decisions, source_refs, author)
values (
  :'ORG_C', :'PROJ_C', 'orders', 'settlement-timing',
  'Settlement runs at 03:00 in the merchant timezone',
  'Nothing in the response or the schedule endpoint says which timezone the cutoff uses, and a merchant in another zone reconciles against the wrong day.',
  '[{"choice": "Merchant local time", "rejected": "UTC everywhere", "reason": "Merchants reconcile against their own banking day"}]'::jsonb,
  '[{"kind": "endpoint", "ref": "GET /v1/settlements"}]'::jsonb,
  'hector');

do $$
declare n int;
begin
  select count(*) into n from cards
   where search_vector @@ websearch_to_tsquery('simple', 'GET /v1/settlements');
  if n <> 1 then
    raise exception 'a card was not findable by its endpoint ref, got %', n;
  end if;

  select count(*) into n from cards
   where search_vector @@ websearch_to_tsquery('simple', 'UTC');
  if n <> 1 then
    raise exception 'a rejected alternative did not reach the search index, got %', n;
  end if;
end $$;

-- ---------------------------------------------------------------- idempotency

-- Correcting the wording of a note must not move the date the change landed,
-- and must not leave two accounts of the same event on the board.
do $$
declare
  original_id   uuid;
  original_when timestamptz;
  updated_id    uuid;
  n             int;
begin
  select id, occurred_at into original_id, original_when
    from change_notes where change_key = 'idempotency-window-2026-08';

  insert into change_notes (
    org_id, project_id, module, change_key, title, what_changed, why,
    source_refs, author)
  values ('55555555-5555-5555-5555-555555555555',
          'cccccccc-0000-0000-0000-000000000001', 'orders',
          'idempotency-window-2026-08',
          'The idempotency window on the order-creation endpoint dropped to 1h',
          'Corrected: the window is 60 minutes from first receipt, not from response.',
          'Batch replays were colliding on merchant keys.',
          '[{"kind": "pr", "ref": "https://github.com/acme/api/pull/412"}]'::jsonb,
          'gustavo')
  on conflict (project_id, change_key) do update
     set what_changed = excluded.what_changed,
         occurred_at  = coalesce(null::timestamptz, change_notes.occurred_at)
  returning id into updated_id;

  if original_id is distinct from updated_id then
    raise exception 'correcting a note created a second one';
  end if;

  select count(*) into n from change_notes
   where change_key = 'idempotency-window-2026-08';
  if n <> 1 then raise exception 'change_key duplicated, % rows', n; end if;

  if (select occurred_at from change_notes where id = updated_id)
     is distinct from original_when then
    raise exception 'correcting a note moved the date the change landed';
  end if;
end $$;

-- ---------------------------------------------------------------- isolation

-- Writing into another org must be rejected by the policy's WITH CHECK.
do $$
begin
  insert into change_notes (
    org_id, project_id, module, change_key, title, what_changed, why,
    source_refs, author)
  values ('66666666-6666-6666-6666-666666666666',
          'dddddddd-0000-0000-0000-000000000001', 'shipping', 'probe',
          'x', 'y', 'z', '[{"kind": "commit", "ref": "deadbeef"}]'::jsonb, 'attacker');
  raise exception 'cross-tenant change note insert was allowed';
exception when insufficient_privilege then null;
end $$;

-- Borrowing another org's project while keeping your own org_id is refused by
-- the composite foreign key, which no role can talk its way past.
do $$
begin
  insert into change_notes (
    org_id, project_id, module, change_key, title, what_changed, why,
    source_refs, author)
  values ('55555555-5555-5555-5555-555555555555',
          'dddddddd-0000-0000-0000-000000000001', 'shipping', 'probe',
          'x', 'y', 'z', '[{"kind": "commit", "ref": "deadbeef"}]'::jsonb, 'confused');
  raise exception 'a change note was attached to a foreign project';
exception when foreign_key_violation then null;
end $$;

select set_config('app.current_org_id', :'ORG_D', false);

do $$
declare n int;
begin
  select count(*) into n from change_notes;
  if n <> 0 then raise exception 'org D saw % of org C''s change notes', n; end if;

  select count(*) into n from change_notes
   where search_vector @@ websearch_to_tsquery('simple', 'idempotency');
  if n <> 0 then raise exception 'search crossed the tenant boundary'; end if;
end $$;

-- With no tenant set, current_org_id() is null and every policy must deny.
select set_config('app.current_org_id', '', false);

do $$
declare n int;
begin
  select count(*) into n from change_notes;
  if n <> 0 then
    raise exception 'unauthenticated connection saw % change notes', n;
  end if;
end $$;

reset role;

-- ---------------------------------------------------------------- role safety

-- FORCE keeps the owner of the table subject to its own policies. Without it
-- the whole tenancy model on this table is decorative, exactly as it would be
-- on cards.
do $$
begin
  if exists (
    select 1 from pg_class
     where relname = 'change_notes'
       and relrowsecurity
       and not relforcerowsecurity
  ) then
    raise exception 'change_notes does not force RLS on its owner';
  end if;

  if exists (select 1 from pg_roles where rolname = 'notes_app' and rolbypassrls) then
    raise exception 'the application role carries BYPASSRLS and would see every tenant';
  end if;
end $$;

\echo 'ALL CHANGE NOTE TESTS PASSED'
