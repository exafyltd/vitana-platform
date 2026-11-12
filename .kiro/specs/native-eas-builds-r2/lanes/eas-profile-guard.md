---
lane: eas-profile-guard
state: ready
next_actor: kiro
depends_on: []
executor: kiro
area: frontend
seat: exafyltd
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-v1]
paths:
  - scripts/native/eas-profile-guard.mjs
  - scripts/native/__tests__/eas-profile-guard.test.mjs
  - docs/validation/VTID-*/scope.json
  - docs/validation/VTID-*/staging-tests.json
  - docs/validation/VTID-*/plan-sparring.md
updated: 2026-11-08T12:11Z
vtid: VTID-05666
---
# Guard for `apps/mobile/eas.json` (decisions 3 and 6)
Plan: `.kiro/specs/native-eas-builds-r2/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: eas-profile-guard -->` are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start


**Goal.** A node check that `apps/mobile/eas.json` keeps the two rules of the plan: only the `development` and `test-g1`
build profiles, and no secret in the file. The check reads the file and does not change it. It runs in the existing
NATIVE-CI script-test step through `scripts/native/__tests__/*.test.mjs`.

**Acceptance (reviewer = agent:vitana-lane-reviewer):**
- Change types: Tooling/docs.
- Outcome: a PR that adds a `production` profile, a `submit.production` block, or a secret-like key to `eas.json`
  turns the NATIVE-CI script-test step red. The current file passes.
- Staging proof: not verified on staging: native app has no staging deploy; proven by the test and by the mutation run.
- The check covers: profiles exactly `development` and `test-g1`; each profile's `APP_PROFILE` is one of those two;
  no key named `production` in build or submit; no secret-like key (`EXPO_TOKEN`, `*Token`, `*Secret`, `*Password`,
  `password`, `p8`, `keystorePath`, `serviceAccountKeyPath`); a `submit` block, if present, is only for `test-g1` and
  only with `track: internal`. Store identifiers (`ascAppId`, `bundleIdentifier`, `packageName`) are allowed.
- Mutation evidence: each rule broken once in a scratch copy turns the test red, recorded in the PR body.
- `docs/validation/<VTID>/{scope.json, staging-tests.json, plan-sparring.md}` added; `staging-tests.json` is read-only.

**Never** (collaboration §7a): no VTID allocation, no merge or approval by the builder, no workflow dispatch, no
write to Supabase, AWS, the gateway or any store, no test against production.

## Log
### 2026-11-08T11:48Z · kiro-exafyltd-202611072144-1c88 · ready
Lane created with the plan (re-plan of `native-eas-builds/eas-profile-guard`, PR #4771).

### 2026-11-08T12:11Z · ci-plan-spar · ready (VTID allocated)
VTID-05666 allocated after policy approval (converged-auto-v1).
