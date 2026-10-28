---
lane: api-shared-content
state: ready
next_actor: kiro
depends_on: [api-message-search]
executor: kiro
seat: exafyltd
area: messenger
reviewer_seat: exafy
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - services/gateway/src/routes/chat.ts
  - services/gateway/src/routes/chat-groups.ts
  - services/gateway/src/services/chat-shared-content.ts
  - services/gateway/src/i18n/**
  - services/gateway/test/vtid-*-chat-shared-content.test.ts
  - docs/validation/VTID-*/**
updated: 2026-10-21T13:16Z
vtid: VTID-05311
---
# api-shared-content
`shared_content` message type and the per-viewer `/chat/shared-preview` (plan I6).
Plan: `.kiro/specs/messenger-ux-v2/plan.md` (§4 interfaces, §5 lane api-shared-content) and the `api-shared-content` section of `tasks.md` are
authoritative. Repo: `exafyltd/vitana-platform`. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here.
Acceptance by `agent:vitana-lane-reviewer (claude-sonnet-5.5)`.
## Log
### 2026-10-21T12:00Z · kiro-exafyltd-202610211130-c65e · created → ready
Lane created with the plan (owner spec 2026-10-21, `requirements.md`).

### 2026-10-21T13:16Z · ci-plan-spar · ready (VTID allocated)
VTID-05311 allocated after policy approval (converged-auto-v1).
