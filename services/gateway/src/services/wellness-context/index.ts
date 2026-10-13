/**
 * VTID-05165 (Health Hub Phase 1 / C2) — the wellness AI context module.
 *
 * The only sanctioned path for Health Hub data into AI (program §3.5). It
 * reads only through A's S4 port (readDailyObservations, purpose
 * 'ai_context'), never a health-store table; it has no commerce purpose and
 * commerce may not import it. Ships dark: WELLNESS_CONTEXT_ENABLED unset
 * everywhere, always off on staging, no consumer wired in C2.
 * Boundaries: test/wellness-context/wellness-context-boundary.test.ts and
 * test/vtid-05025-commerce-health-boundary.test.ts.
 */

export * from './types';
export {
  buildWellnessContext,
  buildWellnessContextWith,
  defaultWellnessContextDeps,
  isWellnessContextEnabled,
  type WellnessContextDeps,
  type WellnessIdentity,
} from './context';
export { buildWellnessSystemPrompt, WELLNESS_BOUNDARY_RULES, WELLNESS_FACTS_CLOSE, WELLNESS_FACTS_OPEN } from './prompt';
export {
  activityVolume,
  sleepDurationVsBaseline,
  compareRecentToBaseline,
  RECENT_WINDOW_DAYS,
  BASELINE_WINDOW_DAYS,
  MIN_RECENT_DAYS,
  MIN_BASELINE_DAYS,
  STABLE_BAND_PCT,
} from './comparisons';
