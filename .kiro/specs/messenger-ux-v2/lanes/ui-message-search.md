---
lane: ui-message-search
state: ready
next_actor: kiro
depends_on: [ui-viewing-presence, ui-reply-jump, api-message-search]
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: exafy
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-v1]
paths:
  - src/components/messages/MessageSearchPanel.tsx
  - src/hooks/useMessageSearch.ts
  - src/hooks/useMessageSearch.test.ts*
  - src/pages/Messages.tsx
  - src/components/messages/ConversationView.tsx
  - src/pages/messages/GroupChat.tsx
  - src/components/messages/*.vtid-*.test.tsx
  - src/pages/*.vtid-*.test.tsx
  - src/i18n/*/inbox.json
  - tests/e2e/staging/vtid-*-message-search.staging.spec.ts
  - docs/validation/VTID-*/**
updated: 2026-10-21T13:16Z
vtid: VTID-05317
---
# ui-message-search
Global and in-conversation search; a result opens the exact message (plan I5, I8).
Plan: `.kiro/specs/messenger-ux-v2/plan.md` (§4 interfaces, §5 lane ui-message-search) and the `ui-message-search` section of `tasks.md` are
authoritative. Repo: `exafyltd/vitana-v1`. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here.
Acceptance by `agent:vitana-lane-reviewer (claude-sonnet-5.5)`.
## Log
### 2026-10-21T12:00Z · kiro-exafyltd-202610211130-c65e · created → ready
Lane created with the plan (owner spec 2026-10-21, `requirements.md`).

### 2026-10-21T13:16Z · ci-plan-spar · ready (VTID allocated)
VTID-05317 allocated after policy approval (converged-auto-v1).
