# VTID-04826 — the calendar prioritizer reads the Vitana Index (P4 fix-first)

Plan `docs/JEV-INTEGRATION-PLAN.md` §10.4 D: "fix first, no Jev — pillar gap in calendar-prioritizer". Its header
promised "declining index → boost wellness events"; the code never read `vitana_index_scores` (a flat +3 for
movement/mindfulness tags and a "Future: integrate …" comment). 242 members have index rows (4,970 days).

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: `eventPillar` maps an event to a pillar by its wellness tags through `PILLAR_TAGS` (the canonical tag → pillar map), else its event type (workout → exercise, nutrition → nutrition), else none.
  TEST: services/gateway/test/vtid-04826-calendar-pillar-priority.test.ts
AC-2: `pillarBoost`: the user's weakest pillar +10, second weakest +5, others 0; no boost without a pillar, without index data, with fewer than three pillars known, or when the pillars are within 5 points of each other.
  TEST: services/gateway/test/vtid-04826-calendar-pillar-priority.test.ts
AC-3: `reprioritizeUserEvents` reads the user's latest `vitana_index_scores` row once per run (only when it has events) and adds the boost; without index data the old flat +3 for movement/mindfulness tags is kept; the other inputs (urgency, reschedules, type) are unchanged; the calendar suites stay green.
  TEST: services/gateway/test/vtid-04826-calendar-pillar-priority.test.ts
  TEST: services/gateway/test/vtid-04374-calendar-maintenance.test.ts

## Scope

SCOPE_ALLOWLIST:
- services/gateway/src/services/calendar-prioritizer.ts
- services/gateway/test/vtid-04826-calendar-pillar-priority.test.ts
- docs/validation/VTID-04826/**

## OASIS

OASIS_IMPACT: none new (the existing `calendar.prioritization.completed` summary event is unchanged).

## MERGE_PAYLOAD_PREVIEW

Squash merge to `main` → staging. Every 6 h (and on `POST /api/v1/calendar/reprioritize`) upcoming events on a
member's weakest Vitana Index pillars get a higher `priority_score`. One extra read per user per run; no new writes.
