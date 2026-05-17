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

let _registered = false;

export function ensureDefaultNextActionSourcesRegistered(): void {
  if (_registered) return;
  _registered = true;
  // Registration order also serves as the deterministic tie-break.
  // Pick: reminders > calendar > autopilot > life-compass-alignment.
  // Each source's bands are tuned so the natural urgency winner wins on
  // priority alone (e.g. <10min reminder=95 beats calendar bands), but
  // this order resolves rare ties without the composer needing a
  // global registry.
  defaultNextActionComposer.register(makeReminderDueSource());
  defaultNextActionComposer.register(makeCalendarUpcomingSource());
  defaultNextActionComposer.register(makeAutopilotRecommendationSource());
  defaultNextActionComposer.register(makeLifeCompassAlignmentSource());
}

// Register on import so consumers don't have to remember.
ensureDefaultNextActionSourcesRegistered();
