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
  // VTID-03820 — operator-triggered DeepSeek execution on-ramp
  // (operator-execution-onramp.ts). Gated separately by its own
  // OPERATOR_EXECUTION_ONRAMP_ENABLED kill switch and a spec_status
  // check before it ever reaches this allowlist/the safety gate.
  'operator_onramp',
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

/**
 * VTID-04108: a SEPARATE, wider allowlist for the HUMAN/OPERATOR-TRIGGERED
 * `POST /:id/activate` -> `bridgeActivationToExecution()` path only.
 *
 * `community` and `health` recommendations previously dead-ended at
 * spec_status='draft' — clicking Activate created a VTID/spec but nothing
 * ever picked it up for execution. The fix is scoped to exactly that: a
 * human explicitly activating ONE named recommendation.
 *
 * This is deliberately NOT folded into `EXECUTABLE_RECOMMENDATION_SOURCE_
 * TYPES` above. That list is also what `autoApproveTick()` polls
 * (`executableSourceTypesPostgrestIn()`) for FULLY AUTONOMOUS execution —
 * widening it directly would silently arm the autonomous loop against
 * every existing `community`/`health` recommendation sitting at
 * status='new' (307 rows measured live 2026-09-19) the moment an operator
 * next flips `auto_approve_enabled` true, with no code review in the loop
 * at all. `approveAutoExecute()` (dev-autopilot-execute.ts) reads THIS
 * list only when its caller explicitly opts in via
 * `ApprovalInput.allowManualSourceTypes: true` — `bridgeActivationToExecution()`
 * is currently the only caller that does. `autoApproveTick()`'s own poll
 * query is untouched and still reads `executableSourceTypesPostgrestIn()`.
 */
export const MANUALLY_BRIDGEABLE_SOURCE_TYPES = [
  ...EXECUTABLE_RECOMMENDATION_SOURCE_TYPES,
  // VTID-04108 — personalized, per-user recommendations. Real user_id
  // required: `recordAutopilotActivationAction`-style audit writes (the
  // existing `dev_autopilot.execution.bridged` OASIS event) still fire;
  // there is no dedicated DB audit row for these (see this VTID's
  // acceptance doc for why `autopilot_actions` was rejected as the
  // target).
  'community',
  'health',
] as const;

export type ManuallyBridgeableSourceType =
  (typeof MANUALLY_BRIDGEABLE_SOURCE_TYPES)[number];

/**
 * Guard: is this source_type eligible for a HUMAN-TRIGGERED activation
 * bridge? Wider than `isExecutableSourceType()` — never use this for an
 * autonomous polling loop.
 */
export function isManuallyBridgeableSourceType(
  source_type: string | null | undefined,
): source_type is ManuallyBridgeableSourceType {
  if (!source_type) return false;
  return (MANUALLY_BRIDGEABLE_SOURCE_TYPES as readonly string[]).includes(source_type);
}
