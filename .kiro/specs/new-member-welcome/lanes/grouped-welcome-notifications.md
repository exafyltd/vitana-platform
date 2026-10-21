---
lane: grouped-welcome-notifications
state: parked
next_actor: claude
vtid: VTID-05208
seat: exafyltd
area: messenger
depends_on: []
branch: kiro/new-member-welcome/grouped-welcome-notifications
pr: https://github.com/exafyltd/vitana-platform/pull/4153
updated: 2026-10-21T00:01Z
parked_from: in-review
---
# Grouped greeting-DM notifications

Plan: `.kiro/specs/new-member-welcome/` — the plan block in `plan-sparring.md` and the lane section in `tasks.md` are
authoritative (requirements/design text that says "comment" or "backing post" is superseded; owner decision D2 = b: the
greeting is a private DM on explicit Send). VTID: VTID-05208 (allocated, `in_progress`/`approved` in the ledger).
Repo: vitana-platform (`routes/chat.ts`, next to `chat-push-coalescer.ts`). Tasks D1–D2 in `tasks.md`; design: plan block S4.
Rules for the executor (collaboration §7a): no VTID allocation, no merge/approve/deploy, no Supabase/AWS writes — DB changes
are migration files in this lane's PR. Copy `.kiro/specs/new-member-welcome/plan-sparring.md` to
`docs/validation/VTID-05208/plan-sparring.md` in your PR and add `scope.json`, `acceptance.md` and `staging-tests.json` there.

## Log
### 2026-10-15T09:40Z · kiro-202610150924-9ecd · created → ready
Drafted. next_actor: claude (spar → Gate 1 → allocate VTID), then kiro executes.

### 2026-10-15T13:00Z · session_01LKkSBuw1tGgnKzjhfcmAxj · ready → ready (handed to Kiro)
Owner approved the plan at Gate 1; VTID VTID-05208 allocated. Lane handed to Kiro: `next_actor: kiro`, seat `exafyltd` (area `messenger`). Start by claiming the lane
(`queue.mjs claim new-member-welcome/grouped-welcome-notifications --session <your id>`); respect `depends_on` — do not start before those lanes are `done`.

### 2026-10-16T12:00Z · kiro-202610151913-51bd · ready → in_progress
Claim ref `collab-claim/new-member-welcome/grouped-welcome-notifications` exists on origin. Implemented D1–D2 on branch
`kiro/new-member-welcome/grouped-welcome-notifications`: `services/new-member-greeting-push.ts` (recipient-keyed 24 h rule for DMs
tagged `metadata.source='new_member_greeting'`, fail-open grouping, fail-closed test/service-account exclusion, off switch
`NEW_MEMBER_GREETING_PUSH_GROUPING_ENABLED`), wired into `POST /chat/send`; catalog keys
`notif.new_member_greeting_burst.{title,body}` in all 11 locales; Jest suites `vtid-05208-*`; validation pack
`docs/validation/VTID-05208/`. No migration. Committed locally; push/PR by the ship step.

### 2026-10-16T09:34:27Z · kiro-202610151913-51bd · ready → executing → in-review
Built D1–D2: recipient-keyed 24 h grouping of new-member greeting DM pushes (`new-member-greeting-push.ts`, wired into
`POST /chat/send`), burst catalog keys in all 11 locales, validation pack. Local checks: `tsc --noEmit` exit 0; Jest 12/12
suites, 239/239 tests; mutation check caught by 6 tests; `npm run test:roles` 105/105; `npm run build` (bash shell) exit 0.
Nothing run against staging or production. Pushed and PR opened; next_actor: claude for review and merge.
Lane permission fields (`executor`, `reviewer_seat`, `paths`) are left as on main: Lane scope (VTID-05213) rejects a lane PR
that changes them. For Claude to set: executor kiro, reviewer_seat claude, paths `.kiro/specs/new-member-welcome/lanes/grouped-welcome-notifications.md`,
`DATABASE_SCHEMA.md`, `docs/validation/VTID-05208/**`, `services/gateway/src/i18n/catalog.ts`, `services/gateway/src/i18n/locales/*.json`,
`services/gateway/src/routes/chat.ts`, `services/gateway/src/services/chat-push-coalescer.ts`,
`services/gateway/src/services/new-member-greeting-push.ts`, `services/gateway/test/i18n/catalog-coverage.test.ts`,
`services/gateway/test/vtid-05208-*.test.ts`.

### 2026-10-18T21:15:05Z · kiro-202610182052-5ce2 · in-review → in-review (CI unblock, stale claim released)
Released the stale claim of `kiro-202610151913-51bd` (held since 2026-10-15, no branch commits for >24 h) with
`queue.mjs release --stale` and re-claimed. Failing checks on PR #4153 (TEST-SUITE run 38882611827: "Gateway (Jest)",
"Gateway Service Tests", "Test Suite Summary") had one failure: `test/vtid-04868-plan-sparring-session-layer.test.ts`
› "CLAUDE.md carries rules 51-55 …" — it pinned the old rule-51 wording that VTID-05218 (#4146) changed in CLAUDE.md.
Not caused by this PR (it changes no CLAUDE.md or that test); main fixed the pin in #4161. Fix: merged `origin/main`
into the branch (no rebase, no force). No lane code changed. Locally (Windows): VTID-05208 suites + catalog coverage
pass; `npm run test:support` 87/87. Note: latest main TEST-SUITE (run 39152254750) is itself red on
`vtid-04525-conversation-flag-registry` and `vtid-04349-automation-shadow` — pre-existing on main, outside this lane;
if those show up on this PR after the merge they are main's, for claude. next_actor: claude for review and merge.
### 2026-10-20T20:43Z · pm-agent · update
reassign review →claude (stale_review)
### 2026-10-20T20:44Z · pm-agent · update
reassign review →claude (stale_review)
### 2026-10-20T20:46Z · pm-agent · update
reassign review →claude (stale_review)
### 2026-10-20T20:48Z · pm-agent · update
reassign review →claude (stale_review)
### 2026-10-20T20:50Z · pm-agent · update
reassign review →claude (stale_review)
### 2026-10-20T20:52Z · pm-agent · update
reassign review →claude (stale_review)
### 2026-10-20T20:54Z · pm-agent · update
reassign review →claude (stale_review)
### 2026-10-20T20:56Z · pm-agent · update
reassign review →claude (stale_review)
### 2026-10-20T20:58Z · pm-agent · update
reassign review →claude (stale_review)
### 2026-10-20T21:00Z · pm-agent · update
reassign review →claude (stale_review)
### 2026-10-20T21:02Z · pm-agent · update
reassign review →claude (stale_review)
### 2026-10-20T21:04Z · pm-agent · in-review → parked
park (stale_claim); claim released
### 2026-10-20T21:06Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T21:08Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T21:10Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T21:12Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T21:14Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T21:16Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T21:18Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T21:30Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T21:32Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T21:34Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T21:36Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T21:38Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T21:40Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T21:42Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T21:44Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T21:46Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T21:48Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T21:50Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T21:52Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T21:54Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T21:56Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T21:58Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T22:00Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T22:02Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T22:04Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T22:06Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T22:08Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T22:30Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T22:32Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T22:34Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T22:36Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T22:38Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T22:40Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T22:42Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T22:46Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T22:47Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T22:49Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T22:51Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T22:53Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T22:55Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T22:57Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T22:59Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T23:01Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T23:03Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T23:05Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T23:07Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T23:31Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T23:33Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T23:35Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T23:37Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T23:39Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T23:41Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T23:43Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T23:45Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T23:47Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T23:49Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T23:51Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T23:53Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T23:55Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T23:57Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-20T23:59Z · pm-agent · update
park (stale_claim); claim released
### 2026-10-21T00:01Z · pm-agent · update
park (stale_claim); claim released
