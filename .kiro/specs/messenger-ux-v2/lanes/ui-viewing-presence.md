---
lane: ui-viewing-presence
state: ready
next_actor: kiro
depends_on: [ui-compact-grouping, api-viewing-presence]
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: exafy
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-v1]
paths:
  - src/hooks/useChatViewingPresence.ts
  - src/hooks/useChatViewingPresence.test.ts*
  - src/components/messages/ConversationView.tsx
  - src/pages/messages/GroupChat.tsx
  - docs/validation/VTID-*/**
updated: 2026-10-21T13:16Z
vtid: VTID-05322
---
# ui-viewing-presence
Viewing heartbeat for the open conversation (plan I4 client).
Plan: `.kiro/specs/messenger-ux-v2/plan.md` (§4 interfaces, §5 lane ui-viewing-presence) and the `ui-viewing-presence` section of `tasks.md` are
authoritative. Repo: `exafyltd/vitana-v1`. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here.
Acceptance by `agent:vitana-lane-reviewer (claude-sonnet-5.5)`.
## Log
### 2026-10-21T12:00Z · kiro-exafyltd-202610211130-c65e · created → ready
Lane created with the plan (owner spec 2026-10-21, `requirements.md`).

### 2026-10-21T13:16Z · ci-plan-spar · ready (VTID allocated)
VTID-05322 allocated after policy approval (converged-auto-v1).
