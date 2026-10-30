---
lane: team-welcome-backend
state: in-review
next_actor: kiro
vtid: VTID-05205
depends_on: []
claimed_by: kiro-jtadic-202610291040-a0e6
branch: kiro/new-member-welcome/team-welcome-backend
pr: https://github.com/exafyltd/vitana-platform/pull/4133
updated: 2026-10-30T15:50Z
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

### 2026-10-30T15:50Z · kiro-jtadic-202610291040-a0e6 · executing → in-review
Closing record for the merged lane (plan `say-hello-lane-reassign` §4); no code changes in this PR. The previous claimant
(`kiro-202610150924-9ecd`, a Kiro session of 2026-10-15) has been inactive for over 24 h and no
`collab-claim/new-member-welcome/team-welcome-backend` ref existed; this session claimed the lane (§5) and took over `claimed_by`.
- code: exafyltd/vitana-platform#4133, merge `995e27a236731f95d6e1af6b266e3cc7aecaa765` (`docs/validation/VTID-05205/outputs/gh-merge-shas.txt`);
- migration `20261015150000_vtid_05205_welcome_team_claims.sql` is present in the shared database (read-only check:
  `welcome_team_claims` table and `claim_welcome_message` / `finish_welcome_message` exist);
- sender mapping verified against the approved spec and the owner's 2026-10-30 confirmation: Mariia Maksina = @mariia04 =
  `67c971fc-48f3-49ce-aaa8-cddb6fa9e63a` (vitana_id `mariia11` is the same account), Jovana Tadić = @jovana4, Alex BLUE = @dragan1
  (`docs/validation/VTID-05205/outputs/sender-mapping.txt`);
- nothing is sent from staging (`disabled-on-staging`); sending, timing, retries, send-once and reply routing are covered by
  `test/vtid-05205-welcome-team.test.ts` (36 tests). Go-live (`WELCOME_TEAM_MODE=live` etc. in production) is a separate owner/release step and is NOT done.
next_actor: kiro (independent review by vitana-lane-reviewer, then verified).
