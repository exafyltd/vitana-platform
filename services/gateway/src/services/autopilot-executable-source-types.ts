/**
 * VTID-02984 (PR-M1.x): shared allowlist for executable Autopilot
 * recommendation source_types.
 *
 * Before this PR, dev-autopilot-execute.ts hard-coded `source_type` checks
 * to only `dev_autopilot` / `dev_autopilot_impact`. Recommendations from
 * the test-contract autonomy spine (PR-L2 missing-test-scanner, PR-L3
 * failure-scanner) sat at status='new' forever — autoApproveTick's
 * polling filter excluded them, and the two executeRecommendation
 * guards rejected them outright. Discovered live during the M1
 * worker-runner canary smoke (VTID-02977).
 *
 * This file is the SINGLE place that lists which source_types are
 * eligible to enter the executor lane. Adding a new scanner that
 * produces auto-executable recommendations means adding its
 * source_type here in a code-reviewed PR. Unknown source_types stay
 * rejected.
 */

/**
 * Executable source_types. Order is not significant; both PostgREST
 * `in.()` filters and TypeScript guard checks treat this as a set.
 */
export const EXECUTABLE_RECOMMENDATION_SOURCE_TYPES = [
  // PR-L2 — Missing-Test Scanner (write a test file + register a contract)
  'missing-test-scanner',
  // PR-L3 — Failure Scanner (fix the failing assertion / restore the
  // capability the contract guarantees)
  'test-contract-failure-scanner',
  // Legacy dev-autopilot baseline scan (twice-daily codebase smell detectors)
  'dev_autopilot',
  // PR-1234 lineage — diff-aware impact rules
  'dev_autopilot_impact',
] as const;

export type ExecutableRecommendationSourceType =
  (typeof EXECUTABLE_RECOMMENDATION_SOURCE_TYPES)[number];

/**
 * Guard: is this source_type eligible for the executor lane?
 *
 * Use in executeRecommendation()-style entry points. Returns false for
 * unknown source_types so a typo in a future scanner or a misrouted
 * row stays rejected.
 */
export function isExecutableSourceType(
  source_type: string | null | undefined,
): source_type is ExecutableRecommendationSourceType {
  if (!source_type) return false;
  return (EXECUTABLE_RECOMMENDATION_SOURCE_TYPES as readonly string[]).includes(source_type);
}

/**
 * Render the allowlist as a PostgREST `in.(...)` value: `"a","b","c"`.
 * URL-encodes each value defensively. Used by autoApproveTick to poll
 * `autopilot_recommendations?source_type=in.(...)`.
 */
export function executableSourceTypesPostgrestIn(): string {
  return EXECUTABLE_RECOMMENDATION_SOURCE_TYPES.map(
    (t) => `"${encodeURIComponent(t)}"`,
  ).join(',');
}
