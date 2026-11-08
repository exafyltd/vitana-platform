---
lane: orb-guided-topic
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-v1]
paths:
  - apps/mobile/src/orb/**
  - apps/mobile/tests/orb/guided-topic/**
  - docs/validation/**
updated: 2026-11-08T12:05Z
vtid: VTID-05649
---
# ORB guided topic — `guided_topic_id`, `focusGuidedTopic`, the teaching-end event
Plan: `.kiro/specs/native-wave2-fix-forward-r2/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: orb-guided-topic -->` (tasks 1–5) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do
not start before `vtid:` is set here. The only lane of this plan that changes `apps/mobile/src/orb/**`.
**Measured on vitana-v1 origin/main `aac65bfeb`:** `buildStartPayload` has no guided-topic field
(`src/orb/protocol.ts:239`, type `:105-117`); `end_guided_topic_teaching` only ends the session (`protocol.ts:190`,
`session.ts:355-358`); `OrbController` has no `focusGuidedTopic` (`ui/orb-controller.ts:68-84`). Web: the widget's
`focusGuidedTopic` (`orb-widget.js:6297`) and teaching-end callback (`:5450`, `:5602-5605`) → window event
`vitana:guided-topic-teaching-complete` (`src/hooks/useOrbVoiceWidget.ts:292-294`).
**Goal.** Start a session for a topic and emit teaching end once per topic on the overlay bus, by the widget's three
triggers. Existing `tests/orb/**` stay unchanged and green.
**Acceptance:** `tasks.md` lane `orb-guided-topic` Acceptance bullets.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; no live ORB session (fake transport only).
## Log
### 2026-11-08T12:10Z · kiro-exafyltd-202611072144-1c88 · ready
Lane created with the plan (re-plan of `native-wave2-fix-forward/orb-guided-topic`, PR #4664).

### 2026-11-08T12:05Z · ci-plan-spar · ready (VTID allocated)
VTID-05649 allocated after policy approval (converged-auto-v1).
