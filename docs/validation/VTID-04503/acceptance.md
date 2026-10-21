# VTID-04503 — Community Autopilot CA-3: typed actions + confirm-then-execute

Step CA-3 of `docs/COMMUNITY-AUTOPILOT-V2-PLAN.md`.

## What changed

- `autopilot_recommendations.action` (jsonb, nullable; migration applied live).
- `services/community-autopilot/action-registry.ts`: a closed registry of kinds
  (log_water/sleep/exercise/meditation, save_diary_entry, set_reminder,
  rsvp_event, join_group, open_screen, start_guided_session). Each kind reuses an
  existing handler (shared ORB tools, reminders service). The registry decides
  risk; there is no high-risk kind.
- Policy (owner decision 1): low-risk runs on a Go click or a spoken yes;
  medium-risk (join_group) runs from the app, and by voice only after a
  read-back and `confirm=true`. A refused voice call changes nothing.
- Every execution writes one `agent_runs` row (plane `community_autopilot`,
  `idempotency_key community_autopilot:<rec>:<kind>`): a repeat never runs twice;
  a failed attempt may be retried.
- The canonical activation runs the typed action after booking the slot, emits
  `community_autopilot.action.executed|failed`, and returns `action_result`.
  A template that books a slot and has no typed action gets a reminder at the
  slot (the member activated it), so the slot actually prompts them.
- New voice tool `confirm_pending_action`: runs exactly the stored pending offer,
  only if a spoken yes may commit it; `confirm` param on the activation tools.
  Registered on Vertex/Nova, LiveKit and `/api/v1/orb/tool`; voice spec updated.

## Acceptance criteria

AC-1: Only registry kinds are executable; malformed or unknown actions are informational; the registry, not the row, decides risk; no high-risk kind exists.
TEST: services/gateway/test/vtid-04503-community-autopilot-actions.test.ts

AC-2: Low-risk actions run on a spoken yes; medium-risk actions need a read-back and confirm=true on voice but not in the app; invalid params never run; a voice refusal writes nothing.
TEST: services/gateway/test/vtid-04503-community-autopilot-actions.test.ts

AC-3: An execution goes through the existing handler and writes one agent_runs row; a repeat is `already_executed`; a failed attempt is recorded and may be retried.
TEST: services/gateway/test/vtid-04503-community-autopilot-actions.test.ts

AC-4: A voice activation of a medium-risk suggestion returns a read-back and issues no status PATCH; an app activation returns the action's result.
TEST: services/gateway/test/routes/autopilot-recommendations.test.ts

AC-5: `confirm_pending_action` runs exactly the stored offer and consumes it; a read-back keeps it open and passes confirm through; no offer, a stale offer_id, anonymous callers and offers that reach other people are refused.
TEST: services/gateway/test/vtid-04503-community-autopilot-actions.test.ts

AC-6: Catalog snapshots change only by the new tool and the new `confirm` parameters.
TEST: services/gateway/test/orb/live/characterization/tool-catalog.characterization.test.ts

AC-7: The route-level CA-3 tests fail with the activation change reverted.
TEST: docs/validation/VTID-04503/outputs/mutation-route-reverted.txt

## Not verified

No live activation on any host.


OASIS_PROOF: activation emits `community_autopilot.action.executed` / `community_autopilot.action.failed` (vtid SYSTEM, source community-autopilot) with recommendation_id, channel, kind, outcome and run_id — asserted through the activation path in services/gateway/test/routes/autopilot-recommendations.test.ts (CA-3 block).
