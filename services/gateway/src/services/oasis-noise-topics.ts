/**
 * OASIS topics that are not runtime errors of the platform.
 *
 * VTID-04666: moved out of dev-autopilot-watcher.ts so the recommendation
 * engine's OASIS analyzer applies the SAME list the verification window
 * uses. The watcher re-exports isVerificationNoiseTopic unchanged.
 */

/**
 * VTID-04377: topics that are never production blast radius of THIS merge —
 * autopilot/self-heal/CI bookkeeping (VTID-02699), ledger lifecycle and
 * on-ramp events about other VTIDs (VTID-04043), and deploy results, which
 * the deploy watcher already judged before the row reached `verifying`.
 */
export function isVerificationNoiseTopic(type: string | undefined): boolean {
  if (typeof type !== 'string') return false;
  return (
    type.startsWith('dev_autopilot.') ||
    type.startsWith('self_healing.') ||
    type.startsWith('cicd.') ||
    type.startsWith('vtid.lifecycle.') ||
    type.startsWith('operator.execution_onramp.') ||
    type.startsWith('deploy.') ||
    type.startsWith('staging.deploy.') ||
    type.startsWith('prod.deploy.') ||
    // VTID-04625: telemetry, not runtime errors — a latency measurement of a
    // member voice session that errored, and an operator-console turn record.
    type.startsWith('voice.latency.') ||
    type === 'assistant.turn'
  );
}

/**
 * VTID-04666: topics the recommendation engine must never turn into a
 * "recurring error" card. Everything the verification window ignores, plus
 * telemetry namespaces: `voice.latency.measured` is written with
 * status:'error' by orb/live/latency-tracker.ts when the measured session
 * errored — it is a measurement, not an error to fix — and `telemetry.*`
 * is by definition not a state transition (CLAUDE.md §6).
 *
 * Deploy failures are still reported: the OASIS analyzer's failed-deploy
 * pass reads deploy.* topics on its own, not through the error clustering.
 */
export function isRecommendationNoiseTopic(topic: string | undefined): boolean {
  if (typeof topic !== 'string') return false;
  return (
    isVerificationNoiseTopic(topic) ||
    topic.startsWith('voice.latency.') ||
    topic.startsWith('telemetry.')
  );
}
