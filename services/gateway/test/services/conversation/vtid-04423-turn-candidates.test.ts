/**
 * VTID-04423 (Plan v1 WS-2.3) — next-step decisions during the conversation,
 * exposed through get_next_best_action. Nothing is pushed unprompted.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  decideTurnCandidates,
  isTurnCandidatesEnabled,
  readTurnCandidates,
  renderTurnCandidatesText,
  toStoredTurnCandidates,
  type StoredTurnCandidate,
} from '../../../src/services/conversation/turn-candidates';
import { DEFAULT_SCORING_WEIGHTS, __resetScoringWeightsCacheForTest } from '../../../src/services/conversation/candidate-scoring';

const stored = (over: Partial<StoredTurnCandidate> = {}): StoredTurnCandidate => ({
  provider: 'journey_guide',
  kind: 'next_step',
  dedupeKey: 'jg:diary',
  priority: 70,
  ctaRoute: '/diary',
  lead: 'Your diary streak is at 4 days; logging today keeps it going.',
  tool: null,
  ...over,
});

describe('toStoredTurnCandidates', () => {
  const decision: any = {
    decisionId: 'd1',
    selectedContinuation: null,
    sourceProviderResults: [
      { providerKey: 'journey_guide', status: 'returned', candidate: { id: '1', kind: 'next_step', priority: 70, dedupeKey: 'jg', userFacingLine: '  Log your diary.  ', cta: { type: 'navigate', route: '/diary' }, privacyMode: 'safe_to_speak' } },
      { providerKey: 'goal_completion_inquiry', status: 'returned', candidate: { id: '2', kind: 'check_in', priority: 90, dedupeKey: 'gc', userFacingLine: 'Did you finish your goal?', cta: { type: 'ask_permission', onYesTool: 'mark_goal_done' }, privacyMode: 'safe_to_speak' } },
      { providerKey: 'partner_health_result_ready', status: 'returned', candidate: { id: '3', kind: 'wake_brief', priority: 95, dedupeKey: 'ph', userFacingLine: 'Your lab result is in.', cta: { type: 'noop' }, privacyMode: 'use_silently' } },
      { providerKey: 'real_life_invite', status: 'suppressed' },
    ],
  };

  it('keeps returned, speakable candidates, highest priority first, with their tool', () => {
    expect(toStoredTurnCandidates(decision)).toEqual([
      { provider: 'goal_completion_inquiry', kind: 'check_in', dedupeKey: 'gc', priority: 90, ctaRoute: null, lead: 'Did you finish your goal?', tool: 'mark_goal_done' },
      { provider: 'journey_guide', kind: 'next_step', dedupeKey: 'jg', priority: 70, ctaRoute: '/diary', lead: 'Log your diary.', tool: null },
    ]);
  });

  it('never stores a candidate a provider marked use_silently or suppress_sensitive', () => {
    expect(toStoredTurnCandidates(decision).map((c) => c.provider)).not.toContain('partner_health_result_ready');
  });
});

describe('decideTurnCandidates', () => {
  const ctx = { recentlyServed: [], recentWindow: 5, currentRoute: null, partOfDay: null, outcomes: {} };

  it('re-ranks for this moment: a just-heard candidate drops below a fresh one', () => {
    const list = [stored({ provider: 'login_briefing', priority: 85, dedupeKey: 'lb' }), stored({ provider: 'journey_guide', priority: 70 })];
    expect(decideTurnCandidates(list, ctx, DEFAULT_SCORING_WEIGHTS).map((c) => c.provider)).toEqual(['login_briefing', 'journey_guide']);
    expect(decideTurnCandidates(list, { ...ctx, recentlyServed: ['lb'] }, DEFAULT_SCORING_WEIGHTS).map((c) => c.provider)).toEqual(['journey_guide', 'login_briefing']);
  });

  it('drops candidates without a lead and honours the limit', () => {
    const list = [stored({ lead: null }), stored({ provider: 'a' }), stored({ provider: 'b' }), stored({ provider: 'c' }), stored({ provider: 'd' })];
    const r = decideTurnCandidates(list, ctx, DEFAULT_SCORING_WEIGHTS);
    expect(r).toHaveLength(3);
    expect(r.every((c) => c.lead)).toBe(true);
  });
});

describe('renderTurnCandidatesText', () => {
  it('presents leads for the model to phrase, never a line to recite', () => {
    const t = renderTurnCandidatesText([{ ...stored({ tool: 'navigate_to_screen' }), score: 0.7 }]);
    expect(t).toMatch(/leads for you, not lines to read/);
    expect(t).toMatch(/in your own words/);
    expect(t).toMatch(/\[action: navigate_to_screen\] \(source: journey_guide\)/);
    expect(t).not.toMatch(/say exactly|verbatim/i);
    expect(renderTurnCandidatesText([])).toBe('');
  });
});

describe('readTurnCandidates', () => {
  beforeEach(() => __resetScoringWeightsCacheForTest());

  function fakeSb(values: Record<string, unknown>) {
    return {
      from(table: string) {
        const q: any = {
          _key: null as string | null,
          select: () => q,
          eq: (col: string, v: unknown) => { if (col === 'key') q._key = String(v); return q; },
          order: () => q,
          limit: () => q,
          gt: () => q,
          maybeSingle: () => {
            if (table === 'conversation_scoring_weights') return Promise.resolve({ data: null, error: null });
            const v = q._key ? values[q._key] : undefined;
            return Promise.resolve({ data: v === undefined ? null : { value: v, expires_at: '2099-01-01T00:00:00Z' }, error: null });
          },
        };
        return q;
      },
      rpc: () => Promise.resolve({ data: [], error: null }),
    } as any;
  }

  it('reads the stored candidates and returns ranked leads', async () => {
    const sb = fakeSb({ brain_candidates: { decision_id: 'd', stored_at: 'x', candidates: [stored()] }, recent_openers: [] });
    const r = await readTurnCandidates(sb, 'u-1', { currentRoute: '/home' });
    expect(r.ranked.map((c) => c.provider)).toEqual(['journey_guide']);
    expect(r.text).toMatch(/Your diary streak/);
  });

  it('returns nothing when none are stored, when the kill switch is off, or on a read error', async () => {
    expect((await readTurnCandidates(fakeSb({}), 'u-1')).text).toBe('');
    const prev = process.env.BRAIN_TURN_CANDIDATES;
    process.env.BRAIN_TURN_CANDIDATES = 'false';
    try {
      expect(isTurnCandidatesEnabled()).toBe(false);
      expect((await readTurnCandidates(fakeSb({ brain_candidates: { candidates: [stored()] } }), 'u-1')).ranked).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.BRAIN_TURN_CANDIDATES; else process.env.BRAIN_TURN_CANDIDATES = prev;
    }
    const broken: any = { from: () => { throw new Error('down'); } };
    expect(await readTurnCandidates(broken, 'u-1')).toEqual({ ranked: [], text: '' });
  });
});

describe('source contracts', () => {
  const src = join(__dirname, '../../../src');
  const wiring = readFileSync(join(src, 'services/wake-brief-wiring.ts'), 'utf8');
  const tool = readFileSync(join(src, 'services/orb-tools/health-depth-tools.ts'), 'utf8');
  const turnEnd = readFileSync(join(src, 'routes/voice-next-action-turn-end.ts'), 'utf8');

  it('the wake stores the opening candidates only on a real emission', () => {
    expect(wiring).toMatch(/if \(args\.recordEmission && args\.supabase && args\.userId && isTurnCandidatesEnabled\(\)\)/);
    expect(wiring).toMatch(/writeOrbSessionState\(args\.supabase!, args\.userId!, 'brain_candidates', value, BRAIN_CANDIDATES_TTL_MIN\)/);
  });

  it('get_next_best_action appends the brain candidates to its own answer', () => {
    expect(tool).toMatch(/const brain = await readTurnCandidates\(sb, id\.user_id, \{ currentRoute: id\.current_route \?\? null \}\);/);
    expect(tool).toMatch(/brain_candidates: brain\.ranked\.map/);
  });

  it('the unsolicited turn-end nudge stays paused (VTID-03075)', () => {
    expect(turnEnd).toMatch(/turn_end_paused_pending_p0/);
  });
});
