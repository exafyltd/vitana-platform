# VTID-05797 — plan sparring record

Sparring reference: abaf654db295dd732 · Plan hash (sha256 of the plan block): 6819dc74474bff300871d34dd23183b9473867d8c6bcb9dff92b52cde4d327c3
Verdict: CONVERGED (round 2, Sonnet fallback; Opus 4.6 unavailable, HTTP 429 usage credits). Owner Gate 1: "yes" in session, 2026-11-13.

---

# Plan: pass the staging group-account secrets into STAGING-VERIFY

Change class: standard (CI / .github / scripts/ci — not frontend-simple).
Repo: exafyltd/vitana-platform. Companion (already pushed, not merged): exafyltd/vitana-v1 branch
fix/vtid-05622-group-test-account (83b198334), which makes the VTID-05622/05670 group check sign in with
STAGING_GROUP_TEST_EMAIL / STAGING_GROUP_TEST_PASSWORD when set.

<!-- plan:begin -->
## Problem
STAGING-VERIFY (community-app) runs the VTID-05622/05670 Playwright spec. The shared test user (TEST_USER_*) is in no
group, so the group-opening check fails (run 43253362504 @ bd68f967). A dedicated staging group account (admin of
staging-test-group) exists; its credentials are repo secrets STAGING_GROUP_TEST_EMAIL / STAGING_GROUP_TEST_PASSWORD.

## Change
1. `.github/workflows/STAGING-VERIFY.yml`, step "Run STAGING-VERIFY" (env block, around line 185): add
   `STAGING_GROUP_TEST_EMAIL: ${{ secrets.STAGING_GROUP_TEST_EMAIL }}` and
   `STAGING_GROUP_TEST_PASSWORD: ${{ secrets.STAGING_GROUP_TEST_PASSWORD }}`, with the same read-only comment as
   TEST_USER_*.
2. `scripts/ci/staging-verify/run.mjs` (line ~345, the explicit test-process env): add the two variables next to
   TEST_USER_EMAIL / TEST_USER_PASSWORD, `process.env.X || ''`, so the spec receives them. No other variable is passed.
3. `scripts/ci/staging-verify/run.mjs`: capture the group pair into local constants at start-up and delete both
   `process.env` entries, so git, `gh`, `npm ci` (target-repo lifecycle scripts) and `playwright install` never inherit
   them. Only the explicit Playwright env (step 2) carries the values. The capture and delete run inside the verify
   path (not at module import), so `deploy-runs.test.mjs`, which imports run.mjs and edits process.env, is unaffected.
4. `scripts/ci/staging-verify/workflow.test.cjs` (existing source-scan pattern): assert that the group pair appears only
   in the Playwright env builder, is deleted from `process.env` at start-up, and that the TEST_USER pair is unchanged.
5. Both-or-neither: if only one of the two group secrets is set, run.mjs logs a warning naming the missing one and
   passes neither (the spec then falls back to TEST_USER and fails honestly).
6. Companion spec (vitana-v1, same branch): when the group pair is set, select only the group named
   `staging-test-group` (by name, not `Alle Beisammen`/`list[0]`); if it is not in the list, fail with a clear message.
   The spec requires both secrets or neither (no empty password).

## Not changed
- No secret values in the repo or logs (GitHub masks them; the runner never prints env).
- The shared TEST_USER account, its data, and every other spec's sign-in.
- The read-only guard: staging-guard.ts is unchanged; the group account only reads the group list and opens a chat.
- No production path: STAGING-VERIFY runs against staging only; the deploy workflows are untouched.

## Pre-requisites (gates before merge)
- The two secrets must also exist in exafyltd/vitana-platform (STAGING-VERIFY reads that repo's secrets). They were
  added to vitana-v1 only. Owner confirms.
- VTID-03991 / rules 43–45: the group account is registered in `service_bot_accounts` and `notification_test_actors`
  before merge, and the owner confirms it is absent from member directories, rosters and "new member" feeds.
- The owner confirms `staging-test-group` holds at least one message; otherwise the spec's `msg-` wait fails for the
  wrong reason.

## Scope (files)
- .github/workflows/STAGING-VERIFY.yml
- scripts/ci/staging-verify/run.mjs
- scripts/ci/staging-verify/workflow.test.cjs (the existing source-scan test)
- vitana-v1 (companion, same branch fix/vtid-05622-group-test-account):
  tests/e2e/staging/vtid-05622-group-chat-opens-at-newest.staging.spec.ts

## Test plan
- `node --test scripts/ci/staging-verify/` green, including these exact assertions in workflow.test.cjs:
  (a) the two group variables appear only inside the runPlaywright env builder;
  (b) they are deleted from process.env in the verify path;
  (c) the TEST_USER_* pair is unchanged;
  (d) the workflow env block passes the two secrets to the verify step only.
- After merge to main: STAGING-VERIFY community-app on the merge commit; the VTID-05622/05670 check must run (not
  "in no group") and pass or report a real failure; the other specs keep the TEST_USER account.

## Decisions taken (conservative)
- Two new variables, not a repurposed TEST_USER pair (other checks depend on the shared user's state).
- Fallback: if the group secrets are absent, the spec uses TEST_USER and fails honestly (no skip).
- Existing TEST_USER_* inheritance by git/gh/npm/playwright-install is a pre-existing residual, out of scope here;
  listed as a follow-up, not changed in this PR.
<!-- plan:end -->

## Planner responses (round 1)
- F1 [major] ACCEPTED: plan now scrubs the group pair from `process.env` at start-up (steps 3–4); the claim is narrowed
  to "only the Playwright env carries the group pair".
- F2 [major] ACCEPTED: registration in both allowlists is a pre-merge gate (Pre-requisites); verification is an owner
  confirmation, not a code change.
- F3 [major] ACCEPTED: the companion spec pins to `staging-test-group` by name when the pair is set (step 6). This is a
  vitana-v1 change on the same branch.
- F4 [minor] ACCEPTED: both-or-neither warning (step 5); the secrets gate is a pre-merge pre-requisite.
- F5 [minor] ACCEPTED: the spec requires both or neither (step 6).
- F6 [minor] ACKNOWLEDGED: class is standard; sparring required, no VTID until converged. Merge order: platform
  workflow first, then the spec change; the spec falls back safely if the secrets are absent.
- Q1: registration is a pre-merge gate (owner confirms). Q2: yes, pinned by name. Q3: fixing, not narrowing (F1 step 3).

## Planner responses (round 2)
- Round 2 (abaf654db295dd732, Sonnet fallback): verdict CONVERGED. No open blocker or major.
- N1 [minor] ACCEPTED: scope list corrected (workflow.test.cjs; vitana-v1 companion spec added).
- N2 [minor] ACCEPTED: capture and delete run in the verify path, not at import (step 3).
- N3 [minor] ACCEPTED: exact test assertions (a)–(d) named in the test plan.
- N4 [minor] ACCEPTED: owner confirms staging-test-group has at least one message (pre-requisites).
