/**
 * VTID-03053 — voice-wake-brief pillar_momentum integration tests.
 *
 * The renderer must fold in distilled pillar_momentum signals when the
 * confidence is medium/high and the suggested focus pillar is slipping
 * or unknown. Other paths MUST fall through to the existing generic
 * greeting line (no behavior regression).
 *
 * Coverage:
 *   - shouldUsePillarProactiveLine boolean matrix
 *     × policy ∈ {skip, brief_resume, warm_return, fresh_intro}
 *     × confidence ∈ {low, medium, high}
 *     × momentum ∈ {improving, steady, slipping, unknown}
 *     × suggested_focus null vs set
 *   - Per-language pillar lines emit when conditions are met
 *   - Evidence carries the pillar focus + a confidence weight
 *   - DedupeKey differentiates proactive vs generic variants
 *   - Generic path unchanged when pillarMomentum is null/undefined
 */

import {
  makeVoiceWakeBriefProvider,
  defaultVoiceWakeBriefRenderer,
  shouldUsePillarProactiveLine,
  VOICE_WAKE_BRIEF_EXTRA_KEY,
  type VoiceWakeBriefInputs,
} from '../../../../src/services/assistant-continuation/providers/voice-wake-brief';
import type { ContinuationDecisionContext } from '../../../../src/services/assistant-continuation/types';
import type { DecisionPillarMomentum, PillarKey, PillarMomentumBand, PillarMomentumConfidence } from '../../../../src/orb/context/types';

function makePm(over: Partial<DecisionPillarMomentum> = {}): DecisionPillarMomentum {
  // Distinguish "key explicitly set to null" from "key absent" — the
  // helper must support PM rows where suggested_focus or weakest_pillar
  // are intentionally null (the null/no-data case).
  const explicitSuggested = 'suggested_focus' in over ? over.suggested_focus : 'nutrition';
  const focus: PillarKey = explicitSuggested ?? 'nutrition';
  const momentum: PillarMomentumBand =
    over.per_pillar?.find((p) => p.pillar === focus)?.momentum ?? 'slipping';
  return {
    per_pillar: over.per_pillar ?? [
      { pillar: 'sleep', momentum: 'steady' },
      { pillar: 'nutrition', momentum },
      { pillar: 'exercise', momentum: 'steady' },
      { pillar: 'hydration', momentum: 'steady' },
      { pillar: 'mental', momentum: 'steady' },
    ],
    weakest_pillar: 'weakest_pillar' in over ? over.weakest_pillar! : focus,
    strongest_pillar: over.strongest_pillar ?? 'sleep',
    suggested_focus: explicitSuggested as PillarKey | null,
    confidence: over.confidence ?? 'high',
    warnings: over.warnings ?? [],
  };
}

function makeCtx(inputs: VoiceWakeBriefInputs): ContinuationDecisionContext {
  return {
    surface: 'orb_wake',
    sessionId: 's1',
    userId: 'u1',
    tenantId: 't1',
    extra: { [VOICE_WAKE_BRIEF_EXTRA_KEY]: inputs },
  };
}

describe('VTID-03053 — shouldUsePillarProactiveLine', () => {
  test('returns false when pillarMomentum is null/undefined', () => {
    expect(shouldUsePillarProactiveLine(null, 'fresh_intro')).toBe(false);
    expect(shouldUsePillarProactiveLine(undefined, 'fresh_intro')).toBe(false);
  });

  test('returns false on policy=skip even with high-confidence slipping pillar', () => {
    expect(
      shouldUsePillarProactiveLine(makePm({ confidence: 'high' }), 'skip'),
    ).toBe(false);
  });

  test('returns false on policy=brief_resume (tight follow-up line beats proactive)', () => {
    expect(
      shouldUsePillarProactiveLine(makePm({ confidence: 'high' }), 'brief_resume'),
    ).toBe(false);
  });

  test('returns false when confidence is low', () => {
    expect(
      shouldUsePillarProactiveLine(makePm({ confidence: 'low' }), 'fresh_intro'),
    ).toBe(false);
  });

  test('returns false when suggested_focus is null', () => {
    expect(
      shouldUsePillarProactiveLine(
        makePm({ suggested_focus: null, weakest_pillar: null }),
        'fresh_intro',
      ),
    ).toBe(false);
  });

  test('returns false when the suggested-focus pillar is steady or improving', () => {
    for (const momentum of ['steady', 'improving'] as PillarMomentumBand[]) {
      const pm = makePm({
        per_pillar: [
          { pillar: 'sleep', momentum: 'steady' },
          { pillar: 'nutrition', momentum },
          { pillar: 'exercise', momentum: 'steady' },
          { pillar: 'hydration', momentum: 'steady' },
          { pillar: 'mental', momentum: 'steady' },
        ],
      });
      expect(shouldUsePillarProactiveLine(pm, 'fresh_intro')).toBe(false);
    }
  });

  test('returns TRUE when focus pillar is slipping with medium+ confidence', () => {
    for (const confidence of ['medium', 'high'] as PillarMomentumConfidence[]) {
      const pm = makePm({ confidence });
      expect(shouldUsePillarProactiveLine(pm, 'fresh_intro')).toBe(true);
      expect(shouldUsePillarProactiveLine(pm, 'warm_return')).toBe(true);
    }
  });

  test('returns TRUE when focus pillar momentum is unknown (gap-filling)', () => {
    const pm = makePm({
      per_pillar: [
        { pillar: 'sleep', momentum: 'steady' },
        { pillar: 'nutrition', momentum: 'unknown' },
        { pillar: 'exercise', momentum: 'steady' },
        { pillar: 'hydration', momentum: 'steady' },
        { pillar: 'mental', momentum: 'steady' },
      ],
    });
    expect(shouldUsePillarProactiveLine(pm, 'fresh_intro')).toBe(true);
  });
});

describe('VTID-03053 — defaultVoiceWakeBriefRenderer emits pillar-specific lines', () => {
  test('emits English nutrition line when conditions met', () => {
    const line = defaultVoiceWakeBriefRenderer.render(
      { greetingPolicy: 'fresh_intro', lang: 'en', pillarMomentum: makePm() },
      makeCtx({ greetingPolicy: 'fresh_intro', lang: 'en' }),
    );
    expect(line).toContain('nutrition');
    expect(line.toLowerCase()).toContain('slipping');
  });

  test('emits German nutrition line when conditions met', () => {
    const line = defaultVoiceWakeBriefRenderer.render(
      { greetingPolicy: 'fresh_intro', lang: 'de', pillarMomentum: makePm() },
      makeCtx({ greetingPolicy: 'fresh_intro', lang: 'de' }),
    );
    expect(line.toLowerCase()).toContain('ernährungs-säule');
    // German line says "sackt … etwas ab" (split verb), not "absackt".
    expect(line.toLowerCase()).toContain('sackt');
  });

  test('emits per-pillar line for each PillarKey', () => {
    const pillars: PillarKey[] = ['sleep', 'nutrition', 'exercise', 'hydration', 'mental'];
    for (const pillar of pillars) {
      const pm = makePm({
        suggested_focus: pillar,
        weakest_pillar: pillar,
        per_pillar: [
          { pillar: 'sleep', momentum: pillar === 'sleep' ? 'slipping' : 'steady' },
          { pillar: 'nutrition', momentum: pillar === 'nutrition' ? 'slipping' : 'steady' },
          { pillar: 'exercise', momentum: pillar === 'exercise' ? 'slipping' : 'steady' },
          { pillar: 'hydration', momentum: pillar === 'hydration' ? 'slipping' : 'steady' },
          { pillar: 'mental', momentum: pillar === 'mental' ? 'slipping' : 'steady' },
        ],
      });
      const line = defaultVoiceWakeBriefRenderer.render(
        { greetingPolicy: 'fresh_intro', lang: 'en', pillarMomentum: pm },
        makeCtx({ greetingPolicy: 'fresh_intro', lang: 'en' }),
      );
      expect(line.length).toBeGreaterThan(0);
      // The pillar name should appear in the rendered text (English).
      expect(line.toLowerCase()).toContain(pillar);
    }
  });

  test('falls through to generic greeting when pillarMomentum is null', () => {
    const line = defaultVoiceWakeBriefRenderer.render(
      { greetingPolicy: 'fresh_intro', lang: 'en', pillarMomentum: null },
      makeCtx({ greetingPolicy: 'fresh_intro', lang: 'en' }),
    );
    expect(line).toBe("Hello! Let me show you where we'll begin.");
  });

  test('falls through to generic greeting when pillarMomentum is omitted', () => {
    const line = defaultVoiceWakeBriefRenderer.render(
      { greetingPolicy: 'warm_return', lang: 'de' },
      makeCtx({ greetingPolicy: 'warm_return', lang: 'de' }),
    );
    expect(line).toContain('Schön, dass du wieder da bist');
  });

  test('falls through to generic greeting when policy is brief_resume', () => {
    const line = defaultVoiceWakeBriefRenderer.render(
      { greetingPolicy: 'brief_resume', lang: 'en', pillarMomentum: makePm() },
      makeCtx({ greetingPolicy: 'brief_resume', lang: 'en' }),
    );
    // Proactive-lead copy that leads to the next step — NOT a bluffed "pick up
    // where we left off" with no recalled content behind it.
    expect(line).toBe('Welcome back. Let me show you your next step.');
  });
});

describe('VTID-03053 — provider candidate carries pillar evidence', () => {
  test('returned candidate evidence + dedupeKey reflect the proactive variant', () => {
    const provider = makeVoiceWakeBriefProvider({
      newId: () => 'fixed-id',
      now: () => 1_700_000_000_000,
    });
    const ctx = makeCtx({
      greetingPolicy: 'fresh_intro',
      lang: 'en',
      pillarMomentum: makePm({ suggested_focus: 'nutrition', confidence: 'high' }),
    });
    const r = provider.produce(ctx);
    expect(r.status).toBe('returned');
    if (r.status !== 'returned') return;
    const c = r.candidate!;
    expect(c.evidence.some((e) => e.kind === 'greeting_policy')).toBe(true);
    expect(c.evidence.some((e) => e.kind === 'pillar_momentum_slipping')).toBe(true);
    const pillarEvidence = c.evidence.find((e) => e.kind === 'pillar_momentum_slipping')!;
    expect(pillarEvidence.detail).toBe('nutrition');
    expect(pillarEvidence.weight).toBe(1); // high confidence
    // DedupeKey differentiates proactive from generic.
    expect(c.dedupeKey).toBe('wake-brief-fresh_intro-pillar-nutrition');
    expect(c.userFacingLine.toLowerCase()).toContain('nutrition');
  });

  test('generic candidate dedupeKey is unchanged when pillarMomentum is null', () => {
    const provider = makeVoiceWakeBriefProvider({
      newId: () => 'fixed-id',
      now: () => 1_700_000_000_000,
    });
    const ctx = makeCtx({
      greetingPolicy: 'fresh_intro',
      lang: 'en',
      pillarMomentum: null,
    });
    const r = provider.produce(ctx);
    expect(r.status).toBe('returned');
    if (r.status !== 'returned') return;
    expect(r.candidate!.dedupeKey).toBe('wake-brief-fresh_intro');
    expect(r.candidate!.evidence.some((e) => e.kind === 'pillar_momentum_slipping')).toBe(false);
  });
});
