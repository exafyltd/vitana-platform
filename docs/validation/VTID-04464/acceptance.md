# VTID-04464 — Community Autopilot CA-0: activation ownership and safety fixes

Step CA-0 of the Community Autopilot rebuild (`docs/COMMUNITY-AUTOPILOT-V2-PLAN.md`,
building on `docs/COMMUNITY-AUTOPILOT-PLAN.md`, VTID-04461).

## Defects fixed

1. **Ownership bypass, REST + popup + voice list activation.**
   `activateCommunityAutopilotRecommendation` checked
   `rec.user_id && userId && rec.user_id !== userId`, which passes when either
   side is null. Now the caller must be known and must equal `rec.user_id`; the
   status PATCH is also scoped to `user_id` and `status in (new,snoozed)`.
2. **Ownership bypass and cross-plane activation, `activate_recommendation`
   (shared ORB tool: Vertex/Nova voice, LiveKit, `/api/v1/orb/tool`).** The same
   null-owner hole, plus no `source_type` check and no status check. Measured
   read-only on 2026-09-24: **158 ownerless rows in `new`/`snoozed`**
   (99 `operator_onramp`, 28 `dev_autopilot`, 13 `oasis`, 9 `roadmap`,
   5 `behavior`, 2 `health`, 2 `dev_autopilot_impact`) that any signed-in
   member's voice "yes" could flip to `activated`. Now: signed-in caller,
   owner equal, `source_type='community'`, status `new`/`snoozed` (or already
   `activated`, idempotent).
3. **Voice `complete_event` did not complete the linked source.** Ticking an
   Autopilot calendar slot by voice left the recommendation open; the HTTP
   route already calls `completeSourceForCalendarEvent` (VTID-04331). Voice
   now does the same, best-effort.

Not changed here, already fixed on `main`: the acceptance gate no longer
consumes non-navigation offers (VTID-04355, `isAutoRunnableOffer`).

## Acceptance criteria

AC-1: A community recommendation whose `user_id` is null cannot be activated through the REST activation route; no PATCH is issued.
TEST: services/gateway/test/routes/autopilot-recommendations.test.ts

AC-2: The shared `activate_recommendation` tool refuses an ownerless row, an anonymous caller, a non-community (e.g. `dev_autopilot`) row and a `rejected` row, and never writes; `new`, `snoozed` and already-`activated` rows of the caller still work.
TEST: services/gateway/test/voice-activate-recommendation-shared.test.ts

AC-3: Voice `complete_event` with outcome `completed` calls `completeSourceForCalendarEvent` with the updated event and reports `source_completed`; `skipped` does not; a failing source completion never fails the call.
TEST: services/gateway/test/orb-tools/calendar-management-tools.test.ts

AC-4: The new tests fail against the unfixed source (mutation check): 8 of 114 fail with `services/gateway/src` reverted, 0 with it applied.
TEST: docs/validation/VTID-04464/outputs/mutation-src-reverted.txt

## Not verified

No live activation was attempted on any host (CLAUDE.md: no writes as the
test account, no production testing). Verification is unit/route tests plus
the read-only exposure count above.
