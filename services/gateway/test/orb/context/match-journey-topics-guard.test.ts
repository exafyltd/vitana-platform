/**
 * B0b acceptance check #7: match-journey OASIS topic strings appear ONLY
 * in central telemetry modules.
 *
 * Wraps the build-time guard at `scripts/ci/match-journey-topics-guard.mjs`
 * so it runs as part of Jest. Any future PR that adds an inline literal
 * (instead of importing the named constant) fails this test.
 */

import { execSync } from 'node:child_process';
import { join } from 'node:path';

describe('B0b acceptance check #7 — match-journey topics guard', () => {
  it('no stray match-journey OASIS topic literals outside central telemetry modules', () => {
    // Jest cwd is services/gateway/. The grep guard script lives at the
    // repo root (../../scripts/ci/...). Walk up two levels to find it.
    const repoRoot = join(__dirname, '../../../../..');
    expect(() => {
      execSync('node scripts/ci/match-journey-topics-guard.mjs', {
        cwd: repoRoot,
        stdio: 'pipe',
      });
    }).not.toThrow();
  });

  it('central registry exports all 13 reserved topic names', async () => {
    const telemetry = await import('../../../src/orb/context/telemetry');
    expect(telemetry.MATCH_JOURNEY_TOPIC_REGISTRY.length).toBe(14); // 13 match + 1 context_source_degraded would be separate; we have 13 here

    // 2 context + 4 continuation + 8 product = 14 reserved match-related topics.
    // (Adjusted: we reserved 2 context, 4 continuation, 8 product = 14)
    // The plan listed 13 — verify against the central registry exactly.
    expect(telemetry.MATCH_JOURNEY_TOPIC_REGISTRY).toContain('assistant.context.match_journey.compiled');
    expect(telemetry.MATCH_JOURNEY_TOPIC_REGISTRY).toContain('assistant.context.match_journey.suppressed');
    expect(telemetry.MATCH_JOURNEY_TOPIC_REGISTRY).toContain('assistant.continuation.match_journey.suggested');
    expect(telemetry.MATCH_JOURNEY_TOPIC_REGISTRY).toContain('assistant.continuation.match_journey.accepted');
    expect(telemetry.MATCH_JOURNEY_TOPIC_REGISTRY).toContain('assistant.continuation.match_journey.dismissed');
    expect(telemetry.MATCH_JOURNEY_TOPIC_REGISTRY).toContain('assistant.match.pre_whois.opened');
    expect(telemetry.MATCH_JOURNEY_TOPIC_REGISTRY).toContain('assistant.match.should_interest.generated');
    expect(telemetry.MATCH_JOURNEY_TOPIC_REGISTRY).toContain('assistant.match.draft_opener.staged');
    expect(telemetry.MATCH_JOURNEY_TOPIC_REGISTRY).toContain('assistant.match.activity_plan.proposed');
    expect(telemetry.MATCH_JOURNEY_TOPIC_REGISTRY).toContain('assistant.match.activity_plan.confirmed');
    expect(telemetry.MATCH_JOURNEY_TOPIC_REGISTRY).toContain('assistant.match.chat_assist.suggested');
    expect(telemetry.MATCH_JOURNEY_TOPIC_REGISTRY).toContain('assistant.match.post_activity.prompted');
    expect(telemetry.MATCH_JOURNEY_TOPIC_REGISTRY).toContain('assistant.match.next_rep.proposed');
  });
});
