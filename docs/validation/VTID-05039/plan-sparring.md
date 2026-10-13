# VTID-05039 — plan sparring record

- Sparring session: `81e090b8-657f-4168-9b3c-021888ccd01e` (`plan_sparring_sessions`, attested tier)
- Change class: standard · Rounds: 2 · Verdict: **CONVERGED**
- Partner: `plan-sparring-partner` agent (read-only: Read/Grep/Glob), independent context, saw only the plan file and the code
- Final plan hash (sha256 of the text between the plan markers): `f3eed7b3cf589eba3e02992d3827306f683bc63101bcee8e89f56820873b70e6`
- **Owner approval (Gate 1):** d.stevanovic@exafy.io, 2026-10-10, in the Claude Code session: "Yes"

## Partner findings (verbatim)

### Round 1 — NOT CONVERGED
- F1 [major] The scheduler job targets the PRODUCTION gateway by default, but there is no env-override kill switch for the schedule itself -- only for the flag. … the plan should acknowledge that the kill switch does NOT stop the schedule from firing -- it only makes the gateway return `{ok: true, mode: 'off'}` harmlessly.
- F2 [minor] `VOA_ROLLOUT_DATE` is set to the merge date, but the jq block approach strips-and-re-adds by name -- every future unrelated prod deploy will carry this date forward. … Add a comment in the workflow next to `VOA_ROLLOUT_DATE` noting it is a one-time owner decision.
- F3 [minor] The plan says "26 real members today" but does not specify which tenant or how multi-tenant the coach is.
- F4 [minor] The baseline measurement references `auth.sessions` for D1/D7 return, but Supabase `auth.sessions` is a Supabase-managed table whose schema and retention are not under this project's control.
- F5 [major] The plan proposes read-only SQL against production for the baseline measurement but does not specify who runs it or how.
- Questions: tenant scope of `runCoachTick`; whether the guard test should pin `VOA_MODE` absence; `auth.sessions` retention.

### Round 2 — CONVERGED
- F1–F5 closed. "No new blocker or major findings. … the safety posture is sound (staging stays off by construction, shadow mode sends nothing, test accounts are excluded with a strict-fail gate)."

## Implementation notes (after approval)
- `VOA_ROLLOUT_DATE` = `2026-10-10`, the day of the approval and the merge. With it the cohort is members who joined on or after 2026-09-10.
- The pins are a separate workflow step, built the same way as the reward-payouts step. `env_overrides` runs after it, which is what makes the plan's kill switch work.
- `vtid-04226-eventbridge-test-contract-schedules.test.ts` pins the job count. It moves from 30 to 31 for the one job this plan adds, following the same pattern as VTID-04444 and VTID-04505. That is a deliberate contract change, not a loosening.

## Final plan — Plan B — VOA: start the onboarding coach in shadow mode in production + baseline measurement

Change class: **standard** (production deploy workflow env, scheduler script, docs). No migration, no new route.
Scope (repo `exafyltd/vitana-platform`):
- `.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml` (pin two env vars)
- `scripts/aws/setup-eventbridge-cron-migration.sh` (one job row)
- `services/gateway/test/vtid-<id>-onboarding-coach-shadow-start.test.ts` (new; workflow + schedule guard)
- `docs/validation/<VTID>/` (acceptance.md, commands.log, outputs/, staging-tests.json, plan-sparring.md,
  `baseline.md` + the read-only SQL that produced it)
- `docs/plans/VITANA-ONBOARDING-ASSISTANT-PLAN.md` §5 (record that the scheduler moved from slice 6 to here;
  slice 0 items 2–3 status)

<!-- plan:begin -->
## Problem (verified 2026-10-10)

Slice 1 (VTID-04892, `b6166667`) is in production (`gateway.vitanaland.com` build-info `c230bb71`, a descendant
of `b6166667`), but the coach has never run: `GET /api/v1/onboarding-coach/status` on production returns
`{mode:"off", reason:"feature_off"}`, the three coach tables have 0 rows, and no `onboarding.coach.*` event exists.
Three things are missing, none of which slice 1 shipped:
1. `FEATURE_ONBOARDING_ASSISTANT_ENV` is not set on the production task definition
   (`services/gateway/src/services/onboarding-coach/config.ts` → `isFeatureLive('ONBOARDING_ASSISTANT')`; accepted
   values `off | staging-only | staging+prod`, `services/gateway/src/services/feature-flags.ts`).
2. `VOA_ROLLOUT_DATE` is not set (config resolves `off / rollout_date_missing` without a valid `YYYY-MM-DD`).
3. Nothing calls `POST /api/v1/scheduled-notifications/onboarding-coach-tick`. The plan put the scheduler in
   slice 6; without it, shadow mode (plan §6.2) collects nothing.

Plan v3 §6.2 is the purpose: compare "what Vitana would have done" with real behaviour before anything is sent.

## Change

1. **Prod deploy workflow** — pin, in the same declared-env block as the other `FEATURE_*_ENV` pins
   (`AWS-PROD-DEPLOY-GATEWAY.yml`, the `jq` block that strips and re-adds `FEATURE_ORB_*`):
   - `FEATURE_ONBOARDING_ASSISTANT_ENV = "staging+prod"` (staging still resolves `disabled-on-staging` first in
     `resolveCoachConfig`, so staging stays off by construction);
   - `VOA_ROLLOUT_DATE = <the merge date, literal YYYY-MM-DD>` → cohort = members who joined from rollout − 30 days
     (owner decision: the last 30 days of joiners are included) and are still inside 90 days.
   - `VOA_MODE` stays unset (= shadow). Slice 1 has no live mode; `live` would still report shadow.
   Kill switch, no code change: a dispatch with `env_overrides {"FEATURE_ONBOARDING_ASSISTANT_ENV":"off"}`. The
   schedule keeps firing after that; the tick then returns `200 {mode:"off"}` without reading or writing anything
   (`scheduled-notifications.ts`, the early return before `runCoachTick`). Full silence = also run the scheduler
   script with `--only gateway-onboarding-coach-tick --delete`.
   A workflow comment next to `VOA_ROLLOUT_DATE` says it is a one-time owner decision (the cohort anchor), not a
   per-deploy toggle; changing it changes who is in the cohort.
   Pinning (not unpinned) is deliberate: the VTID-03513/04127 lesson — a flag that only lives on the live task
   definition gets lost or resurrected by unrelated deploys.
   The staging deploy workflow is not changed.
2. **Scheduler** — add one row to the shared Scheduler→Lambda job table in
   `scripts/aws/setup-eventbridge-cron-migration.sh`, same shape and auth as `gateway-reminders-tick`:
   `gateway-onboarding-coach-tick | 17 6 * * * | UTC | /api/v1/scheduled-notifications/onboarding-coach-tick | {} |
   {"auth":"gateway_internal","token_secret_id":"$PROD_INTERNAL_TOKEN_SECRET_ID"}` — once a day, production
   gateway only. Once a day (not hourly): one decision per member per local day is all shadow mode records, and an
   hourly tick would emit 24 `tick_completed` OASIS events a day for no new information (OASIS is for state
   transitions, not loops).
   Running the script needs AWS credentials this session does not have; the owner (or any session/operator with
   the CloudShell role) runs it once after the production publish — it is create-or-update and idempotent. This is
   listed in Gate 2 as the one manual step. Until it runs, the coach is enabled but idle (no harm).
3. **Guard test** (Jest): the prod workflow does not set `VOA_MODE` (shadow stays the only mode until a sending
   slice changes it on purpose), pins `FEATURE_ONBOARDING_ASSISTANT_ENV` to a recognised value and
   `VOA_ROLLOUT_DATE` to a valid date; the staging workflow does not set either; the scheduler table has exactly
   one onboarding-coach row, targeting the tick path with `gateway_internal` auth, daily.
4. **Baseline measurement** (plan v3 §3 item 4, read-only SQL, results committed as `baseline.md`): for primary
   members of tenant `2e7528b8-…` who joined in the last 60 days, excluding `service_bot_accounts` and
   `notification_test_actors`: count; D1 and D7 return (an `auth.sessions` row on day 1 / within days 2–7 after
   joining — primary source `auth.audit_log_entries` login events (kept since 2025-08-30), cross-checked with
   `auth.sessions` (since 2025-09-07; rows can disappear on sign-out, so it under-counts); both are
   Supabase-managed and their retention is not ours — `baseline.md` records the date range each query saw);
   time to first ORB conversation (first `oasis_events` voice-session-start row for the user);
   welcome-DM reply rate (share of joiners whose welcome DM got any reply from a recipient within 7 days). Exact
   queries are committed alongside, so the numbers can be re-run after shadow mode for comparison. Read-only; no
   writes. Run by this session through the Supabase MCP `execute_sql` (SELECT only; read access verified
   2026-10-10 — the premises above were measured that way), not delegated.
5. **Plan doc** — slice 0 items 2–3 recorded as resolved/superseded:
   - item 2 (guarantee `user_journey` row): already true — trigger `on_user_journey_created` on `auth.users`
     inserts it; 0 of 237 primary members lack a row. The coach does not depend on it (it takes `joined_at` from
     `user_tenants.created_at`). Not built.
   - item 3 (coach-only `onboarding_completed_at`): superseded by `onboarding_coach_state.stage` (`done` at 90
     days) shipped in slice 1. Not built.

## What production does after this (shadow only)
Once a day the coach reads the cohort — cross-tenant by design (`coach-repository.ts` `fetchCohortCandidates`:
primary memberships since the cohort start, no tenant filter), with both allowlists excluded across all tenants
(strict lookup; a failed lookup skips the tick). Snapshot today: 26 real members, all in one tenant; a new tenant's
joiners would be included automatically, writes one `onboarding_coach_decisions` row per member
per local day and upserts `onboarding_coach_state`, and emits one `onboarding.coach.tick_completed` (+ a
`stage_changed` per real change). It sends nothing: no push, no DM, no post, no pacer touch, no wallet call (pinned
by slice 1's "no send path" test). `onboarding_touch_ledger` stays empty.

## Tests / verification
- Jest guard (above) + existing `npm run test:onboarding` (27 tests) in CI.
- Staging (read-only, `staging-tests.json`): `GET /api/v1/onboarding-coach/status` → `disabled-on-staging` (proves
  the flag cannot enable staging); untokened `POST …/onboarding-coach-tick` → 401; the Jest suites.
- After the production publish (Gate 2 "yes"): read-only `GET /api/v1/onboarding-coach/status` on production
  → `{mode:"shadow", reason:"shadow"}` (an unauthenticated read-only GET, the post-deploy check class allowed by
  rule 48). After the scheduler's first run: read-only SQL shows decision rows for cohort members only, 0 rows for
  service/test accounts, 0 ledger rows, one `tick_completed` event.
- Nothing is triggered by hand against production: no manual POST to the tick.
<!-- plan:end -->

## Planner responses — round 1
- F1 [major] ACCEPTED — the plan now states the flag kill switch leaves the schedule firing (harmless early return `{mode:"off"}`, no reads/writes) and gives the full-silence step (`--only … --delete`).
- F2 [minor] ACCEPTED — workflow comment marks `VOA_ROLLOUT_DATE` as a one-time owner decision; stays pinned (the VTID-03513/04127 reason).
- F3 [minor] ACCEPTED — cross-tenant by design, cited (`fetchCohortCandidates`, no tenant filter); exclusion covers both allowlists across tenants; 26 is a snapshot (1 tenant today).
- F4 [minor] ACCEPTED — primary source switched to `auth.audit_log_entries` login events (since 2025-08-30), `auth.sessions` as a cross-check with its under-count caveat; retention caveat and the observed date ranges go into `baseline.md`.
- F5 [major] ACCEPTED — the session runs the SELECTs itself via Supabase MCP `execute_sql`; access verified today.
- Q2: ACCEPTED — the guard test also asserts the prod workflow does not set `VOA_MODE`.
- Q3: answered in F4 (audit log is the login-event source; sessions are not).
