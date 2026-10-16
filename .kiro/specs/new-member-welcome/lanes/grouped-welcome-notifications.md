---
lane: grouped-welcome-notifications
state: in_progress
next_actor: kiro
claimed_by: kiro-202610151913-51bd
vtid: VTID-05208
seat: exafyltd
area: messenger
depends_on: []
updated: 2026-10-16T12:00Z
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
