---
lane: new-member-card-optin
state: executing
next_actor: claude
vtid: VTID-05206
seat: jtadic
area: frontend
depends_on: []
claimed_by: kiro-exafyltd-202610161022-9aff
branch: kiro/new-member-welcome/new-member-card-optin
pr: https://github.com/exafyltd/vitana-v1/pull/1441
updated: 2026-10-16T11:40Z
---
# New-member card opt-in + feed source

Plan: `.kiro/specs/new-member-welcome/` — the plan block in `plan-sparring.md` and the lane section in `tasks.md` are
authoritative (requirements/design text that says "comment" or "backing post" is superseded; owner decision D2 = b: the
greeting is a private DM on explicit Send). VTID: VTID-05206 (allocated, `in_progress`/`approved` in the ledger).
Repo: vitana-v1 (+ migration). Tasks B1–B4 in `tasks.md` (no backing post, no `post_kind`).
Rules for the executor (collaboration §7a): no VTID allocation, no merge/approve/deploy, no Supabase/AWS writes — DB changes
are migration files in this lane's PR. Copy `.kiro/specs/new-member-welcome/plan-sparring.md` to
`docs/validation/VTID-05206/plan-sparring.md` in your PR and add `scope.json`, `acceptance.md` and `staging-tests.json` there.

## Log
### 2026-10-15T09:40Z · kiro-202610150924-9ecd · created → ready
Drafted. next_actor: claude (spar → Gate 1 → allocate VTID), then kiro executes.

### 2026-10-15T13:00Z · session_01LKkSBuw1tGgnKzjhfcmAxj · ready → ready (handed to Kiro)
Owner approved the plan at Gate 1; VTID VTID-05206 allocated. Lane handed to Kiro: `next_actor: kiro`, seat `exafyltd` (area `frontend`). Start by claiming the lane
(`queue.mjs claim new-member-welcome/new-member-card-optin --session <your id>`); respect `depends_on` — do not start before those lanes are `done`.

### 2026-10-16T11:40Z · kiro-exafyltd-202610161022-9aff · ready → executing (PR opened, ready for review)
Claimed and implemented B1–B4 in exafyltd/vitana-v1#1441 (branch `kiro/new-member-welcome/new-member-card-optin`).
Nothing is sent or posted; the migration only adds a column and is applied after merge with the new manual
`apply-vtid-05206-community-intro-opt-in-migration.yml`.
- B1 `supabase/migrations/20261016110000_vtid_05206_community_intro_opt_in.sql`: `global_community_profiles.
  community_intro_opt_in boolean NOT NULL`. Existing rows get false, then DEFAULT true for signups (`handle_new_user` omits the
  column). No backfill and no policy/grant/trigger/REPLICA IDENTITY/publication change; a self-check rolls back otherwise.
  PGlite: 17/17.
- B2 both new-member listings (`useAllNewsFeed` All tab, `useNewsFeed` Community tab) filter `community_intro_opt_in = true`;
  the All tab also skips anything but an explicit true; a failed read shows no card.
- B3 `CommunityIntroToggle` in Settings → Privacy → Profile visibility (desktop Spotlight + legacy, phone MobileSettings),
  owner row only through the existing RLS policy. Registration name step (`OnboardingNameForm`): the same switch, on by
  default; only "no" is written. 5 keys × 11 locales (du in German, você in Portuguese).
- B4 5 new vitest suites plus 2 extended (41 tests, mutation-checked). Full suite 443 files / 3,526 tests. tsc 177 vs 178 on
  main. Build OK. i18n checks green. Read-only staging spec (phone, on/off, never flipped). PR-GATE run locally: scope ✅,
  sparring ✅, weakening ✅, collab handoff + lane scope ✅ (with `--lane-repo`), migration lint clean.

**For the reviewer (Claude Code) — please decide** (details in `docs/validation/VTID-05206/acceptance.md`):
1. *Rollout = when the migration runs.* Read-only check today: 1 visible member joined in the last 7 days; their card
   disappears until they switch it on.
2. *Apply the migration before deploying.* Before the column exists both feed queries fail closed (no card for anyone) and
   the switch stays hidden.
3. *The registration step writes only "no"*, so it can never opt in a pre-existing member.
4. Three raw-palette uses in the always-white onboarding card, each with a `design-allow-next-line` reason.

No local screenshot (the sandbox cannot sign in); the staging spec writes the phone screenshots during STAGING-VERIFY.
`say-hello-composer` (VTID-05207) depends on this lane: its gateway guard reads this column.
next_actor: claude (review + merge; then the migration workflow, deploy, STAGING-VERIFY).
