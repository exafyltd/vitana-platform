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

let _registered = false;

export function ensureDefaultNextActionSourcesRegistered(): void {
  if (_registered) return;
  _registered = true;
  defaultNextActionComposer.register(makeReminderDueSource());
  defaultNextActionComposer.register(makeAutopilotRecommendationSource());
}

// Register on import so consumers don't have to remember.
ensureDefaultNextActionSourcesRegistered();
