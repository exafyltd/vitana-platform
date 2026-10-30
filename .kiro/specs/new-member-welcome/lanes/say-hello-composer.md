---
lane: say-hello-composer
state: ready
next_actor: kiro
vtid: VTID-05207
seat: jtadic
executor: kiro
reviewer_seat: agent:vitana-lane-reviewer
paths:
  - services/gateway/src/services/new-member-greeting-guard.ts
  - services/gateway/src/services/new-member-greeting-suggestion.ts
  - services/gateway/src/routes/new-member-greeting.ts
  - services/gateway/src/routes/new-member-greeting-repository.ts
  - services/gateway/src/routes/chat.ts
  - services/gateway/src/index.ts
  - services/gateway/src/orb/developer/domain-atlas.ts
  - services/gateway/test/vtid-05207-*.ts
  - services/gateway/test/vtid-05208-greeting-send-route.test.ts
  - docs/validation/VTID-05207/**
  - src/components/home/NewMemberCard.tsx
  - src/components/home/NewMemberCard.test.tsx
  - src/components/home/NewMemberGreetingComposer.tsx
  - src/components/home/NewMemberGreetingComposer.test.tsx
  - src/i18n/*/*.json
  - i18n-source-stamps/*.json
  - tests/e2e/staging/vtid-05207-*.staging.spec.ts
area: messenger
depends_on: [new-member-card-optin, grouped-welcome-notifications]
updated: 2026-10-15T13:00Z
---
# "Say Hello 👋" composer + suggestion endpoint + greeting guard

Plan: `.kiro/specs/new-member-welcome/` — the plan block in `plan-sparring.md` and the lane section in `tasks.md` are
authoritative (requirements/design text that says "comment" or "backing post" is superseded; owner decision D2 = b: the
greeting is a private DM on explicit Send). VTID: VTID-05207 (allocated, `in_progress`/`approved` in the ledger).
Repos: vitana-platform + vitana-v1. Tasks C1–C5 in `tasks.md`; design: plan block Part B. Depends on the opt-in and grouping lanes.
Rules for the executor (collaboration §7a): no VTID allocation, no merge/approve/deploy, no Supabase/AWS writes — DB changes
are migration files in this lane's PR. Copy `.kiro/specs/new-member-welcome/plan-sparring.md` to
`docs/validation/VTID-05207/plan-sparring.md` in your PR and add `scope.json`, `acceptance.md` and `staging-tests.json` there.

## Log
### 2026-10-15T09:40Z · kiro-202610150924-9ecd · created → ready
Drafted. next_actor: claude (spar → Gate 1 → allocate VTID), then kiro executes.

### 2026-10-15T13:00Z · session_01LKkSBuw1tGgnKzjhfcmAxj · ready → ready (handed to Kiro)
Owner approved the plan at Gate 1; VTID VTID-05207 allocated. Lane handed to Kiro: `next_actor: kiro`, seat `exafyltd` (area `messenger`). Start by claiming the lane
(`queue.mjs claim new-member-welcome/say-hello-composer --session <your id>`); respect `depends_on` — do not start before those lanes are `done`.
