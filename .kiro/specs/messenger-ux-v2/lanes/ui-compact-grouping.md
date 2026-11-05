---
lane: ui-compact-grouping
state: ready
next_actor: kiro
depends_on: [ui-reply-jump]
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: exafy
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-v1]
paths:
  - src/lib/messaging/grouping.ts
  - src/lib/messaging/grouping.test.ts
  - src/components/messages/MessageBubble.tsx
  - src/components/messages/ConversationView.tsx
  - src/pages/messages/GroupChat.tsx
  - src/components/messages/*.vtid-*.test.tsx
  - tests/e2e/staging/vtid-*-compact-grouping.staging.spec.ts
  - docs/validation/VTID-*/**
updated: 2026-10-21T13:16Z
vtid: VTID-05314
---
# ui-compact-grouping
Consecutive-message grouping (avatar/name once, tails, timestamps). Builds on #1425 (merged first, plan §8).
Plan: `.kiro/specs/messenger-ux-v2/plan.md` (§4 interfaces, §5 lane ui-compact-grouping) and the `ui-compact-grouping` section of `tasks.md` are
authoritative. Repo: `exafyltd/vitana-v1`. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here.
Acceptance by `agent:vitana-lane-reviewer (claude-sonnet-5.5)`.
## Log
### 2026-10-21T12:00Z · kiro-exafyltd-202610211130-c65e · created → ready
Lane created with the plan (owner spec 2026-10-21, `requirements.md`).

### 2026-10-21T13:16Z · ci-plan-spar · ready (VTID allocated)
VTID-05314 allocated after policy approval (converged-auto-v1).
