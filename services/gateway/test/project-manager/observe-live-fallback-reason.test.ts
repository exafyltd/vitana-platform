/**
 * VTID-05356 (plan pipeline-agent-wake-and-review, lane review-fallback-trailer).
 *
 * A review commit's `Collab-Fallback-Reason` trailer is carried into `ReviewEntry.fallback_reason`, next to
 * `Collab-Reviewer` / `Collab-Reviewed-Head`. Absent → null. Any value is kept verbatim (the governance lane
 * `reviewer-fallback` decides what it means). Nothing reads the field yet, so no PM decision changes.
 */
import { mergeTrailerReviews } from '../../src/services/project-manager/observe-live';

const LANE = 'pipeline-agent-wake-and-review/driver-wake';
const HEAD = 'a'.repeat(40);
const commit = (trailers: Record<string, string>) => ({
  sha: 'b'.repeat(40),
  date: '2026-10-28T12:00:00Z',
  message: `review: ${LANE}\n\n${Object.entries(trailers).map(([k, v]) => `${k}: ${v}`).join('\n')}`,
});
const base = {
  'Collab-Session': 'agent-vitana-lane-reviewer-independent-202610281200-ab12',
  'Collab-Review': LANE,
  'Collab-Verdict': 'accept',
  'Collab-Reviewer': 'agent:vitana-lane-reviewer-independent (gpt-5.6-terra)',
  'Collab-Reviewed-Head': HEAD,
};

describe('mergeTrailerReviews: Collab-Fallback-Reason', () => {
  it('sets fallback_reason from the trailer', () => {
    const [r] = mergeTrailerReviews([], [commit({ ...base, 'Collab-Fallback-Reason': 'chain_unavailable' })] as never, LANE, 'agent:vitana-lane-reviewer');
    expect(r.fallback_reason).toBe('chain_unavailable');
    expect(r.reviewer).toBe('agent:vitana-lane-reviewer-independent (gpt-5.6-terra)');
    expect(r.head_sha).toBe(HEAD);
  });

  it('is null when the trailer is absent', () => {
    const [r] = mergeTrailerReviews([], [commit(base)] as never, LANE, 'agent:vitana-lane-reviewer');
    expect(r.fallback_reason).toBeNull();
  });

  it('keeps any other value verbatim', () => {
    const [r] = mergeTrailerReviews([], [commit({ ...base, 'Collab-Fallback-Reason': 'something_else' })] as never, LANE, 'agent:vitana-lane-reviewer');
    expect(r.fallback_reason).toBe('something_else');
  });

  it('a log entry merged with its trailer commit takes the trailer value; other lanes are ignored', () => {
    const fromLog = [{ session_id: base['Collab-Session'], reviewer_seat: 'agent:vitana-lane-reviewer', verdict: 'accept' as const, head_sha: HEAD, at: '2026-10-28T12:00:00.000Z', reviewer: null }];
    const out = mergeTrailerReviews(fromLog, [
      commit({ ...base, 'Collab-Fallback-Reason': 'chain_unavailable' }),
      commit({ ...base, 'Collab-Review': 'other/lane', 'Collab-Fallback-Reason': 'x' }),
    ] as never, LANE, 'agent:vitana-lane-reviewer');
    expect(out).toHaveLength(1);
    expect(out[0].fallback_reason).toBe('chain_unavailable');
  });
});
