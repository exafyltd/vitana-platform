---
lane: api-send-reliability
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafy
area: platform
reviewer_seat: exafyltd
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - supabase/migrations/2026*_chat_send_reliability.sql
  - services/gateway/src/routes/chat.ts
  - services/gateway/src/routes/chat-groups.ts
  - services/gateway/src/routes/chat-repository.ts
  - services/gateway/src/routes/chat-groups-repository.ts
  - DATABASE_SCHEMA.md
  - services/gateway/test/vtid-*-chat-send-reliability.test.ts
  - docs/validation/VTID-*/**
updated: 2026-10-21T13:16Z
vtid: VTID-05310
---
# api-send-reliability
Idempotent send (`client_message_id`), persisted replies, `delivered_at` + `/chat/delivered`, `around`/`after` context window (plan I1-I3).
Plan: `.kiro/specs/messenger-ux-v2/plan.md` (§4 interfaces, §5 lane api-send-reliability) and the `api-send-reliability` section of `tasks.md` are
authoritative. Repo: `exafyltd/vitana-platform`. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here.
Acceptance by `agent:vitana-lane-reviewer (claude-sonnet-5.5)`.
## Log
### 2026-10-21T12:00Z · kiro-exafyltd-202610211130-c65e · created → ready
Lane created with the plan (owner spec 2026-10-21, `requirements.md`).

### 2026-10-21T13:16Z · ci-plan-spar · ready (VTID allocated)
VTID-05310 allocated after policy approval (converged-auto-v1).
