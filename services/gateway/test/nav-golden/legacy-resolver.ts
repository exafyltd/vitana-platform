/**
 * VTID-04496 — adapter that runs the CURRENT navigator (consultNavigator)
 * through the golden harness, mapping its result onto a NavResolution exactly
 * the way `tool_navigate` (services/orb-tools-shared.ts) acts on it:
 *
 *   ambiguous with ≥2 alternatives and no blocked_reason → clarify
 *   primary && confidence !== 'low' && no blocked_reason
 *     && the id exists in the static catalog              → open (redirect now)
 *   anything else                                         → none
 *
 * The legacy navigator has no "offer" outcome: it redirects at tool-call time
 * for both "open X" and "where is X". The harness scores that honestly as
 * right-screen-wrong-behaviour for 'where' cases.
 *
 * Callers must mock the network dependencies (knowledge hub, context pack,
 * OASIS, memory bridge) and the semantic-search entry points before importing
 * this module — see nav-golden-baseline.test.ts.
 */
import { consultNavigator } from '../../src/services/navigator-consult';
import { lookupScreen } from '../../src/lib/navigation-catalog';
import type { NavResolver } from './harness';

export const legacyResolver: NavResolver = async (c) => {
  const res = await consultNavigator({
    question: c.utterance,
    lang: c.lang,
    is_anonymous: false,
    identity: {
      user_id: '00000000-0000-0000-0000-000000000099',
      tenant_id: '00000000-0000-0000-0000-000000000001',
      role: 'community',
    },
    session_id: `golden-${c.id}`,
    turn_number: 1,
    platform: c.platform,
  });

  if (res.decision === 'ambiguous' && res.alternatives.length >= 2 && !res.blocked_reason) {
    return {
      outcome: 'clarify',
      screen_id: null,
      candidates: res.alternatives.map((a) => a.screen_id),
    };
  }
  if (res.primary && res.confidence !== 'low' && !res.blocked_reason && lookupScreen(res.primary.screen_id)) {
    return { outcome: 'open', screen_id: res.primary.screen_id };
  }
  return { outcome: 'none', screen_id: null };
};
