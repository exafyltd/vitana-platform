---
lane: ui-send-status
state: ready
next_actor: kiro
depends_on: [api-send-reliability, test-fixture-05201]
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: exafy
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-v1]
paths:
  - src/hooks/useGlobalMessages.ts
  - src/hooks/useChatApi.ts
  - src/lib/messaging/outbox.ts
  - src/lib/messaging/outbox.test.ts
  - src/components/messages/MessageBubble.tsx
  - src/components/messages/ConversationView.tsx
  - src/pages/messages/GroupChat.tsx
  - src/hooks/*.vtid-*.test.ts*
  - src/components/messages/*.vtid-*.test.tsx
  - src/i18n/*/inbox.json
  - tests/e2e/staging/vtid-*-send-status.staging.spec.ts
  - docs/validation/VTID-*/**
updated: 2026-10-21T13:16Z
vtid: VTID-05320
---
# ui-send-status
Client outbox: optimistic send, Sending/Sent/Delivered/Read/Failed, one-tap Retry with the same id (plan I7).
Plan: `.kiro/specs/messenger-ux-v2/plan.md` (§4 interfaces, §5 lane ui-send-status) and the `ui-send-status` section of `tasks.md` are
authoritative. Repo: `exafyltd/vitana-v1`. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here.
Acceptance by `agent:vitana-lane-reviewer (claude-sonnet-5.5)`.
## Log
### 2026-10-21T12:00Z · kiro-exafyltd-202610211130-c65e · created → ready
Lane created with the plan (owner spec 2026-10-21, `requirements.md`).

### 2026-10-21T13:16Z · ci-plan-spar · ready (VTID allocated)
VTID-05320 allocated after policy approval (converged-auto-v1).
