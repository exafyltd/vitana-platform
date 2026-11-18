---
lane: store-declarations
state: ready
next_actor: kiro
depends_on: [prereq-exit]
executor: kiro
seat: exafyltd
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
reviewer_seat: agent:vitana-lane-reviewer
area: frontend
repos: [exafyltd/vitana-v1]
paths:
  - apps/mobile/app.config.ts
  - apps/mobile/src/i18n/*/healthStore.json
  - apps/mobile/tests/store/**
  - docs/validation/native-wave3/store-declarations.md
  - docs/validation/VTID-*/scope.json
  - docs/validation/VTID-*/staging-tests.json
  - docs/validation/VTID-*/plan-sparring.md
updated: 2026-11-08T12:07Z
vtid: VTID-05663
---
# Store declarations: HealthKit, Health Connect and the iOS privacy manifest
Plan: `.kiro/specs/native-wave3-release-r2/` — `plan.md` (decision 4) and the `tasks.md` section marked
`<!-- lane: store-declarations -->` (tasks S1–S4) are authoritative. VTID: assigned by CI after PLAN-SPAR converges.
Waits for `prereq-exit` (Wave 1 Health Sync module and Wave 2 ledger).

**Goal.** Declare in `apps/mobile/app.config.ts` exactly the health data types the Health Sync module (contract v1)
reads, with HealthKit usage strings and Health Connect permission entries, plus the iOS privacy manifest. Usage
strings are catalog entries in all 11 locales (de first, du-form). Record the data map for the Play Data safety form
and the App Store privacy labels. Store submission is owner-gated (`store-submission-owner`).

**Acceptance (reviewer: hotmail):** the contract test shows every declared health type is in the Health Sync contract;
every string key exists in 11 locales; the iOS manifest lists only collected data; the production guards in
`app.config.ts` are unchanged; `npm test` and `npm run typecheck` pass; the offline bundle passes for `development`
and `test-g1`.

**Never:** no hardcoded user-visible string, no declared type the app does not read, no store submission, no
credential, no production host.

## Log
### 2026-11-08T12:30Z · kiro-exafyltd-202611072144-1c88 · ready
Lane created with the plan (re-plan of `native-wave3-release/store-declarations`, PR #4770).

### 2026-11-08T12:07Z · ci-plan-spar · ready (VTID allocated)
VTID-05663 allocated after policy approval (converged-auto-v1).
