# context_shared

A curated context board. An agent publishes what a module's consumers cannot
learn from the code or the OpenAPI spec, and other agents read it before asking
a teammate. Publishing is explicit: a human decides what goes up, the agent
writes the card.

Tenancy is `org -> project -> card`, enforced by RLS plus a trigger that holds
even when RLS does not apply.

## Layout

| Path | What it is |
|---|---|
| `supabase/migrations/0001_init.sql` | Schema, policies, tenant trigger |
| `supabase/tests/0001_tenancy_test.sql` | Isolation and quality-gate assertions |
| `supabase/seed/dev_seed.sql` | Two dev tenants and their API keys |
| `mcp/` | The MCP server, in two transports: `mcp/src/stdio.ts` (local) and `mcp/src/http.ts` (hosted) |
| `web/` | Astro admin panel, SSR on Vercel |
| `scripts/dev-up.sh` | Local Postgres on :55432, migrated and seeded |
| `scripts/db-test.sh` | Throwaway Postgres, migration, tenancy tests |

## Local development

```bash
bash scripts/dev-up.sh          # prints the two env vars below
cd mcp && npm install
npm test                        # stdio + HTTP suites against the real database
```

## Connecting it to Claude Code

```bash
claude mcp add context-shared \
  --env CONTEXT_SHARED_DATABASE_URL=postgres://user:pass@host:5432/db \
  --env CONTEXT_SHARED_API_KEY=ctx_your_key \
  -- node /absolute/path/to/mcp/dist/index.js
```

## The one deployment rule

The server must connect as an ordinary Postgres role. Supabase's `service_role`
bypasses RLS entirely, which would leave every policy here decorative and expose
one tenant's context to another.

## Card shape

`why_not_obvious` is the quality gate, and the database enforces it. If the
publisher cannot say what the code and the spec fail to convey, there is no card
worth writing. `card_key` is a stable slug: republishing it updates the card
rather than adding a duplicate.

## Deploying the panel to Vercel

The panel runs as serverless functions, which changes one thing that matters:
**point `CONTEXT_SHARED_DATABASE_URL` at Supabase's transaction-mode pooler
(port 6543), never at the direct connection (port 5432).** Vercel spins up many
isolated instances, and each one opening its own direct connections exhausts
Postgres long before traffic does.

This works only because the tenant is set with `set_config(..., true)`, which
is transaction-scoped. A session-scoped setting would survive the transaction
and leak one tenant's id onto the next request that reuses the backend.

The MCP server is unaffected: it runs locally on each developer's machine and
uses the direct connection.

Environment variables to set in Vercel:

```
CONTEXT_SHARED_DATABASE_URL=postgres://...@...pooler.supabase.com:6543/postgres
CONTEXT_SHARED_API_KEY=ctx_...
```

## Two transports, one set of tools

`mcp/src/server.ts` registers the tools; each entrypoint only decides how the
caller is identified.

| Transport | Who it serves | How the org is resolved |
|---|---|---|
| stdio (`start:stdio`) | one developer, locally | once at startup, from `CONTEXT_SHARED_API_KEY` |
| HTTP (`start`) | the whole team, hosted | per request, from the `Authorization: Bearer` header |

That difference is not cosmetic. Over HTTP a single process serves every
caller, so resolving the org once and reusing it would hand the first caller's
tenant to everyone after them. `createContextServer` takes the org as an
argument and holds no shared state; `test/http-e2e.ts` asserts two tenants on
one process cannot see each other.

## Deploying the server to Railway

`mcp/railway.json` sets the build, the start command and the `/health` check.
In the Railway service settings:

1. Set **Root Directory** to `mcp` — the repo also holds `web/` and `supabase/`.
2. Set `CONTEXT_SHARED_DATABASE_URL` (Supabase transaction pooler, port 6543).
3. Leave `PORT` alone; Railway injects it and the server reads it.

Connecting a client to the hosted server:

```bash
claude mcp add --transport http context-shared https://<service>.up.railway.app/mcp \
  --header "Authorization: Bearer ctx_your_key"
```

`CONTEXT_SHARED_API_KEY` is deliberately not set on the server: over HTTP the
key belongs to the caller, not to the deployment.
