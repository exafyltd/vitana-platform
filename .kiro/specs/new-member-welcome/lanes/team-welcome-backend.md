---
lane: team-welcome-backend
state: parked
next_actor: kiro
vtid: VTID-05205
depends_on: []
branch: kiro/new-member-welcome/team-welcome-backend
pr: https://github.com/exafyltd/vitana-platform/pull/4133
updated: 2026-11-01T18:02Z
parked_from: executing
seat: exafyltd
---
# Three team welcome DMs (gateway + migration)

Plan: `.kiro/specs/new-member-welcome/` — the plan block in `plan-sparring.md` and the lane section in `tasks.md` are
authoritative (requirements/design text that says "comment" or "backing post" is superseded; owner decision D2 = b: the
greeting is a private DM on explicit Send). VTID: VTID-05205 (allocated, `in_progress`/`approved` in the ledger).
Repo: vitana-platform. Tasks A1–A7 in `tasks.md`; design: plan block Part A and S1/S2/S5/S6.
Rules for the executor (collaboration §7a): no VTID allocation, no merge/approve/deploy, no Supabase/AWS writes — DB changes
are migration files in this lane's PR. Copy `.kiro/specs/new-member-welcome/plan-sparring.md` to
`docs/validation/VTID-05205/plan-sparring.md` in your PR and add `scope.json`, `acceptance.md` and `staging-tests.json` there.

## Log
### 2026-10-15T09:40Z · kiro-202610150924-9ecd · created → ready
Drafted. next_actor: claude (spar → Gate 1 → allocate VTID), then kiro executes.

### 2026-10-15T13:00Z · session_01LKkSBuw1tGgnKzjhfcmAxj · ready → ready (handed to Kiro)
Owner approved the plan at Gate 1; VTID VTID-05205 allocated. Lane handed to Kiro: `next_actor: kiro` (no seat: any Kiro session). Start by claiming the lane
(`queue.mjs claim new-member-welcome/team-welcome-backend --session <your id>`); respect `depends_on` — do not start before those lanes are `done`.

### 2026-10-15T14:30Z · kiro-202610150924-9ecd · ready → executing (PR opened, ready for review)
Claimed and implemented A1–A7 on `kiro/new-member-welcome/team-welcome-backend`. Nothing is sent in any environment by
this change: every switch is off by default and staging refuses the tick.
- A1 `services/gateway/src/services/welcome-team/config.ts` — modes `disabled-on-staging|off|shadow|live`; `live` needs
  `WELCOME_TEAM_SEND_ENABLED=true` AND `WELCOME_SENDER_NAMES_CONFIRMED=true` (S6); closed pilot by default; ids, stagger,
  tenant, gap, cap and reviewed locales configurable.
- A2 migration `20261015150000_vtid_05205_welcome_team_claims.sql` — `welcome_team_claims` PK (user_id, sender_slug),
  `claim_welcome_message` / `finish_welcome_message` (service_role only). PGlite: 30/30 checks.
- A3 `welcome-team-service.ts` — strict exclusion (fail closed), one welcome per member per tick, ≥ 20 h gap, DM authored by
  the sender's own account (replies land in their inbox), one `new_chat_message` push.
- A4 `tt()` keys `welcome_team.{mariia,jovana,alex}.body[_noname]` in de/en + 8 more locales; `ar` left out as the coverage
  suite requires; members outside `WELCOME_TEAM_READY_LOCALES` (default de,en) get English.
- A5 `POST /api/v1/scheduled-notifications/welcome-team-tick` (own token check, 409 on staging),
  `GET /api/v1/welcome-team/status` (read-only), EventBridge job added to `setup-eventbridge-cron-migration.sh` (not created).
- A6 `test/vtid-05205-welcome-team.test.ts` — 36 tests (`npm run test:welcome-team`); mutation-checked.
- A7 `docs/validation/VTID-05205/` — scope, acceptance, staging-tests (read-only), sparring copy, PGlite check, outputs.

**For the reviewer (Claude Code) — please decide:**
1. *Pilot members are counted from the rollout.* An allowlisted pilot member who joined before `WELCOME_ROLLOUT_AT` gets the
   three welcomes, staggered from the rollout. Without this the closed pilot reaches nobody (S5 excludes earlier joiners).
   Narrow it if you prefer (one line in `runWelcomeTeamTick`).
2. *One push per welcome* as `new_chat_message` (like any DM from that person). The plan named the DM only.
3. `test/vtid-04226-eventbridge-test-contract-schedules.test.ts`: job-count pins 33 → 34 for the new job, plus an assertion
   for it. One test there fails locally only because this sandbox has no `openssl` (unrelated script).
Other decisions are listed in `docs/validation/VTID-05205/acceptance.md` → "Decisions taken".

After merge (not mine): apply the migration (`RUN-MIGRATION.yml`), deploy, STAGING-VERIFY, then the go-live steps in the
acceptance file (sender display names confirmed → set `WELCOME_SENDER_NAMES_CONFIRMED`, pilot allowlist, flags, EventBridge job).
next_actor: claude (review + merge).
### 2026-11-01T15:55Z · pm-agent · executing → parked
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-11-01T15:59Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-11-01T16:03Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-11-01T16:07Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-11-01T16:11Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-11-01T16:39Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-11-01T16:43Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-11-01T16:47Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-11-01T16:51Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-11-01T16:57Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-11-01T17:02Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-11-01T17:06Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-11-01T17:10Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-11-01T17:40Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-11-01T17:46Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-11-01T17:50Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-11-01T17:54Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-11-01T17:58Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-11-01T18:02Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
