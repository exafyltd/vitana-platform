---
lane: api-viewing-presence
state: ready
next_actor: kiro
depends_on: [api-send-reliability]
executor: kiro
seat: exafy
area: platform
reviewer_seat: exafyltd
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - supabase/migrations/2026*_chat_viewing_presence.sql
  - services/gateway/src/routes/chat.ts
  - services/gateway/src/routes/chat-viewing.ts
  - services/gateway/src/services/chat-push-coalescer.ts
  - services/gateway/src/services/notification-service.ts
  - services/gateway/src/routes/scheduled-notifications.ts
  - services/gateway/src/routes/scheduled-notifications-repository.ts
  - DATABASE_SCHEMA.md
  - services/gateway/test/vtid-05137-chat-push-coalescing.test.ts
  - services/gateway/test/vtid-*-chat-viewing-presence.test.ts
  - docs/validation/VTID-*/**
updated: 2026-10-21T12:00Z
---
# api-viewing-presence
Push suppressed for the conversation the recipient is viewing, on the gateway path and the `/push-dispatch` cron path (plan I4).
Plan: `.kiro/specs/messenger-ux-v2/plan.md` (§4 interfaces, §5 lane api-viewing-presence) and the `api-viewing-presence` section of `tasks.md` are
authoritative. Repo: `exafyltd/vitana-platform`. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here.
Acceptance by `agent:vitana-lane-reviewer (claude-sonnet-5.5)`.
## Log
### 2026-10-21T12:00Z · kiro-exafyltd-202610211130-c65e · created → ready
Lane created with the plan (owner spec 2026-10-21, `requirements.md`).
