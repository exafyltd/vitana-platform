/**
 * Voice surface tests for the shared Autopilot service — VTID-03201.
 *
 * The ORB voice tools (get_autopilot_recommendations /
 * activate_autopilot_recommendations) project the SAME list the popup shows
 * (listCommunityAutopilotRecommendations) into speech via
 * summarizeAutopilotForVoice, and remember the listed ids so a follow-up
 * "activate those" resolves to exactly what was read aloud.
 *
 * These tests lock the projection contract: the spoken summary, the count,
 * and — critically — that the ids carried for activation are the SAME ids, in
 * the SAME order, as the recommendations that were listed (so the spoken list
 * and the popup list can never diverge).
 */

import {
  summarizeAutopilotForVoice,
  type CommunityRecommendationView,
} from '../../src/routes/autopilot-recommendations';

function view(id: string, title: string): CommunityRecommendationView {
  return {
    id,
    title,
    summary: null,
    source_ref: null,
    domain: null,
    impact_score: null,
    time_estimate_seconds: null,
    status: 'new',
  };
}

describe('summarizeAutopilotForVoice', () => {
  it('handles an empty queue without inventing actions', () => {
    const s = summarizeAutopilotForVoice([]);
    expect(s.count).toBe(0);
    expect(s.ids).toEqual([]);
    // VTID-03245 (#2480) reworded the empty-queue line for offer-integrity:
    // "You don't have any Autopilot actions prepared yet …". Assert the
    // "no actions" meaning without pinning the exact marketing copy.
    expect(s.spoken).toMatch(/don't have any Autopilot actions/i);
  });

  it('uses the singular form for exactly one action', () => {
    const s = summarizeAutopilotForVoice([view('a', 'Try a live room')]);
    expect(s.count).toBe(1);
    expect(s.ids).toEqual(['a']);
    expect(s.spoken).toMatch(/one Autopilot action/i);
    expect(s.spoken).toContain('Try a live room');
  });

  it('lists multiple actions in order with a count', () => {
    const recs = [
      view('a', 'Attend a meetup'),
      view('b', 'Hydration check-in'),
      view('c', 'Meditation / breathwork'),
    ];
    const s = summarizeAutopilotForVoice(recs);
    expect(s.count).toBe(3);
    expect(s.spoken).toMatch(/3 Autopilot actions/i);
    // numbered + ordered
    expect(s.spoken).toContain('1. Attend a meetup');
    expect(s.spoken).toContain('2. Hydration check-in');
    expect(s.spoken).toContain('3. Meditation / breathwork');
  });

  it('carries the SAME ids in the SAME order as the listed recs (popup/voice parity)', () => {
    const recs = [view('id-1', 'A'), view('id-2', 'B'), view('id-3', 'C')];
    const s = summarizeAutopilotForVoice(recs);
    // The ids the voice layer stashes for "activate those" must equal the
    // ids of the recommendations that were read aloud, in the same order.
    expect(s.ids).toEqual(recs.map(r => r.id));
  });
});
