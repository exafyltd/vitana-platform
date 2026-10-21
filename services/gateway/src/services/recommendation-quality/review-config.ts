/**
 * VTID-04669: the quality-review kill switch, in its own module so the
 * listings can read it without loading the review's LLM / code-index code.
 * AUTOPILOT_QUALITY_REVIEW_ENABLED — the exact string 'false' disables;
 * anything else (including unset) leaves the review on.
 */
export function isQualityReviewEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AUTOPILOT_QUALITY_REVIEW_ENABLED !== 'false';
}
