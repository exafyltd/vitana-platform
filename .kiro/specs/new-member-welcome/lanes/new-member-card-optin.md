---
lane: new-member-card-optin
state: parked
next_actor: kiro
vtid: VTID-05206
seat: exafyltd
area: frontend
depends_on: []
branch: kiro/new-member-welcome/new-member-card-optin
pr: https://github.com/exafyltd/vitana-v1/pull/1441
updated: 2026-11-01T13:51Z
parked_from: verified
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

### 2026-10-30T12:29Z · kiro-jtadic-202610291040-a0e6 · executing → in-review
Closing record for the merged lane (plan `say-hello-lane-reassign` §4); no code changes in this PR. Facts read with `gh`
(`docs/validation/VTID-05206/outputs/gh-merge-shas.txt`):
- code: exafyltd/vitana-v1#1441, merge `b73e6d298f5995c1c6ac67ab7e3245260835010f` (2026-10-16);
- staging spec fix: exafyltd/vitana-v1#1444, merge `704b5def4cfa0296776d21507b8d19bc5a47c31b` (2026-10-16).
migration: https://github.com/exafyltd/vitana-v1/actions/runs/41051243641 supabase/migrations/20261016110000_vtid_05206_community_intro_opt_in.sql target:supabase authority: owner instruction 2026-10-30
The owner approved it in the conversation ("approve migration 20261016110000_vtid_05206 on Supabase", 2026-10-30); the
`Apply VTID-05206 community_intro_opt_in migration` run finished `success`, step output `Apply OK, status 201`
(`outputs/migration-run-excerpt.txt`). Read-only post-check (result reported to this session by the orchestrator, not re-run here): column `community_intro_opt_in` is boolean NOT NULL default true,
REPLICA IDENTITY FULL, the table is in `supabase_realtime`, the owner policy is present, and 0 of 251 rows are opted in
(existing members are false by design; only new signups default to true).
The merged lane now goes to independent review by the reviewer agent `vitana-lane-reviewer` on the merged code. No review
verdict is written by the builder. next_actor: kiro (reviewer agent, then `verified`, then `done`).

### 2026-10-30T12:47Z · agent-vitana-lane-reviewer-202610301247-877e · review
review: accept
head: 40d357f93c3074d6fd0d94b1af7e91479c2e93a2
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4507
Lane record (this PR): accept — only state executing → in-review, claimed_by, next_actor, updated and one appended log entry change; seat, paths, executor, reviewer_seat, depends_on and vtid unchanged; the other files are under docs/validation/VTID-05206/; facts match the outputs (#1441 merge b73e6d298f, #1444 merge 704b5def4c, run 41051243641 "Apply OK, status 201", §7d migration line).
Merged lane code (exafyltd/vitana-v1 b73e6d298f + 704b5def4c) against plan block Part B / S3 and tasks B1–B4: accept. B1 migration: existing rows false, default true, no backfill, self-check of column / REPLICA IDENTITY FULL / realtime publication / owner policy, idempotent and transactional. B2 both feed tabs filter community_intro_opt_in = true, a failed read shows no card (tests cover true/false/undefined/null/error). B3 Settings switch (desktop Privacy, MobileSettings) writes only that column on the member's own row; registration wizard defaults on and writes only an explicit off; German du-form keys first, t()/notifyError. B4 tests not weakened; #1444 adds diagnostics only; staging spec read-only.
Findings: non-blocking — the database post-check has no outputs/ file (it was reported by the driver); validate.txt is abbreviated; the lane has no paths, so the plan driver merges under §7b. Non-blocking, tracked for a fix before production — neither new-member listing excludes service_bot_accounts / notification_test_actors (CLAUDE.md NEVER 45); pre-existing, but post-migration signups default to opted in.
Next: merge under §7b when every required check is green; the next hop (in-review → verified) cites this accept of the merged code.

### 2026-10-30T13:48Z · kiro-jtadic-202610291040-a0e6 · in-review → verified
Reviewer-agent accept recorded on main: the lane log carries the `Collab-Verdict: accept` review entry from agent:vitana-lane-reviewer (claude-sonnet-5.5) on head 40d357f93c3074d6fd0d94b1af7e91479c2e93a2, covering the in-review record (exafyltd/vitana-platform#4507) and the merged code (vitana-v1 b73e6d298f + 704b5def4c). No open blocking findings; the non-blocking findings in that entry are unchanged. Lane record only: state in-review → verified, `updated`, one appended log entry; `next_actor: kiro` kept.

### 2026-10-30T13:55Z · agent-vitana-lane-reviewer-202610301355-2acb · review
review: accept
head: e6ec0c8226bfb464567022bbabd70376450dc8cf
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4510
Findings: non-blocking — the commands.log line "run before push (see PR body)" is not a real command record; verified-acceptance.md has no recorded outputs (CI governance checks are the proof); CI on the current head was not readable by the reviewer, so the land step must confirm every required check is green and the PR is up to date with main; the earlier non-blocking NEVER 45 finding (service_bot_accounts / notification_test_actors not excluded from the new-member listings) is unchanged and must be fixed before production.
Next: the land step merges under §7b once every required check is green on this head; then the lane can move verified → done.

### 2026-10-30T16:22Z · agent-vitana-lane-reviewer-202610301622-f826 · review
review: accept
head: 53a4474436ef37b345b59ed2e1f825b0fbefcfa9
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4510
Findings: non-blocking — commands.log last line is a placeholder, not a real command record; verified-acceptance.md has no recorded outputs and its AC-2 names branch deps-verified; the earlier NEVER 45 finding (service_bot_accounts / notification_test_actors not excluded from the new-member listings) is unchanged and is being fixed in plan welcome-finish before production; CI on this head was not readable by the reviewer, the land step confirmed 11/11 green. Head 53a4474436 is a merge of main a206af8ab9 into the previously accepted 78db76e483; the PR's own diff is unchanged (lane file + docs/validation/VTID-05206 only; front matter changes only state and updated).
Next: the land step merges under §7b; then the lane can move verified → done.
### 2026-11-01T12:39Z · pm-agent · verified → parked
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-11-01T12:43Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-11-01T12:46Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-11-01T12:51Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-11-01T12:54Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-11-01T12:59Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-11-01T13:03Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-11-01T13:07Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-11-01T13:11Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-11-01T13:15Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-11-01T13:39Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-11-01T13:43Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-11-01T13:47Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-11-01T13:51Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
