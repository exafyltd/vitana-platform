---
lane: ui-shared-cards
state: ready
next_actor: kiro
depends_on: [ui-media-album, ui-message-search, api-shared-content]
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: exafy
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-v1]
paths:
  - src/components/messages/SendInMessageSheet.tsx
  - src/components/messages/SharedContentCard.tsx
  - src/components/messages/ForwardMessageSheet.tsx
  - src/components/messages/forwardTargets.ts
  - src/components/messages/MessageBubble.tsx
  - src/components/home/CommunityPostCard.tsx
  - src/components/events/EventKebabMenu.tsx
  - src/components/discover/ProductDetailsDrawer.tsx
  - src/pages/discover/ProductDetail.tsx
  - src/components/profile/shared/ShareProfileSheet.tsx
  - src/components/messages/*.vtid-*.test.tsx
  - src/components/**/*.vtid-*.test.tsx
  - src/i18n/*/*.json
  - tests/e2e/staging/vtid-*-shared-cards.staging.spec.ts
  - docs/validation/VTID-*/**
updated: 2026-10-21T13:16Z
vtid: VTID-05321
---
# ui-shared-cards
"Send in message" on posts, events, products and profiles; structured cards that respect permissions (plan I6).
Plan: `.kiro/specs/messenger-ux-v2/plan.md` (§4 interfaces, §5 lane ui-shared-cards) and the `ui-shared-cards` section of `tasks.md` are
authoritative. Repo: `exafyltd/vitana-v1`. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here.
Acceptance by `agent:vitana-lane-reviewer (claude-sonnet-5.5)`.
## Log
### 2026-10-21T12:00Z · kiro-exafyltd-202610211130-c65e · created → ready
Lane created with the plan (owner spec 2026-10-21, `requirements.md`).

### 2026-10-21T13:16Z · ci-plan-spar · ready (VTID allocated)
VTID-05321 allocated after policy approval (converged-auto-v1).
