-- Development seed only. It creates a login role with a known password and a
-- known API key; never run it against a real deployment.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'mcp_app') then
    alter role mcp_app login password 'mcp';
  else
    create role mcp_app login password 'mcp';
  end if;
end $$;

grant usage on schema public, app to mcp_app;
grant select, insert, update, delete on all tables in schema public to mcp_app;
grant execute on all functions in schema app to mcp_app;

insert into organizations (id, slug, name)
values ('33333333-3333-3333-3333-333333333333', 'dev', 'Dev Org')
on conflict (slug) do nothing;

insert into projects (org_id, slug, name)
values ('33333333-3333-3333-3333-333333333333', 'checkout', 'Checkout'),
       ('33333333-3333-3333-3333-333333333333', 'billing',  'Billing')
on conflict (org_id, slug) do nothing;

insert into api_keys (org_id, name, key_prefix, key_hash)
values ('33333333-3333-3333-3333-333333333333', 'dev', 'ctx_dev',
        encode(sha256(convert_to('ctx_dev_key', 'utf8')), 'hex'))
on conflict (key_hash) do nothing;

-- A second tenant, so isolation can be exercised end to end. It deliberately
-- reuses the checkout slug: project slugs are unique per org, not globally.
insert into organizations (id, slug, name)
values ('44444444-4444-4444-4444-444444444444', 'rival', 'Rival Org')
on conflict (slug) do nothing;

insert into projects (org_id, slug, name)
values ('44444444-4444-4444-4444-444444444444', 'checkout', 'Rival Checkout')
on conflict (org_id, slug) do nothing;

insert into api_keys (org_id, name, key_prefix, key_hash)
values ('44444444-4444-4444-4444-444444444444', 'rival', 'ctx_riv',
        encode(sha256(convert_to('ctx_rival_key', 'utf8')), 'hex'))
on conflict (key_hash) do nothing;
