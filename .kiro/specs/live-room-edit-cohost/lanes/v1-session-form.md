---
lane: v1-session-form
state: ready
next_actor: kiro
branch: kiro/live-room-edit-cohost/v1-session-form
depends_on: [gateway-cohost]
executor: kiro
seat: exafyltd
area: frontend
repos: [exafyltd/vitana-v1]
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - src/components/liverooms/SessionFormFields.tsx
  - src/components/liverooms/SessionFormFields*.test.tsx
  - src/components/liverooms/CoHostPicker.tsx
  - src/components/liverooms/CoHostPicker*.test.tsx
  - src/components/GoLivePopup.tsx
  - src/components/GoLivePopup*.test.ts
  - src/components/GoLivePopup*.test.tsx
  - src/services/liveRoomService.ts
  - src/i18n/ar/liveRooms.json
  - src/i18n/de/liveRooms.json
  - src/i18n/en/liveRooms.json
  - src/i18n/es/liveRooms.json
  - src/i18n/fr/liveRooms.json
  - src/i18n/pl/liveRooms.json
  - src/i18n/pt/liveRooms.json
  - src/i18n/ru/liveRooms.json
  - src/i18n/sr/liveRooms.json
  - src/i18n/tr/liveRooms.json
  - src/i18n/zh/liveRooms.json
  - docs/SCREEN_INVENTORY.md
  - tests/e2e/staging/*live-room-cohost*.staging.spec.ts
updated: 2026-11-05T16:40Z
---

# Lane: v1-session-form (repo exafyltd/vitana-v1)

Shared `SessionFormFields`, searchable `CoHostPicker` over `useMentionCandidates`, Go Live renders the shared form and
sends `co_hosts`. Tasks T1-T7 in tasks.md.

## Log
### 2026-11-05T16:40Z · kiro-jtadic-202611051617-04a8 · ready
Lane created with the plan.
