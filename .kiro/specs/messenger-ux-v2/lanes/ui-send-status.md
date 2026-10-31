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

### 2026-10-28T11:00Z · kiro-exafyltd-202610281029-e076 · fix-forward (time-bomb fixtures)
vitana-v1 `main` 5bc8d10cd red in Vitest run 40668786443: two reload tests in
`src/hooks/useGlobalMessages.send-status.vtid-05320.test.tsx` seeded outbox items dated 2026-10-21T10:00Z, which
`loadOutbox` prunes since 2026-10-28T10:00Z (`OUTBOX_MAX_AGE_MS` = 7 days). Fix: fixtures relative to `Date.now()`;
no assertion and no `OUTBOX_MAX_AGE_MS` change. PR https://github.com/exafyltd/vitana-v1/pull/1506
(branch `kiro/messenger-ux-v2/ui-send-status-fixfwd`, head 3e324cec2d26068c557dc45cdcb78d6092986bd9). Target file
17/17 locally; other absolute dates in the lane's tests are not age-compared and pass.

### 2026-10-31T12:20Z · agent-vitana-lane-reviewer-202610311219-39d4 · review
review: accept
head: 2b0d52d3daff19b38e716e0a496f10b223b8288e
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-v1/pull/1506
Findings:
- No blocking findings. Fixtures are relative to `Date.now()`; no assertion and no `OUTBOX_MAX_AGE_MS` change.
- All 4 required checks on 2b0d52d are green. NATIVE-CI parity is not required and fails on pre-existing
  gen-core-extract drift on `main`, unrelated to this change.
Next: kiro lands exafyltd/vitana-v1#1506 under §7b (committed on the agent's behalf by the land step for parent
session kiro-ide-202610272306-27b0).

### 2026-10-31T12:30Z · kiro-ide-202610272306-27b0 · land: not merged (superseded)
exafyltd/vitana-v1#1506 not merged: the same fixture fix already landed via exafyltd/vitana-v1#1508
(merge 627e8094fa3117ca1d8327559c7a88a98d02552a, 2026-10-28T14:32Z, merged by jtadic-netizen). `gh pr update-branch 1506`
conflicts on the one test file; the remaining diff is only a helper rename, no behaviour. UNIT-TESTS on vitana-v1 `main`
green on 5a853a777 and 847a9f686 (https://github.com/exafyltd/vitana-v1/actions/runs/41190775352). Duplicate #1507
(VTID-05372) told to close. #1506 left open for its session to close.
