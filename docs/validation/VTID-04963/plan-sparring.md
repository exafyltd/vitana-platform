# VTID-04963 — plan sparring record

- **Plan hash (sha256 of the text between the plan markers):** `a98aabd2b247a79193cc3a3489ab0b240989f6a48f518df54fdc97bddfc55e80`
- **Sparring session:** `plan_sparring_sessions.id = 5d739011-f302-4051-a27a-8a792aa5113d`
- **Partner:** `plan-sparring-partner` agent (independent, read-only; saw only the plan file)
- **Verdict:** CONVERGED
- **Owner approval:** d.stevanovic@exafy.io in the Claude Code session, 2026-10-07 — "Yes all four" (Gate 1, all four plans of the push-notification report). Binding exafy_admin click pending (`POST /api/v1/plans/spar/:id/approve`).

## Final plan

<!-- plan:begin -->
**Change class:** standard (`.github` deploy workflows + runtime gate)
**Repo:** exafyltd/vitana-platform
**Scope (in this order):**
1. `.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml` — pin `REMINDERS_INPROCESS_DISPATCH_ENABLED=true`
2. `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml` — pin `REMINDERS_STAGING_DISPATCH_OVERRIDE=true` + comment
3. then run `node scripts/conversation/generate-flag-pins.mjs` → commit the regenerated `conversation-flag-pins.generated.ts` (never hand-edited)
4. `services/gateway/src/env.ts` — new reusable helper `sharedDbLoopAllowed(overrideVar, env = process.env)`: true unless `VITANA_ENV==='staging'`, in which case true only if `env[overrideVar]==='true'` (designed so the calendar loops can adopt it later)
5. `services/gateway/src/services/reminders-dispatch.ts` — `isInProcessDispatchEnabled(raw, env = process.env)` (backward-compatible optional 2nd arg; existing `vtid-04320-reminders-dispatch.test.ts` calls keep working) = flag `'true'` AND `sharedDbLoopAllowed('REMINDERS_STAGING_DISPATCH_OVERRIDE', env)`
6. `services/gateway/src/services/guided-journey/audiobook-reminder-dispatch.ts` — `isAudiobookReminderLoopEnabled(env)` = `isInProcessDispatchEnabled(env.REMINDERS_INPROCESS_DISPATCH_ENABLED, env)` AND `env.AUDIOBOOK_REMINDERS_DISABLED !== 'true'` (audiobook kill switch preserved, layered on top)
7. Jest test for both gates

## Problem (verified)
- Production has NO reminders dispatcher: the in-process loop flag is `staging:"true", prod:null` (conversation-flag-pins.generated.ts:135), and the EventBridge `gateway-reminders-tick` job "has never been created in AWS" (scripts/aws/setup-eventbridge-cron-migration.sh:168-169).
- So the **staging** gateway (which shares the production Supabase project) is the only process claiming and pushing real members' reminders. `oasis_events` `reminder.fcm_fallback`: 145 events 2026-09-25 → 10-01, all `env:staging`, `appilix_sent:false` on every one, 81 with `fcm_devices:0` (= reminder reached nobody).
- Staging code is unverified-by-design (it runs every merge before PUBLISH) and may lack production's Appilix configuration. Real-member delivery must not depend on it. Also violates the standing pattern already used for rewards ("staging shares the database → only production acts", backend.md §13c rule 8).

## Change — two phases, order is mandatory (otherwise reminders stop entirely)
**Phase 1 (this PR):**
1. Prod workflow pins `REMINDERS_INPROCESS_DISPATCH_ENABLED=true` (same mechanism the stage workflow uses).
2. `isInProcessDispatchEnabled()` returns `false` when `VITANA_ENV==='staging'` **unless** `REMINDERS_STAGING_DISPATCH_OVERRIDE==='true'`. The stage workflow sets that override `true` in this same PR so staging behaviour is byte-identical until phase 2. (This keeps the merge→staging deploy from creating a gap before prod is PUBLISHed.)
3. Startup log states which branch applied (`staging, override=…`).
4. Dual dispatch between PUBLISH and phase 2 is safe for both loops: `reminders_claim_due()` claims with `FOR UPDATE SKIP LOCKED` (reminders-dispatch.ts:15); `claim_due_audiobook_reminders()` (migration 20261001130000) locks with `FOR UPDATE OF s SKIP LOCKED` and stamps `last_sent_local_date` in the same single SQL statement (CTE `due` → `stamped`), so a concurrent claim from the other environment cannot select the same user/day.

**Phase 2 (same VTID, follow-up PR, only after phase 1 is live in production):**
5. Gate: production logs `Reminder dispatch loop started` and `oasis_events` shows `reminder.*` with `env:production` for real reminders (read-only check).
6. Stage workflow sets `REMINDERS_STAGING_DISPATCH_OVERRIDE=false` → staging stops claiming.


## Explicitly NOT in this plan (reported to owner)
- `CALENDAR_DEFAULT_REMINDERS_ENABLED` / `CALENDAR_MAINTENANCE_ENABLED` are also staging-only loops that write real-member rows. Same class of issue; separate VTID if the owner wants it.

## Tests
Jest gate matrix:
- `VITANA_ENV` unset (real prod state) + flag true → on; `VITANA_ENV=production` + flag true → on
- staging + flag true + override unset → off; staging + flag true + override true → on; any + flag false → off
- audiobook: staging+flag+override true+`AUDIOBOOK_REMINDERS_DISABLED=true` → off; staging+flag true+override false → off; prod+flag true+disabled → off; prod+flag true → on
Existing operator/support suites unchanged.

## Staging verification (read-only)
`staging-tests.json`: GET staging `/alive` + build-info shows the deployed commit; read-only SQL confirms `reminder.*` events keep arriving with `env:staging` (override true) after phase 1. Production after PUBLISH: deploy check only (no test suite against prod) + read-only `oasis_events` query for `env:production` reminder events.

## Prod deploy
Phase 1 only reaches production via PUBLISH (or an owner-approved pinned dispatch). This plan does not dispatch prod.

## Rollback
Prod: `AWS-PROD-DEPLOY-GATEWAY.yml` dispatch with `deploy_mode=env-only` and `env_overrides={"REMINDERS_INPROCESS_DISPATCH_ENABLED":"false"}` (re-registers the current image, no code change). Staging: set `REMINDERS_STAGING_DISPATCH_OVERRIDE=true` back via the stage workflow.

## VTID
One VTID for both phases: one problem (who dispatches real-member reminders), rolled out in two ordered steps. The VTID stays open (not terminal) until phase 2 is verified.
<!-- plan:end -->

## Sparring rounds (partner findings, condensed from the partner's own wording)

### Round 1 — NOT CONVERGED
Verified premises: REMINDERS_INPROCESS_DISPATCH_ENABLED staging:"true", prod:null at conversation-flag-pins.generated.ts:135 (TRUE); EventBridge reminders jobs never created (setup-eventbridge-cron-migration.sh:167-170) (TRUE); reminders claim uses SKIP LOCKED (reminders-dispatch.ts:15) (TRUE); audiobook-reminder-dispatch reads the env var directly at :96-97 (TRUE).
- F1 [major] Routing the audiobook loop through the new gate must keep its own AUDIOBOOK_REMINDERS_DISABLED kill switch; spell out the conjunction.
- F2 [major] Confirm claim_due_audiobook_reminders is also safe under prod+staging dual dispatch.
- F3 [minor] The generated pins file is produced by generate-flag-pins.mjs from the workflows; order the steps.
- F4 [minor] Production runs with VITANA_ENV unset; test that case.
- F5 [minor] Add audiobook cases to the test matrix.
- F6 [minor] Spell out the rollback (env-only dispatch).
- Q1 reusable helper for the calendar loops? Q2 phase 2 under the same VTID?

### Round 2 — CONVERGED
F1–F6 closed (F2 verified independently at migration 20261001130000:68,70-76); Q1 closed; Q2 acknowledged (one VTID defensible). New F7 [minor]: keep `isInProcessDispatchEnabled` backward compatible with existing test calls — accepted (optional env arg).

## Planner responses

## Planner responses — round 1
- F1 (audiobook gate design) — ACCEPTED. `isAudiobookReminderLoopEnabled` now = staging-aware dispatch gate AND its own kill switch (scope item 6).
- F2 (audiobook dual-dispatch) — ACCEPTED, verified: `claim_due_audiobook_reminders` locks `FOR UPDATE OF s SKIP LOCKED` and stamps `last_sent_local_date` in the same statement (migration 20261001130000:56-76). Stated in plan.
- F3 (generator ordering) — ACCEPTED. Scope reordered: workflows → generator → commit.
- F4 (VITANA_ENV unset on prod) — ACCEPTED. Test case added.
- F5 (audiobook test cases) — ACCEPTED. Added.
- F6 (rollback mechanism) — ACCEPTED. env-only dispatch spelled out.
- Q1 (reusable utility) — ACCEPTED: `sharedDbLoopAllowed(overrideVar)` in env.ts; calendar loops adopt it under their own VTID.
- Q2 (phase 2 VTID) — keep one VTID: phase 2 is the completion of the same fix, not a distinct piece of work; the ledger row stays non-terminal until phase 2 is verified, which is what rule 2b's "one VTID per distinct piece of work" intends.

## Planner responses — round 2
- F7 (signature) — ACCEPTED: env is an optional second arg, backward compatible with existing tests.
