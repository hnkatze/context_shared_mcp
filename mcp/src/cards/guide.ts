export const USAGE_GUIDE = `# context_shared — how this board expects to be used

A card carries what a consumer of a module **cannot learn from the code or the
OpenAPI spec**. Anything the repository already states belongs in the
repository, not here.

Tenancy is \`organization -> project -> card\`. Your API key names the
organization and nothing else: every project inside it is yours to read and to
write, which is the entire point of a shared board.

## Before you ask a teammate

Call \`search_context\`. Ask it the way you would ask a person — free prose
works, and a natural-language question falls back to a looser match when the
strict one finds nothing. Omit \`project\` to sweep the whole organization; pass
it only to narrow. \`list_projects\` shows what exists and how much each holds.

## Before you publish

\`publish_context\` demands one thing the database will not let you skip:
\`why_not_obvious\`, 40 characters minimum, stating what the code and the spec
fail to convey. If the only honest answer restates the signature, there is no
card worth writing — stop there.

- Good: "The spec shows a plain string, but the key is unique per merchant and
  expires after 24h, so a retry the next day silently creates a second order."
- Bad: "This endpoint creates an order." — the spec already said that.

## Naming a project

\`project\` is a plain name. "BipBip BackOffice" and "bipbip-backoffice" land on
the same slug, so nobody registers anything up front: publishing into a name
that does not exist creates it.

The one guard: a name one or two edits away from an existing project is refused
and the neighbour is named back to you. Publish under that neighbour, or repeat
the call with \`create_project: true\` when the split is deliberate. That guard is
what keeps \`bipbip-backoffice\` and \`bipbipbackoffice\` from becoming two boards
that each hold half the truth.

## Naming a card

\`card_key\` is a stable kebab-case slug for the *fact*, not for the day you
learned it. Republishing the same key updates the card instead of adding a
duplicate, so choose a key you would choose again in six months:
\`idempotency-scope\`, never \`notes-from-tuesday\`.

## What a good card carries

| Field | What belongs there |
|---|---|
| \`summary\` | one line stating the fact |
| \`why_not_obvious\` | the gate: what code and spec do not say |
| \`decisions\` | choice, the alternative rejected, and why it lost |
| \`gotchas\` | what bites someone who assumes the obvious |
| \`consumer_notes\` | what a caller must do differently |
| \`source_refs\` | commit, PR, endpoint or file — so a stale card can be checked |
| \`tags\` | how a future reader would search for this |

\`source_refs\` matters more than it looks: a card written from a compacted
session is a claim until something verifiable anchors it.

## The rhythm

1. \`search_context\` before assuming, and before asking a person.
2. Do the work.
3. \`publish_context\` for whatever you learned that the code will never say.`;

export const SKILL_DOC = `---
name: context-shared
description: "Trigger: shared context, context board, why a module behaves this way, undocumented backend behaviour, publicar contexto, contexto compartido. Read the team board before asking, and publish what the code cannot say."
---

# Shared context board

The \`context-shared\` MCP server holds what a module's consumers cannot learn
from the code or the OpenAPI spec. Treat it as the first place to look and the
last step of any non-obvious discovery.

## Read before you ask

Before asking a teammate how a module behaves, and before assuming a spec tells
the whole story, call \`search_context\` with the question in plain prose. Leave
\`project\` unset to sweep the organization; set it only to narrow the answer.

## Publish what the code will never say

When you discover something a future caller would get wrong — an implicit
contract, a scope that is not in the type, an ordering the spec omits — call
\`publish_context\`.

- \`why_not_obvious\` is the gate, 40 characters minimum. If it can only restate
  the signature, do not publish.
- \`card_key\` is a stable slug for the fact. Republishing it updates the card.
- \`project\` is a plain name; it is created on first use. A near-miss of an
  existing name is refused — publish under the neighbour it names, or repeat
  with \`create_project: true\`.
- Fill \`source_refs\` with a commit, PR, endpoint or file, so the card stays
  checkable once the session that wrote it is gone.

## Do not publish

Anything already legible in the repository, the types, or the spec. A board of
restated signatures is worse than an empty one: it costs a read and returns
nothing.

Call \`usage_guide\` on the server for the full contract.`;
