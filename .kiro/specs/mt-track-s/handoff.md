---
slug: mt-track-s
author: kiro
author_seat: hotmail
executor: kiro
next_actor: claude
state: parked
updated: 2026-10-19T18:00Z
parked_from: drafted
---
# Handoff — mt-track-s (Track S security hotfixes S-A..S-L + Health Phase 0 live defects / WS10)

Highest-priority workstream of the multi-tenant program (`docs/MULTI-TENANT-PLAN.md` §3 + WS10). Planner: Kiro, seat
`hotmail`. The spec records that **16 of 17 Track S / WS10 items are already closed in production** (verified in current
code 2026-10-15, every premise cited at `file:line` in `plan.md` ## Problem) and plans only the one open residual.

Shipped already (build on, never re-plan): S-A VTID-05040 · S-B/S-D VTID-05041 · S-C VTID-04981 · S-E VTID-05043 ·
S-F/S-L VTID-05042 · S-G VTID-05044 · S-H VTID-05049/05120 · S-I VTID-05048 · S-M VTID-05147 · WS10 tokens VTID-05030 ·
WS10 webhooks VTID-05031 · WS10 confirmation/audit VTID-05055. S-K is closed in current `billing.ts`.

Lanes:
- `s-j-route-inventory` — executor **kiro** (seat `exafyltd`, area `frontend`, reviewer_seat `jtadic`), repo
  **vitana-v1**, `ready`. Removes the dead `linkedin-import` edge function (flagged for removal by VTID-05049) and adds
  an edge-function caller-auth inventory test. Code-only, no migration. HELD at `next_actor: owner` until PLAN-SPAR
  allocates its VTID (then it flips to `kiro`).
- `s-j-retire-function` — executor **claude** (reviewer_seat `jtadic`), repo **vitana-v1**, `ready`,
  `depends_on: [s-j-route-inventory]`. Adds `linkedin-import` to the `SUPABASE-FUNCTIONS-RETIRE.yml` `ALLOWLIST`,
  then dispatches it and records the `Confirm` read. HELD at `next_actor: owner` until PLAN-SPAR allocates its VTID.

Tracked residuals (not these lanes): (a) `switch_to_tenant_by_slug` lookup hardening — WS3 join-flow slice;
(b) `requireAuth` on dev-sandbox `/debug/memory` + `/debug/intent` — WS0 backlog; (c) security review of the 22
`LEGACY` C-unreviewed edge functions listed in `plan.md` ## Fix — WS0 route-inventory backlog.

Migrations: none. Reserved range `20261101010000`–`20261101015959` is unused and recorded only to reserve it.

## Log
### 2026-10-15T17:40:00Z · kiro-hotmail-202610151618-b437 · created → drafted
Wrote the spec (plan.md, requirements.md, design.md, tasks.md, lanes/s-j-route-inventory.md). Verified every Track S
item (S-A..S-M) and all four WS10 Health Phase 0 defects against current code with `file:line` citations: 16 CLOSED, 1
(S-J) with a small open residual (dead `linkedin-import` edge function + no committed edge-function auth inventory
test). The gateway-side generated route inventory and realtime-channel RLS are left to WS0 (M0), stated as an open
question for sparring. Single lane in vitana-v1. Next: PLAN-SPAR spars this plan; on converged, VTIDs are allocated and
the lane flips to `next_actor: kiro`.

### 2026-10-15T18:30:00Z · kiro-hotmail-202610151618-b437 · drafted (internal-review revision)
Addressed INTERNAL-REVIEW (REJECTED, 2 MEDIUM + 1 LOW). Verified both premises in current code:
`vitana-v1/vitest.config.ts:22` is `include: ['src/**/*.test.{ts,tsx}']` and `vitana-v1/package.json` `"test"` is
`node scripts/check-edge-data-client.mjs && node scripts/check-realtime-helper.mjs && vitest run` — so a vitest
`.test.ts` under `supabase/functions/**` would never run. Fixes applied across plan.md / requirements.md / design.md /
tasks.md / lanes/s-j-route-inventory.md: (MEDIUM-1 + LOW/NIT-1) the S-J inventory gate is now a node
`scripts/check-edge-function-auth.mjs` wired into `npm test` beside the existing `check-*.mjs` gates, not a vitest file,
and the "Vitest/Deno" ambiguity is dropped; (MEDIUM-2) lane `paths` and tasks.md "Allowed paths:" now cover
`scripts/check-edge-function-auth.mjs` + `package.json` (replacing the uncollectable `__tests__/…test.ts` glob) and
remain identical — `package.json` is not a governance path, so `executor: kiro` stands. Re-verified the S-J OPEN
residual still holds (`linkedin-import/index.ts` still ships + `config.toml:72`; no `src/**` consumer; `requireUser`/
`forbidden` exported from `_shared/caller-auth.ts:100,124`). queue.mjs validators re-run on handoff.md and
lanes/s-j-route-inventory.md (0 errors); tasks.md "Allowed paths:" identical to the lane `paths`. Open HIGH/MEDIUM
after this pass: 0.

### 2026-10-15T20:10:00Z · kiro-hotmail-202610151618-b437 · drafted (internal-review round 2 revision)
Addressed INTERNAL-REVIEW round 2 (REJECTED: 1 MEDIUM + 1 LOW) and one HIGH gap it surfaced that round 1 missed, all
re-verified in current code with file:line:
- **MEDIUM-1** — `vitana-v1/supabase/config.toml:72-74` has a `[functions.linkedin-import]` block (`verify_jwt = true`).
  Deleting the function orphans it. Added `supabase/config.toml` to the lane `paths` + identical tasks.md "Allowed
  paths:", and a T2 step to remove the block. Not a governance path → `executor: kiro` unaffected.
- **HIGH (new)** — the collected vitest suite `vitana-v1/src/lib/edge-functions-caller-identity.s4.test.ts` reads
  `linkedin-import/index.ts` and asserts the functions dir contains it (`:77-82,:90-93,:107-110,:198`). Deleting the
  function breaks this suite, and it is NOT in `src/**`-excluded territory (vitest `include` is `src/**/*.test.{ts,tsx}`
  — it IS collected). Added the file to `paths` + tasks.md and a T2a step to drop `linkedin-import` from its four
  assertions while keeping `social-media-import`/`fetch-user-context`. Round 1 missed this because it treated the
  deletion as isolated; it is not — a collected suite references the file.
- **LOW-1** — rewrote ## Staging verification to drop the edge-function invoke (a POST the read-only network guard
  aborts); the CI inventory gate + the updated Vitest suite are the authoritative proof (rule 48).
Re-verified: `linkedin-import/index.ts` still ships with the VTID-05049 "flagged for removal" comment and uses
`requireUser`/`forbidden` from `_shared/caller-auth.ts:100,124`; no `src/**` runtime consumer of `linkedin-import`
(only the test file + spec docs); `vitest.config.ts:22` include glob and `package.json` `"test"` chain unchanged.
queue.mjs validators re-run on handoff.md and lanes/s-j-route-inventory.md (0 errors); tasks.md "Allowed paths:"
identical to the lane `paths` (6 entries). Open HIGH/MEDIUM after this pass: 0.

### 2026-10-17T10:53Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (code_access_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-17T15:29Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T19:15Z · kiro-hotmail-202610151618-b437 · drafted (replan after partner evidence-floor no-op)
Round 1 (session `57140e67…`) escalated with `infra: false` on a partner-harness error, not a plan defect:
`evidence_floor_not_met` — the partner cited no file it read and produced 0 premise checks (round-1.md). Per the
replan rule for a stale/no-op escalation, re-verified the S-J premises against current vitana-v1 code today and
tightened three drifted line citations so a fresh session spars the live plan:
- `vitana-v1/vitest.config.ts` `include: ['src/**/*.test.{ts,tsx}']` is at **:19** (was cited `:22`) — corrected in
  plan.md ## Fix and lanes/s-j-route-inventory.md.
- `vitana-v1/src/lib/edge-functions-caller-identity.s4.test.ts`: the five-functions loop including `'linkedin-import'`
  is at **:77-88** (was `:77-82`), the profile-import loop at **:90-92** (was `:90-93`), the `flagged for removal`
  case still at **:107-110**, and the `arrayContaining([...])` scan assertion at **:272** (was `:198`) — corrected in
  plan.md ## Fix, tasks.md T2a, and the lane body.
Re-confirmed the S-J OPEN residual still holds: `supabase/functions/linkedin-import/index.ts` still ships with the
VTID-05049 "flagged for removal" comment and imports `requireUser, forbidden` from `_shared/caller-auth.ts`
(index.ts:1-4); `supabase/config.toml:72` still has `[functions.linkedin-import]`; `package.json:29` `"test"` is
`node scripts/check-edge-data-client.mjs && node scripts/check-realtime-helper.mjs && vitest run`; and the only
`src/**` reference to `linkedin-import` is that one test file (no runtime consumer). No lane/path/dependency change;
plan body unchanged except the three citations. queue.mjs validators re-run on handoff.md and
lanes/s-j-route-inventory.md (0 errors); tasks.md "Allowed paths:" identical to the lane `paths` (6 entries).

### 2026-10-18T19:31Z · kiro-hotmail-202610151618-b437 · drafted (answered s2-round-1 — all findings off-spec)
Fresh session `7bf15cbe-7042-4a54-9813-7f4efaac2935` (plan_text_sha `b73e525`, verdict in_progress) raised three
findings in `sparring/s2-round-1.md` (1 blocker + 2 major). Every finding describes lanes/routes that do not exist in
mt-track-s: `command-hub-tenant-module` + `scripts/ci/command-hub-ownership-guard.js` (R1-F1), a `tenant-admin-api`
lane scoping `admin-signups.ts`/`admin-autopilot.ts` via `require-tenant-admin.ts` (R1-F2), and tenant-scoping of
`admin-moderation.ts`/`admin-signups.ts` auth guards (R1-F3). mt-track-s has one OPEN lane, `s-j-route-inventory`
(vitana-v1): delete the dead `linkedin-import` edge function + add the node edge-function auth inventory gate; its
`paths` contain no gateway route, Command Hub file or tenant-admin middleware. The round's header session id
(`643ff85b…`) and plan hash (`53ed8eac…`) also do not match this session, so it reviewed another spec's plan
(mt-tenant-admin / mt-frontend-brand material; Command Hub guard belongs to mt-frontend-brand and moderation to
mt-tenant-admin P2/P3 per CROSS-SPEC-DECISIONS.md). All three rejected with code-cited rationale in
`sparring/s2-responses-1.md`; plan.md unchanged (no legitimate mt-track-s change these findings warrant). queue.mjs
validators re-run on handoff.md and lanes/s-j-route-inventory.md (0 errors).

### 2026-10-18T20:03Z · kiro-hotmail-202610151618-b437 · drafted (answered s2-round-2 — real findings, plan updated)
Round 2 (same session `7bf15cbe…`, plan hash `6dfbd440…`, verdict in_progress) corrected the record: the
`s2-round-1.md` *text* I answered last round was itself cross-contaminated with another spec's content; round 2
restates the partner's TRUE findings, which ARE about mt-track-s. Verified each against current code and
accepted/fixed all four in `sparring/s2-responses-2.md` + plan.md:
- **R2-F1 [major] accepted** — source deletion does not undeploy a Supabase edge function. Verified
  `vitana-v1/.github/workflows/supabase-functions-deploy.yml` only redeploys changed folders (no delete step) and
  `SUPABASE-FUNCTIONS-RETIRE.yml` is the dispatch-only, ALLOWLIST-gated undeploy (linkedin-import not yet on the
  allowlist; refuses while source present). Added a two-move closure to ## Fix/## Rollout/## Risks: (1) this Kiro lane
  deletes source/config/test refs; (2) a post-merge governance follow-up (executor **claude** — edits
  `.github/workflows/**`, dispatches the workflow, writes live Supabase) adds linkedin-import to the RETIRE ALLOWLIST
  and dispatches it, proven by its Confirm step. S-J 'still shipped' satisfied only once that run reports it absent.
- **R1-F3 [accepted]** — VTID-05044 closed BOTH S-G and S-K (verified: the S-K .maybeSingle→aggregate fix is annotated
  VTID-05044 at billing.ts:1308 + billing-repository.ts:281). Depends On now reads 'VTID-05044 (S-G + S-K)' and
  Problem #11 cites billing.ts:1305-1322 / billing-repository.ts:281-289 with the VTID.
- **R1-F2 [accepted, scoped]** — the inventory gate now must assert the caller-auth import AND an actual gate call
  (requireUser/isServiceRoleCaller/isTriggerSecretCaller), stated as a static heuristic (Deno funcs node/Vitest can't
  execute); before-the-body ordering stays covered by the collected s4 suite.
- **R1-F1 [accepted, evidence]** — the partner has no vitana-v1 pin so can't verify the line citations; all were
  re-verified accurate 2026-10-18 (config.toml:72, vitest.config.ts:19, package.json:29, s4 at :77-88/:90-92/:107-110/:272,
  index.ts:1-4) and the lane carries docs/validation evidence; no citation changed.
Plan body trimmed back to ≈15.6k chars after the additions, both plan markers + change_class intact. queue.mjs
validators re-run on handoff.md and lanes/s-j-route-inventory.md (0 errors); tasks.md "Allowed paths:" identical to
the lane `paths` (6 entries).
### 2026-10-18T22:45:00Z · kiro-202610182052-5ce2 · drafted (s2 round-2 answer repaired)
PLAN-SPAR run 39161855041 failed with `HTTP 400 unknown_finding:R1-F1`. The previous `s2-responses-2.md` listed
R1-F1..F3 in its JSON, but the gateway accepts only the answered round's own finding ids
(`plan-sparring-service.ts:341-345`), and s2-round-2 has only R2-F1. Rewrote `s2-responses-2.md`: the JSON now
answers R2-F1 (accepted; the retire follow-up runs on the deploy path with executor **claude**, never Kiro). The
corrected round-1 answers replace the contaminated, canned `s2-responses-1` rejections (copied from another spec:
command-hub / tenant-admin-api text). They are carried in the R2-F1 rationale and the plan: R1-F1 accepted (plan ## Fix
now pins the vitana-v1 citations to `vitana-v1@5c4632ea9`, all re-verified); R1-F2 accepted, scoped (import plus
gate call, static heuristic, ordering covered by s4 :93-96); R1-F3 accepted (VTID-05044 = S-G + S-K, billing.ts:1308,
billing-repository.ts:281). No command was run against a live system.

### 2026-10-18T22:47Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-19T17:50Z · kiro-hotmail-202610151618-b437 · drafted (s2 round-1 answered, session d0c274cd)
The resumed session d0c274cd raised R1-F1..F3; all accepted. R1-F1: vitana-v1 citations re-verified and re-pinned to
vitana-v1@32a82e6b6 (removal comment `linkedin-import/index.ts:6-8`, `social-media-import/index.ts:33,40,43`, s4 header
comment `:6` added). R1-F2: S-E record corrected — `switch_to_tenant_by_slug` checks only `open_signup` (parent §3
S-E rule). Tracked residual (not this lane): harden its lookup to `open_signup AND is_active AND NOT is_platform` in
the WS3 join-flow slice. R1-F3: `/debug/memory` + `/debug/intent` recorded as anonymous dev-sandbox-only; tracked
residual: `requireAuth` in the WS0 route-inventory backlog. No lane/path change. No live system touched.
### 2026-10-19T18:00Z · kiro-hotmail-202610151618-b437 · drafted (s2 round-2 answered, session d0c274cd)
R2-F1 accepted: the RETIRE follow-up is now lane `s-j-retire-function` (executor claude, vitana-v1, paths
`.github/workflows/SUPABASE-FUNCTIONS-RETIRE.yml` + `docs/validation/**`, depends on `s-j-route-inventory`, own VTID).
R2-F2 accepted: enumerated all 65 vitana-v1 edge functions at `32a82e6b6` — 6 import `_shared/caller-auth.ts` (each
calls a gate), 59 predate it (33 own getUser/getClaims, 1 stripe signature, 3 shared secret, 22 no recognised gate).
The gate is now a ratchet: the 59 go on a frozen in-script `LEGACY` map (no function file enters `paths`); new
functions must import + call caller-auth. The 22 C-unreviewed are tracked residual (c). Validators re-run (0 errors).
No live system touched.

### 2026-10-19T18:00Z · ci-plan-spar · drafted → parked
Not converged after 2 sparring sessions (round_cap_reached). Parked with the open findings in sparring/.
