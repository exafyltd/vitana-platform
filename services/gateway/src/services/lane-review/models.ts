/**
 * Bedrock lane reviewer — model chain.
 *
 * `name` is what the Collab-Reviewer trailer and the gates check (`agent:bedrock-lane-reviewer (<name>)`).
 * `profile` is the Bedrock inference profile sent at invocation. They are separate on purpose: the gates compare
 * names, Bedrock needs profiles. Order is the fallback order: primary first, then the next tier on any failure.
 * No DeepSeek tier: a review must return a verdict through the submit tool, and the plan-sparring fallback to
 * DeepSeek is not used here.
 */
export interface LaneReviewerModel {
  readonly name: string;
  readonly profile: string;
}

export const LANE_REVIEWER_CHAIN: readonly LaneReviewerModel[] = Object.freeze([
  Object.freeze({ name: 'claude-opus-4.6', profile: 'eu.anthropic.claude-opus-4-6-v1' }),
  Object.freeze({ name: 'claude-sonnet-4.6', profile: 'eu.anthropic.claude-sonnet-4-6' }),
]);

/** The reviewer identity recorded in a verdict's Collab-Reviewer trailer. */
export const BEDROCK_LANE_REVIEWER = 'agent:bedrock-lane-reviewer';
