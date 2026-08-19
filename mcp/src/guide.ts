export const USAGE_GUIDE = `# context_shared — how this board expects to be used

The board holds two things, and choosing between them is the only decision you
have to make before publishing.

| | **Card** | **Change note** |
|---|---|---|
| Answers | "how does this module behave?" | "what did you change, and what do I do?" |
| Shape | a durable fact, rewritten in place | a dated event, anchored to a commit |
| Tool | \`publish_context\` | \`publish_change\` |
| Gate | \`why_not_obvious\`, 40 chars | at least one \`source_refs\` entry |

Tenancy is \`organization -> project -> card\`. Your API key names the
organization and nothing else: every project inside it is yours to read and to
write, which is the entire point of a shared board.

## Before you ask a teammate

Call \`search_context\`. Ask it the way you would ask a person — free prose
works, and a natural-language question falls back to a looser match when the
strict one finds nothing. It sweeps cards and change notes together; pass
\`kind\` only to narrow. Omit \`project\` to sweep the whole organization.

When you know something moved but not what to search for — the morning after
someone else's deploy, or picking up a module a teammate has been in — call
\`recent_changes\` instead. It is the feed: newest first, filterable by
\`project\`, \`module\` and \`since\`.

## Publishing a card

\`publish_context\` demands one thing the database will not let you skip:
\`why_not_obvious\`, 40 characters minimum, stating what the code and the spec
fail to convey. If the only honest answer restates the signature, there is no
card worth writing — stop there.

- Good: "The spec shows a plain string, but the key is unique per merchant and
  expires after 24h, so a retry the next day silently creates a second order."
- Bad: "This endpoint creates an order." — the spec already said that.

## Publishing a change note

\`publish_change\` is for what you just shipped. It does **not** ask whether the
change is obvious — most of it is legible in the diff, and that is fine. It
asks for something else: at least one \`source_refs\` entry. A note with nothing
verifiable behind it cannot be told apart from a rumour six weeks later.

Fill the two halves a diff never gives a reader:

- \`do_this\` — what a consumer has to do now.
- \`do_not\` — what they must stop doing, or would reasonably assume and get
  wrong. This is the field that earns the note.
- \`test_cases\` — \`{ scenario, expected }\`, so a reader can prove it on their
  side instead of taking your word for it.
- \`supersedes_cards\` — the \`card_key\`s this change made stale, so nobody
  trusts a card that stopped being true.

\`occurred_at\` is when the change landed, not when you wrote it down. Leave it
off and it defaults to now; correcting the note later never moves it.

## Naming a project

\`project\` is a plain name. "BipBip BackOffice" and "bipbip-backoffice" land on
the same slug, so nobody registers anything up front: publishing into a name
that does not exist creates it.

The one guard: a name one or two edits away from an existing project is refused
and the neighbour is named back to you. Publish under that neighbour, or repeat
the call with \`create_project: true\` when the split is deliberate. That guard is
what keeps \`bipbip-backoffice\` and \`bipbipbackoffice\` from becoming two boards
that each hold half the truth.

## Naming a card, naming a change

\`card_key\` is a stable kebab-case slug for the *fact*, not for the day you
learned it. Republishing the same key updates the card, so choose a key you
would choose again in six months: \`idempotency-scope\`, never
\`notes-from-tuesday\`.

\`change_key\` is the opposite kind of name: it identifies *one event*.
Republishing it corrects that note. A second change to the same module gets its
own key — overwriting the first one is exactly the history loss change notes
exist to prevent. \`orders-idempotency-window-2026-08\` is a good key.

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

## The rhythm

1. \`recent_changes\` when you come back to a module somebody else has touched.
2. \`search_context\` before assuming, and before asking a person.
3. Do the work.
4. \`publish_change\` for what you shipped, \`publish_context\` for what you
   learned that the code will never say.`;

export const SKILL_DOC = `---
name: context-shared
description: "Trigger: shared context, context board, what changed, why a module behaves this way, undocumented backend behaviour, publicar contexto, contexto compartido, qué cambió. Read the team board before asking, publish what you shipped and what the code cannot say."
---

# Shared context board

The \`context-shared\` MCP server holds two things: **cards** (durable facts a
module's consumers cannot learn from the code or the OpenAPI spec) and **change
notes** (dated accounts of what somebody shipped and what you must do about it).
Treat it as the first place to look and the last step of any non-obvious work.

## Read before you ask

Before asking a teammate how a module behaves, and before assuming a spec tells
the whole story, call \`search_context\` with the question in plain prose. It
sweeps both kinds. Leave \`project\` unset to sweep the organization.

When you know something moved but not what to search for — after a deploy, or
picking up a module a teammate has been in — call \`recent_changes\`.

## Publish what you shipped

Call \`publish_change\` when you finish something other people consume.

- \`source_refs\` is the gate: at least one commit, PR, endpoint or file.
- \`do_this\` and \`do_not\` are the point. The diff shows what changed; only you
  can say what a consumer must stop doing.
- \`test_cases\` are \`{ scenario, expected }\` pairs, so a reader can verify
  rather than trust.
- \`supersedes_cards\` names the \`card_key\`s this change made stale.
- \`change_key\` names one event. A later change gets a new key.

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

## Do not publish

As a card: anything already legible in the repository, the types, or the spec.
A board of restated signatures is worse than an empty one.

As a change note: anything you cannot anchor to a commit, PR, endpoint or file.

Call \`usage_guide\` on the server for the full contract.`;
