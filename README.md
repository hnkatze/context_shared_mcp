# context_shared

A curated context board for a team of agents. Publishing is explicit: a human
decides what goes up, the agent writes it.

The board holds two things, and the difference between them is the whole design.

| | **Card** | **Change note** |
|---|---|---|
| Answers | "how does this module behave?" | "what did you change, and what do I do?" |
| Shape | a durable fact, rewritten in place | a dated event, anchored to a commit |
| Tool | `publish_context` | `publish_change` |
| Gate | `why_not_obvious`, 40 chars | at least one `source_refs` entry |

A card is the right shape for an implicit contract that outlives any one
commit. It is the wrong shape for "Gustavo changed this endpoint yesterday":
the upsert that keeps the board free of duplicates also erases the previous
version, so by the time a second change lands the first one is gone. A change
note is dated, never claims to describe the whole module, and therefore carries
what a card must refuse — what a consumer has to do, what they must not, and
the test cases that prove it.

Tenancy is `org -> project -> {card, change note}`, enforced by RLS and, one
layer below it, by a composite foreign key that holds even for a role RLS does
not apply to.

## Layout

| Path | What it is |
|---|---|
| `supabase/migrations/0001_init.sql` | Schema, policies, tenancy |
| `supabase/migrations/0002_change_notes.sql` | Change notes, and the search index reaching `source_refs` |
| `supabase/tests/` | Isolation, quality-gate and search assertions, one file per migration |
| `supabase/seed/dev_seed.sql` | Two dev tenants and their API keys |
| `mcp/` | The MCP server, in two transports: `mcp/src/stdio.ts` (local) and `mcp/src/http.ts` (hosted) |
| `scripts/dev-up.sh` | Local Postgres on :55432, migrated and seeded |
| `scripts/db-test.sh` | Throwaway Postgres, every migration, every SQL suite |

Both scripts iterate the directories in filename order, so a new migration or a
new SQL suite is picked up without editing them.

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

**Connect as a dedicated role. Never with the credentials Supabase hands you.**

Postgres lets two kinds of role walk past row level security:

| Escape hatch | Stopped by |
|---|---|
| owning the table | `FORCE ROW LEVEL SECURITY`, which this schema sets |
| the `BYPASSRLS` attribute | nothing — it outranks FORCE |

The default `postgres` role of a Supabase project carries `BYPASSRLS`, and so
does `service_role`. Connecting with either makes every policy here decoration
while the application keeps working perfectly, which is the worst possible
failure mode: silent, and only visible once two organizations are on the board.

Create the application role once, as `postgres`:

```sql
create role context_app login password :>password<:
  nosuperuser nocreatedb nocreaterole nobypassrls;
grant usage on schema public, app to context_app;
grant select, insert, update, delete on all tables in schema public to context_app;
grant execute on all functions in schema app to context_app;
```

Migrations run as `postgres` (it owns the tables). Everything else — the MCP
server and any other consumer — logs in as `context_app`. `supabase/tests` asserts the
role in use carries neither `BYPASSRLS` nor superuser, so a regression here
fails the suite instead of leaking quietly.

One thing that grant does not do: `on all tables in schema public` is
point-in-time. It does not reach a table created by a later migration, and the
symptom is narrow enough to miss — the board keeps working and one new tool
returns a permission error. `0002` therefore grants its own table to
`context_app` and `mcp_app` when those roles exist, and every migration after it
must do the same.

## The two gates

Each entity pays its own toll, and the database collects both.

`why_not_obvious` is the card gate: 40 characters minimum stating what the code
and the spec fail to convey. If the publisher cannot say that, there is no card
worth writing.

A change note cannot use that gate — most of what it says *is* legible in the
diff, which was the whole reason cards refused to hold it. Its gate is
`source_refs`, at least one entry, enforced by
`check (jsonb_array_length(source_refs) >= 1)`. A card with nothing non-obvious
to say is noise; a change note with nothing verifiable behind it is a rumour,
and six weeks later a reader cannot tell one from a half-remembered Slack thread.

## Keys, and what republishing means

`card_key` is a stable slug for a *fact*. Republishing it updates the card
rather than adding a duplicate — the fact moved, and the board should say so
once.

`change_key` names one *event*. Republishing it corrects that note; it does not
restate the module. A second change gets its own key, because overwriting the
first is exactly the history loss change notes exist to prevent.

`occurred_at` is when the change landed, not when somebody got around to
writing it down — the feed orders by it, and correcting a note never moves it.

## Searching

`search_context` sweeps both kinds and renders changes above cards, on the
grounds that when the two disagree the change is the more recent account by
construction. `kind` narrows to one. `limit` applies per kind, so asking for ten
never returns ten changes and silently no cards.

`recent_changes` is the feed: newest first, filtered by `project`, `module` and
`since`. It exists for the state everybody is in the morning after somebody
else's deploy — knowing something moved, but not what to search for.

Migration `0002` also puts `source_refs` and `decisions` into the search index.
Before it, the most natural question a reader has — "what do we know about
`POST /v1/orders`" — matched nothing even when a card named exactly that route,
and the reason an alternative lost was unsearchable the moment it was written
down.

## Naming a project

`project` is a plain name, not a registration. "BipBip BackOffice" and
`bipbip-backoffice` land on the same slug, and a project nobody has used yet is
created by the publish that first mentions it. The API key names the
organization and stops there: every project inside it is readable and writable,
which is the whole point of a shared board.

One guard sits on that convenience. A name one or two edits away from a project
that already exists is refused, and the neighbour is named back to the caller.
Publishing into `bipbipbackoffice` while `bipbip-backoffice` holds twelve cards
is almost always a typo, and the two boards a silent create would produce each
hold half the truth — the worst outcome here, because both look healthy. When
the split is deliberate, `create_project: true` carries it through.

## Telling an agent how to use the board

`usage_guide` returns the contract in prose: when to publish a card and when a
change note, what clears each gate, how a project gets named, and how to search
before asking a teammate. Called with `as_skill: true` it returns the same
contract as a `SKILL.md`, so an agent can be handed the conventions without
being handed this README.

## The tools

| Tool | What it is for |
|---|---|
| `list_projects` | what exists, and how many cards and changes each project holds |
| `search_context` | the board, both kinds, asked in plain prose |
| `recent_changes` | the feed, newest first, by `project` / `module` / `since` |
| `publish_context` | a durable fact the code and the spec do not state |
| `publish_change` | what you shipped, and what consumers must do and must not do |
| `usage_guide` | the contract above, optionally as a `SKILL.md` |

## A note for serverless consumers

The admin panel lives in its own repository. Anything that reads this board
from a serverless runtime inherits one constraint: point it at the
transaction-mode pooler (port 6543), never at the direct connection, and cap
the pool at one connection per instance. Many isolated instances each opening
direct connections exhaust Postgres long before traffic does.

That is safe here only because the tenant is set with the transaction-local
form of `set_config`. A session-scoped setting would outlive the transaction
and leak one tenant onto the next request sharing the backend.

## Two transports, one set of tools

`mcp/src/server.ts` registers the tools; each entrypoint only decides how the
caller is identified.

| Transport | Who it serves | How the org is resolved |
|---|---|---|
| stdio (`start:stdio`) | one developer, locally | once at startup, from `CONTEXT_SHARED_API_KEY` |
| HTTP (`start`) | the whole team, hosted | per request, from the `Authorization: Bearer` header — an API key, or an OAuth access token |

That difference is not cosmetic. Over HTTP a single process serves every
caller, so resolving the org once and reusing it would hand the first caller's
tenant to everyone after them. `createContextServer` takes the org as an
argument and holds no shared state; `test/http-e2e.ts` asserts two tenants on
one process cannot see each other.

## Deploying the server to Railway

The repository holds three deployables, so the root `Dockerfile` builds only
the MCP server. Railway detects it with no Root Directory setting, which its
Railpack builder needs here: pointed at the repository root it finds no
manifest and refuses to guess.

Set two variables on the service:

```
CONTEXT_SHARED_DATABASE_URL=postgresql://context_app.<ref>:<password>@<region>.pooler.supabase.com:6543/postgres
CONTEXT_SHARED_PUBLIC_URL=https://<service>.up.railway.app
```

`PORT` is injected by Railway. `CONTEXT_SHARED_API_KEY` is deliberately absent:
over HTTP the key belongs to the caller, so setting one here would pin every
caller to a single tenant.

`CONTEXT_SHARED_PUBLIC_URL` is the origin clients reach, and OAuth discovery is
built on it. The `resource` it produces must equal the URL a user types into
Claude character for character, so a wrong value does not degrade the connector
— it stops it from ever finding the authorization server. Unset, the server
says so on startup and advertises localhost.

Connecting a client to the hosted server:

```bash
claude mcp add --transport http context-shared https://<service>.up.railway.app/mcp \
  --header "Authorization: Bearer ctx_your_key"
```

`CONTEXT_SHARED_API_KEY` is deliberately not set on the server: over HTTP the
key belongs to the caller, not to the deployment.

## Adding it to Claude as a custom connector

Claude Code accepts a header, so the command above hands it a key directly. The
custom connector dialog in Claude Desktop and claude.ai does not: it offers a
URL and, at most, OAuth client credentials. That is why this server is also an
authorization server.

Add the connector with the MCP URL and nothing else:

```
https://<service>.up.railway.app/mcp
```

Leave the OAuth fields in Advanced settings empty. Claude registers itself
dynamically (RFC 7591), discovers the endpoints, and opens a consent page that
asks for one thing: an API key for your organization.

What the key buys is a token, not a session. The key proves who you are once and
is never stored by Claude, never written into a config file, and never sent
again. What Claude keeps is an access token that expires in an hour, is bound to
this exact server as its audience, and dies the moment the key behind it is
revoked.

| Endpoint | Purpose |
|---|---|
| `/.well-known/oauth-protected-resource/mcp` | names the resource and points at the authorization server |
| `/.well-known/oauth-authorization-server` | the OAuth metadata Claude reads next |
| `/register` | dynamic client registration |
| `/authorize` | the consent page that asks for an API key |
| `/token` | code exchange and refresh, both with rotation |

Three behaviours are deliberate and will look like bugs if you meet them
without warning:

- **A wrong PKCE verifier burns the authorization code.** A verifier that does
  not match means whoever holds the code did not start the flow.
- **Replaying a code revokes the tokens it already minted.** A replayed code is
  evidence it leaked; losing a live session is the right price for that.
- **Reusing a rotated refresh token ends the whole chain — after a 10 second
  grace window.** Two parties holding one refresh token is the signature of a
  stolen one, so the chain dies. Inside the window the same presentation is
  read as one client submitting twice and is merely refused.

That window is not timidity, it is the only available discriminator. A replay
arriving milliseconds after a rotation and a client double-submitting are the
same bytes on the same endpoint; nothing in the request distinguishes them.
Burning unconditionally kills real sessions on a network retry, and never
burning abandons reuse detection. Ten seconds keeps detection for every replay
that is not simultaneous, and a replay inside the window is still caught by the
next legitimate rotation.

Revoking an API key ends every token minted from it in the same instant, with
no sweep and no delay: resolving a token joins onto its key on every request.
