/**
 * VTID-03057 (B0d-real slice Xb) — register the default sources with the
 * module-level composer.
 *
 * Sources are registered IN ORDER OF the tie-break preference. The
 * composer sorts by priority (descending) but ties keep registration
 * order; so when two sources produce equal priority, the EARLIER
 * registered one wins. The chosen order:
 *
 *   1. reminder_due              — time-sensitive, beats coaching
 *   2. autopilot_recommendation  — second strongest signal
 *
 * Later slices Xc-Xe extend this list. The cross-source threshold (50)
 * lives in composer.ts; each source's priority bands are chosen so
 * "no real signal" sources stay below it and "real next action"
 * sources stay above.
 *
 * Idempotent: re-imports during hot-reload don't throw or duplicate.
 */

import { defaultNextActionComposer } from './composer';
import { makeReminderDueSource } from './sources/reminder-due';
import { makeAutopilotRecommendationSource } from './sources/autopilot-recommendation';
// VTID-03058 (B0d-real Xc) — second wave of sources.
import { makeCalendarUpcomingSource } from './sources/calendar-upcoming';
import { makeLifeCompassAlignmentSource } from './sources/life-compass-alignment';
// VTID-03059 (B0d-real Xd) — third wave of sources.
import { makeDiaryMissingRelevantSource } from './sources/diary-missing-relevant';
import { makeVitanaIndexPillarSource } from './sources/vitana-index-pillar';
// VTID-03060 (B0d-real Xe) — continuity sources.
import { makeContinuityPendingThreadSource } from './sources/continuity-pending-thread';
import { makeContinuityPromiseOwedSource } from './sources/continuity-promise-owed';
// VTID-03067 (B0d-real Xj) — per-source flag gates.
import { withFlagGate } from './source-gate';

let _registered = false;

export function ensureDefaultNextActionSourcesRegistered(): void {
  if (_registered) return;
  _registered = true;
  // Registration order also serves as the deterministic tie-break.
  // Pick (urgency-first):
  //   1. reminders                — time-bound, beats coaching
  //   2. calendar                 — time-bound, slightly weaker than reminders
  //   3. autopilot                — coaching with confidence signal
  //   4. continuity_promise_owed  — relationship trust (overdue promises sit high)
  //   5. diary_missing_relevant   — streak preservation
  //   6. continuity_pending_thread— pick up the thread we left
  //   7. life-compass-alignment   — goal-anchored coaching
  //   8. vitana-index-pillar      — weakest signal, last resort
  //
  // Each source's bands are tuned so the natural urgency winner wins on
  // priority alone. This order resolves rare ties without the composer
  // needing a global registry.
  // VTID-03067: every source is wrapped in withFlagGate() so operators
  // can toggle individual sources via `system_controls` row
  // `voice.next_action.<source_key>.enabled = false` without redeploy.
  // Default behavior (row absent) keeps every source live.
  defaultNextActionComposer.register(withFlagGate(makeReminderDueSource()));
  defaultNextActionComposer.register(withFlagGate(makeCalendarUpcomingSource()));
  defaultNextActionComposer.register(withFlagGate(makeAutopilotRecommendationSource()));
  defaultNextActionComposer.register(withFlagGate(makeContinuityPromiseOwedSource()));
  defaultNextActionComposer.register(withFlagGate(makeDiaryMissingRelevantSource()));
  defaultNextActionComposer.register(withFlagGate(makeContinuityPendingThreadSource()));
  defaultNextActionComposer.register(withFlagGate(makeLifeCompassAlignmentSource()));
  defaultNextActionComposer.register(withFlagGate(makeVitanaIndexPillarSource()));
}

// Register on import so consumers don't have to remember.
ensureDefaultNextActionSourcesRegistered();
