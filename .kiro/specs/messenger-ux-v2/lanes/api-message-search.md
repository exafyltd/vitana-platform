---
lane: api-message-search
state: ready
next_actor: kiro
depends_on: [api-viewing-presence]
executor: kiro
seat: exafy
area: platform
reviewer_seat: exafyltd
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - supabase/migrations/2026*_chat_message_search.sql
  - services/gateway/src/routes/chat.ts
  - services/gateway/src/routes/chat-search.ts
  - DATABASE_SCHEMA.md
  - services/gateway/test/vtid-*-chat-message-search.test.ts
  - docs/validation/VTID-*/**
updated: 2026-10-21T13:16Z
vtid: VTID-05309
---
# api-message-search
Authorised message search across DMs and groups with filters (plan I5).
Plan: `.kiro/specs/messenger-ux-v2/plan.md` (§4 interfaces, §5 lane api-message-search) and the `api-message-search` section of `tasks.md` are
authoritative. Repo: `exafyltd/vitana-platform`. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here.
Acceptance by `agent:vitana-lane-reviewer (claude-sonnet-5.5)`.
## Log
### 2026-10-21T12:00Z · kiro-exafyltd-202610211130-c65e · created → ready
Lane created with the plan (owner spec 2026-10-21, `requirements.md`).

### 2026-10-21T13:16Z · ci-plan-spar · ready (VTID allocated)
VTID-05309 allocated after policy approval (converged-auto-v1).
