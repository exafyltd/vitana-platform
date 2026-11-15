# VTID-05800 - anyone can allocate a VTID (any person, machine or process)

Owner order, 2026-11-15 (Kiro Web session `kiro-exafy-202611132341-8c70`): *"remove all the rules that limit allocation
of vtid only through cicd available. allocating a vtid should be the easiest thing in the worls, manually possible,
single click possible, any way that you can imagine should make it possible for any machine any human with any process
to allocate a fresh vtid. check the codebase and remove every single rule that is preventing from that and wriote the
fix right away"*

VTID-05800 itself was allocated with the existing `VTID-ALLOCATE` workflow (run 43689172564), not through PLAN-SPAR,
on that order. There is no sparring record for this change: it removes the rule that required one before a VTID.

VALIDATION_PROFILE: gateway_backend (gateway route and middleware, a migration file, a CLI, two workflows, rule texts).
Nothing is applied from the PR: the migration is applied later through `RUN-MIGRATION.yml` after the owner approves the
file and the target database (collaboration.md section 7d). Kiro ran no SQL and made no write against any live system
for this change; the only live calls were two read-only GETs of `/api/v1/vtid/allocator/status` (staging and
production) to record the current state.

ROUTE_MOUNT: `/api/v1/vtid` (`services/gateway/src/index.ts:803`, `mountRouterSync(app, '/api/v1/vtid', vtidRouter)`),
unchanged. No route is added: the existing `POST /allocate` and `POST /allocate-internal` change their middleware to
`allowVtidAllocation`, and `GET /allocator/status` gains three fields.
FINAL_URL: `POST https://preview-aws-gateway.vitanaland.com/api/v1/vtid/allocate` (staging),
`POST https://gateway.vitanaland.com/api/v1/vtid/allocate` (production); status at `GET …/api/v1/vtid/allocator/status`.
CURL_PROOF: read-only, before the deploy (2026-11-15):
`curl -s https://preview-aws-gateway.vitanaland.com/api/v1/vtid/allocator/status` →
`{"ok":true,"enabled":true,"env_var_enabled":true,"db_control":{"enabled":true,"expires_at":null,...},"message":"Allocator is active. All task creation paths should use POST /api/v1/vtid/allocate."}`
(production returns the same). After the staging deploy, STAGING-VERIFY runs the same GET and expects
`allocation_access: "open"` and `sparring_required: false` (`staging-tests.json`). No POST is sent to staging or
production for proof: each one allocates a real VTID in the shared ledger; the POST behaviour is proven by the jest
suites listed below.

OASIS_PROOF: the only OASIS change is that `POST /allocate` and `/allocate-internal` no longer emit
`vtid.plan_sparring.missing` for an allocation without a sparring id; a cited sparring id still emits
`vtid.plan_sparring.attached`. Pinned by `vtid-05800-free-vtid-allocation.test.ts` ("allocates for an anonymous caller
… needs no sparring record": `emitOasisEvent` not called) and `vtid-04868-plan-sparring-service.test.ts` ("OASIS at
allocation": attached with a sparring id). The event type stays in the union for old rows.

## What blocked a free allocation, and what this change does

| Blocker (file on `main`) | Change |
|---|---|
| `POST /api/v1/vtid/allocate` behind `requireLedgerWriteAuth` (VTID-04727): 401 without the service token or an exafy_admin JWT where `LEDGER_WRITE_AUTH_MODE=enforce` (staging today) | New `allowVtidAllocation` middleware: never 401, records the caller, limits only anonymous bursts |
| `POST /api/v1/vtid/allocate-internal`: 500 without `VTID_ALLOC_SECRET` configured, 401 without the header | Same middleware; the secret is optional and only identifies the caller |
| `isVtidAllocatorEnabled`: off unless the env var is `true` or the DB control is enabled and not expired | On by default; off only for `VTID_ALLOCATOR_ENABLED=false` or an explicitly disabled control |
| `vtid_ledger` BEFORE INSERT trigger `trg_plan_sparring_check` (rule 54; refuses a row without an approved sparring record in `enforce` mode) and the one-VTID-per-sparring-id unique index | Migration `20261115090000` drops the trigger and the index and sets `plan_sparring_config.mode = 'off'`; rollback file kept here |
| Hourly reconciler flags VTIDs without a sparring id, the trigger state and break-glass rows as P1 | Those three checks removed; the config and policy-approval checks stay |
| OASIS `vtid.plan_sparring.missing` on every allocation without a sparring id | Emitted only when a sparring id is cited |
| PreToolUse hook `.claude/hooks/pretooluse-plan-sparring-reminder.sh` (both repos) denied an allocation without a sparring record | Deleted with its `settings.json` entry |
| `VTID-ALLOCATE.yml`: title required, fails without the token secret | Every input optional, token optional, falls back to production; a copy is added to vitana-v1 |
| Rule texts: CLAUDE.md ALWAYS 2b, rules 51/54/55, IF-THEN 1, section 4.1; collaboration.md section 7a; AGENTS.md; steering; pipeline runbooks; automations; reviewer agent; plan-sparring skill and partner; routine prompt; both repos | Rewritten: anyone allocates at any time by any path; sparring reviews a plan before its code merges, never before its VTID |
| Gateway Kiro session rules and the Kiro write-tool `vtid` description: "You cannot create one: a VTID exists only after a plan has been sparred" | Kiro allocates a missing VTID itself with `scripts/dev/new-vtid.mjs` |

## Acceptance

AC-1 An anonymous caller, a caller with a wrong or expired token, and any signed-in user allocate a VTID with
`POST /api/v1/vtid/allocate` (201) in every `LEDGER_WRITE_AUTH_MODE`, `enforce` included, with no sparring record.
`POST /api/v1/vtid/allocate-internal` allocates without `X-VTID-Alloc-Secret`.
TEST: `vtid-05800-free-vtid-allocation.test.ts` "POST /api/v1/vtid/allocate is open to everyone" (red on `origin/main`:
401 and 500, see commands.log).

AC-2 The caller is recorded, never rejected: `service:internal` (service token), `service:alloc-secret`, `admin:<id>`,
`user:<id>`, else `anonymous`. TEST: "who is allocating (never a 401)".

AC-3 Anonymous callers are limited to 30 a minute and 300 an hour per client (`VTID_ALLOC_ANON_PER_MINUTE`,
`VTID_ALLOC_ANON_PER_HOUR`, 0 = off) and get 429 `rate_limited` past it. The client is the last `X-Forwarded-For` hop
(the address the ALB appended), so callers behind the ALB do not share one bucket and a forged first hop does not
open a new one. Identified callers are never limited. TEST: "rate limited per client", "behind the ALB each client has
its own bucket", "anonClientKey".

AC-4 `source: self-healing` (eligibility criterion 5 for autonomous execution) is refused with 403 `reserved_source`
unless the caller is the service token, the alloc secret or an exafy_admin. Every other source is free.
TEST: "refuses the self-healing source from an anonymous caller".

AC-5 Allocation is on by default; the only refusal is a deliberate off switch (409 `allocator_disabled`).
TEST: "allocation is on by default", "a deliberate off switch is the only refusal";
`vtid-04876-ops-attention-reads.test.ts` (allocator control reads as on when its row is missing).

AC-6 `GET /api/v1/vtid/allocator/status` reports `allocation_access: "open"`, `sparring_required: false` and the list
of allocation paths. TEST: "the status endpoint"; on staging: `staging-tests.json` (read-only GET).

AC-7 The migration drops `trg_plan_sparring_check` and `vtid_ledger_sparring_id_unique` and sets the gate mode to
`off`, in one transaction, idempotent; the rollback restores log mode, the index and the trigger.
TEST: "a migration drops the vtid_ledger sparring trigger and index".

AC-8 The reconciler no longer reads the trigger or flags VTIDs without a sparring id; no `missing` OASIS event is
emitted. TEST: `vtid-04868-plan-sparring-service.test.ts` reconciler and "OASIS at allocation" cases.

AC-9 `node scripts/dev/new-vtid.mjs ["<title>"]` allocates from anywhere: staging gateway, then production, then the
`VTID-ALLOCATE` workflow through `gh`; prints the VTID. TEST: `node --test scripts/dev/new-vtid.test.mjs` (7 pass).

AC-10 `VTID-ALLOCATE` (both repos) runs with no input and no token. TEST: "the one-click workflow needs no input and no
token".

AC-11 No rule file in either repo limits allocation to CI or forbids allocating by hand; the hook is gone.
TEST: "no rule file limits allocation to CI or forbids allocating by hand"; `vtid-04868-plan-sparring-session-layer`.

AC-12 The gateway Kiro session rules tell Kiro to allocate a missing VTID itself and no longer say it cannot.
TEST: `vtid-05018-kiro-thread-memory.test.ts` "the rules tell Kiro to allocate a missing VTID itself".

AC-13 Unchanged: `POST /api/v1/vtid/create` and every other ledger write route still need the service token or an
exafy_admin (`requireLedgerWriteAuth`); plan sparring itself (rounds, verdicts, approvals, policy approval); the
`allocate_global_vtid` grants (service_role only); the PR-GATE sparring-record check (report-only).
TEST: `vtid-04727-ledger-write-auth.test.ts`, `vtid-04868-plan-sparring-service.test.ts`.

## Decisions taken

- Anonymous allocation is rate limited per client instead of unlimited, to protect the five-digit VTID space.
- `source: self-healing` stays reserved, because it makes a task eligible for autonomous execution (NEVER 34).
- `POST /api/v1/vtid/create` stays behind `requireLedgerWriteAuth`: it creates a task with caller-chosen status and
  metadata. A fresh VTID comes from `/allocate`.
- No `EXECUTE` grant on `allocate_global_vtid` to `anon` or `authenticated`: a direct grant would bypass the off switch
  and the rate limit. The SQL path is for sessions that already have database access.
- The off switch is kept, with its default flipped to on.
- The migration drops the trigger instead of only setting the mode to off, so the gate cannot come back by a mode flip.
- No new GitLab job and no new Command Hub button: the Command Hub task Create button already calls `/allocate`, and
  the GitLab central CI is red on `main` for reasons outside this change.
- `queue.mjs` `planLaneQualifies` and the PR-GATE sparring-record check are unchanged: they govern trust in plan lanes
  and PR evidence, not allocation.
