/**
 * Real-Life Invite provider (advice #4) — guardrail tests.
 *
 * Invariants (mirror the SAFE conversation-flow-v3 contract):
 *   - flag gate (off → suppressed)
 *   - SPEAK-ONLY: benign offer_demo cta, never navigate / ask_permission
 *   - RULE 0: a proposal, never a passive question
 *   - no inputs → skipped (never blocks the ladder)
 */

const getSystemControlMock = jest.fn();
jest.mock('../src/services/system-controls-service', () => ({
  getSystemControl: (...a: unknown[]) => getSystemControlMock(...a),
}));

const fetchVitanaIndexForProfilerMock = jest.fn();
jest.mock('../src/services/user-context-profiler', () => ({
  fetchVitanaIndexForProfiler: (...a: unknown[]) => fetchVitanaIndexForProfilerMock(...a),
}));

import {
  makeRealLifeInviteProvider,
  REAL_LIFE_INVITE_EXTRA_KEY,
} from '../src/services/assistant-continuation/providers/real-life-invite-provider';

const supabase: any = { from: () => ({}) };
const ctx = (lang = 'de') =>
  ({ extra: { [REAL_LIFE_INVITE_EXTRA_KEY]: { supabase, tenantId: 't1', userId: 'user-1', lang, firstName: 'Mariia' } } }) as any;
const provider = makeRealLifeInviteProvider({ newId: () => 'x', now: () => 0 });

const PASSIVE = /(möchtest du|willst du|was möchtest|what would you like|how can i help|what can i do)/i;

beforeEach(() => {
  jest.clearAllMocks();
  getSystemControlMock.mockResolvedValue({ enabled: true });
  fetchVitanaIndexForProfilerMock.mockResolvedValue({ strongest_pillar: { name: 'exercise', score: 120 } });
});

describe('flag gate', () => {
  it('suppresses when the flag is off', async () => {
    getSystemControlMock.mockResolvedValue({ enabled: false });
    const r = await provider.produce(ctx());
    expect(r.status).toBe('suppressed');
    expect(r.reason).toBe('flag_disabled');
  });
});

describe('no inputs', () => {
  it('skips cleanly when extra is missing', async () => {
    const r = await provider.produce({ extra: {} } as any);
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('no_inputs');
  });
});

describe('SAFE invariants (flag on)', () => {
  it('returns a SPEAK-ONLY proposal anchored to the strongest pillar', async () => {
    const r = await provider.produce(ctx('de'));
    expect(r.status).toBe('returned');
    expect(r.candidate?.cta.type).toBe('offer_demo'); // benign, no navigation
    expect((r.candidate?.cta as any).onYesTool).toBeUndefined();
    expect(r.candidate?.userFacingLine).toContain('einen Spaziergang zu machen'); // exercise → walk
    expect(r.candidate?.userFacingLine).not.toMatch(PASSIVE); // RULE 0
  });

  it('still proposes a walk when the Index read fails', async () => {
    fetchVitanaIndexForProfilerMock.mockRejectedValue(new Error('boom'));
    const r = await provider.produce(ctx('en'));
    expect(r.status).toBe('returned');
    expect(r.candidate?.userFacingLine).toContain('to go for a walk');
  });
});
