---
lane: ui-scroll-anchoring
state: ready
next_actor: kiro
depends_on: [ui-send-status]
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: exafy
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-v1]
paths:
  - src/hooks/useChatScrollAnchor.ts
  - src/hooks/useChatScrollAnchor.test.ts*
  - src/components/messages/NewMessagesPill.tsx
  - src/components/messages/ConversationView.tsx
  - src/pages/messages/GroupChat.tsx
  - src/components/messages/*.vtid-*.test.tsx
  - src/pages/messages/*.vtid-*.test.tsx
  - src/i18n/*/inbox.json
  - tests/e2e/staging/vtid-*-scroll-anchoring.staging.spec.ts
  - docs/validation/VTID-*/**
updated: 2026-10-21T13:16Z
vtid: VTID-05319
---
# ui-scroll-anchoring
Open at the newest message on the first frame, `↓ N new messages` pill, unread divider, no forced scrolling.
Plan: `.kiro/specs/messenger-ux-v2/plan.md` (§4 interfaces, §5 lane ui-scroll-anchoring) and the `ui-scroll-anchoring` section of `tasks.md` are
authoritative. Repo: `exafyltd/vitana-v1`. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here.
Acceptance by `agent:vitana-lane-reviewer (claude-sonnet-5.5)`.
## Log
### 2026-10-21T12:00Z · kiro-exafyltd-202610211130-c65e · created → ready
Lane created with the plan (owner spec 2026-10-21, `requirements.md`).

### 2026-10-21T13:16Z · ci-plan-spar · ready (VTID allocated)
VTID-05319 allocated after policy approval (converged-auto-v1).
