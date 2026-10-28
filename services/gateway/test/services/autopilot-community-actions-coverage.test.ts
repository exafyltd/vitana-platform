/**
 * Coverage guard for the community action map — VTID-03201.
 *
 * The Autopilot popup hides any community recommendation whose `source_ref` is
 * not present in COMMUNITY_ACTIONS (autopilot-recommendations.ts). The
 * index-gap analyzer emits `pillar_template_<pillar>` and `try_live_room`
 * source_refs; before this fix they were generated and then silently dropped,
 * which (combined with the dedupe bug) helped empty the popup.
 *
 * This test fails if an analyzer-produced source_ref ever drifts out of the
 * action map again.
 */

import { COMMUNITY_ACTIONS } from '../../src/routes/autopilot-recommendations';
import { MENTAL_COMMUNITY_SOURCE_REFS } from '../../src/services/recommendation-engine/analyzers/index-gap-analyzer';
import { PILLAR_KEYS } from '../../src/lib/vitana-pillars';

describe('COMMUNITY_ACTIONS coverage', () => {
  it('maps every per-pillar template source_ref the index-gap analyzer emits', () => {
    for (const pillar of PILLAR_KEYS) {
      const ref = `pillar_template_${pillar}`;
      expect(COMMUNITY_ACTIONS[ref]).toBeDefined();
    }
  });

  it('maps every mental-community source_ref the index-gap analyzer rotates through', () => {
    for (const ref of MENTAL_COMMUNITY_SOURCE_REFS) {
      expect(COMMUNITY_ACTIONS[ref]).toBeDefined();
    }
  });

  it('maps the previously-unmapped refs that this fix added', () => {
    for (const ref of [
      'try_live_room',
      'pillar_template_nutrition',
      'pillar_template_hydration',
      'pillar_template_exercise',
      'pillar_template_sleep',
      'pillar_template_mental',
    ]) {
      expect(COMMUNITY_ACTIONS[ref]).toBeDefined();
    }
  });

  it('every action has a valid action_type and a completion message', () => {
    for (const [ref, action] of Object.entries(COMMUNITY_ACTIONS)) {
      expect(['navigate', 'notify']).toContain(action.action_type);
      expect(action.completion_message.length).toBeGreaterThan(0);
      // navigate actions must carry a target route
      if (action.action_type === 'navigate') {
        expect(typeof action.target).toBe('string');
        expect((action.target ?? '').startsWith('/')).toBe(true);
        expect(ref.length).toBeGreaterThan(0);
      }
    }
  });
});
