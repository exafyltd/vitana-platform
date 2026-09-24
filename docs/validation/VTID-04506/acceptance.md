# VTID-04506 — Community Autopilot CA-6: calendar due-now offers + deep-linked reminders

Step CA-6 of `docs/COMMUNITY-AUTOPILOT-V2-PLAN.md`. Measured before: 226
Autopilot calendar slots booked, 0 ever started or completed.

## What changed

- `services/community-autopilot/slot-due.ts`
  - `findDueAutopilotSlot`: the member's own Autopilot slot starting 30 min ago … 15 min ahead, not completed, whose suggestion is still activated, with the screen to open.
  - `startAutopilotSlot`: completes the slot and its suggestion (existing `complete_autopilot_recommendation` RPC via `completeSourceForCalendarEvent`).
  - `completeReminderLinkedSlot`.
- New wake provider `autopilot-slot-due` (priority 93), registered in `wake-brief-wiring`.
  - The due slot leads the next ORB wake as an `ask_permission` offer (`onYesTool: start_autopilot_slot`), so wake-brief-wiring stores it as the pending offer and a spoken "yes" runs it through `confirm_pending_action`.
  - The lead is facts only (the slot title and time); the opener composes the words (NEVER-rule 41).
- New voice tool `start_autopilot_slot` (self commit, own data only).
  - Shared registry, Vertex/Nova catalog, LiveKit, `voice-pipeline-spec`.
- Reminders: `POST /api/v1/reminders/:id/complete` (the overlay the reminder push deep-links to, `/reminders/fire/<id>`) now also closes the linked Autopilot slot and suggestion, and returns `autopilot_slot`.
- Snapshots re-recorded for the new tool: the tool catalog, and the conversation-replay `deferred_tool_count` (+1).

## Acceptance criteria

AC-1: Only the member's own Autopilot slot inside the due window, not completed, with a still-activated suggestion, is found; other members' slots, other sources and closed suggestions never are.
TEST: services/gateway/test/vtid-04506-wake-autopilot-slot-due.test.ts

AC-2: The wake provider offers the due slot as an ask_permission CTA that runs start_autopilot_slot, and suppresses when nothing is due; the tool is a self commit a spoken yes may run.
TEST: services/gateway/test/vtid-04506-wake-autopilot-slot-due.test.ts

AC-3: Starting a slot completes it and its suggestion; a slot that is not the member's or not from the Autopilot is refused without changes.
TEST: services/gateway/test/vtid-04506-wake-autopilot-slot-due.test.ts

AC-4: A reminder linked to an Autopilot slot closes the slot and suggestion when marked done; an unlinked reminder does nothing extra.
TEST: services/gateway/test/vtid-04506-wake-autopilot-slot-due.test.ts

## Evidence

- `outputs/jest-ca6.txt`: 61 suites / 846 tests, covering the conversation replay, ORB characterization, reminders and wake-brief suites.
- `outputs/mutation-activated-check-removed.txt`: dropping the "suggestion still activated" check fails its test.

Not verified live: no voice session was placed and no slot was completed on any host.
