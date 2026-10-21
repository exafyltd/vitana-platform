# VTID-03926 — Operator Console chat: thread real userRole into processWithGemini()

## Report / context

While investigating the platform owner's claim that the Operator Console
lacks contextual/codebase understanding, direct code inspection of
`services/gateway/src/services/gemini-operator.ts` found a large existing
`dev_*` tool catalog (VTID-DEV-ASSIST, VTID-03835/03836/03837/03892):
`dev_search_codebase`, `dev_read_file`, `dev_aws_ecs_status`, `dev_db_query`,
plus the spec/PR/deploy pipeline (`dev_generate_spec` ... `dev_deploy_service`)
and a standing `dev_agent_memory` recall that runs on every operator turn.

None of it was reachable. `getRouterToolDefinitions(userRole)` hard-filters
every `dev_*` tool unless `userRole` is `'developer'`/`'admin'`
(`gemini-operator.ts:3411-3415`) — but `routes/operator.ts`'s `POST /chat`
handler never resolved or passed a `userRole` into `processWithGemini()` at
all (confirmed by reading the full handler, lines 135-345). Every call ran
with `userRole === undefined`, so `getRouterToolDefinitions()` stripped every
`dev_*` tool for **every** caller — including an authenticated exafy_admin
session — regardless of who was asking.

## Root cause

`routes/operator.ts`'s `/chat` handler already resolves a verified,
JWT-backed `callerIdentity` a few lines above the `processWithGemini()` call
(`const callerIdentity = (req as AuthenticatedRequest).identity;`, used for
VTID-03851's thread-auth marker) but never derived a `userRole` from it, and
never passed one into `processWithGemini({...})`'s input object — even
though that function's own type (`gemini-operator.ts:3666`) has accepted a
`userRole?: string` field since VTID-DEV-ASSIST specifically for this
purpose.

A separate, older helper in the same file — `getOperatorRole(req)` — reads
the client-supplied `x-operator-role` header and is used elsewhere (lines
648, 747) but is NOT authentication; using it here would let an
unauthenticated caller simply claim `admin` in a header and unlock every
`dev_*` tool (codebase search, DB reads, PR/deploy tools).

## Fix

Derive `userRole` from the already-verified `callerIdentity.exafy_admin`
(the same JWT-backed value the thread-auth marker uses) and pass it through:

```ts
const geminiUserRole = callerIdentity?.exafy_admin === true ? 'admin' : undefined;
const geminiResult = await processWithGemini({
  ...
  userRole: geminiUserRole
});
```

An unauthenticated caller, or an authenticated-but-non-admin caller, gets
`userRole: undefined` — identical to today's (already-correct) behavior for
those cases. Only a verified `exafy_admin` JWT unlocks `dev_*` tools.

## Acceptance Criteria

AC-1 — an unauthenticated request to `POST /api/v1/operator/chat` passes
`userRole: undefined` to `processWithGemini()`.

TEST: `outputs/jest-new-suite.txt` — "passes userRole: undefined for an
unauthenticated caller".

AC-2 — a request carrying a verified `exafy_admin: true` identity passes
`userRole: 'admin'`.

TEST: `outputs/jest-new-suite.txt` — "passes userRole: 'admin' for a
verified exafy_admin identity".

AC-3 — a verified but non-admin identity (`exafy_admin: false`) does NOT
get `userRole: 'admin'`.

TEST: `outputs/jest-new-suite.txt` — "does NOT grant admin tools for a
verified but non-admin identity".

AC-4 — the client-supplied `x-operator-role` header is never treated as
authorization for `dev_*` tools, even when it claims `admin`.

TEST: `outputs/jest-new-suite.txt` — "never trusts the client-supplied
x-operator-role header for tool authorization".

## Verification

- `tsc --noEmit`: clean (`outputs/tsc-noemit.txt`).
- New suite: `outputs/jest-new-suite.txt` — 4/4 passing.
- Full gateway suite (regression check, run before the VTID-03925 merge
  landed on this branch, and re-confirmed with `tsc --noEmit` + the two
  touched suites together after merging): `outputs/jest-full-suite.txt` —
  903/904 suites (1 pre-existing skip), 14,965/15,000 tests passing, 0
  failures.

## What this does NOT confirm

This unblocks the existing `dev_*` tool catalog and `dev_agent_memory`
recall for a verified admin caller — it does not itself add any new
capability (no RepoWise/Graphify wiring, no cross-session/thread
continuity beyond what `dev_agent_memory` already provides, no write/execute
parity with a Claude Code CLI session). Those are tracked as separate,
larger follow-ups, not folded into this narrow fix. This session has no
live authenticated Command Hub browser session to confirm end-to-end that
an admin's Operator Console chat can now actually call `dev_search_codebase`
against a real request — verified structurally (the wiring is correct and
tested) not against live traffic.

## OASIS impact

OASIS_IMPACT: no — request-shape fix only, no schema/event changes.
