/**
 * VTID-02915 (B0d.2) — Voice Wake Brief provider tests.
 *
 * BOOTSTRAP-ORB-NO-HARDCODED-GREETING: the provider is now
 * GROUNDED-OR-SILENT. There is no generic canned greeting pool
 * (`DEFAULT_LINES`) any more. The provider speaks ONLY when it has a
 * grounded, data-driven line — the pillar-momentum observation derived
 * from the user's real pillar trend. Every other case suppresses with
 * reason `no_grounded_line_grounded_or_silent`.
 *
 * Coverage matrix (updated for the new contract):
 *   - `greetingPolicy === 'skip'`                 → suppressed (greeting_policy_skip).
 *   - non-skip policy WITHOUT grounded pillar      → suppressed
 *       (no_grounded_line_grounded_or_silent), NO candidate.
 *   - non-skip policy WITH qualifying pillar       → returned grounded
 *       pillar-momentum line.
 *   - Missing inputs → skipped (with reason `no_voice_wake_brief_inputs`).
 *   - Malformed inputs → skipped (defensive — typo'd policy, wrong types).
 *   - Renderer throws / empty → errored — only reachable when pillar
 *       momentum qualifies (produce() suppresses before render otherwise),
 *       so these tests pass qualifying pillar momentum.
 *   - Candidate shape is contract-conformant + carries pillar evidence.
 *   - End-to-end: registered with a real registry, decideContinuation
 *     selects the grounded candidate (pillar momentum) and the result
 *     passes the runtime validator; on a no-grounded-line path the
 *     decision suppresses (selectedContinuation null).
 */

import {
  makeVoiceWakeBriefProvider,
  defaultVoiceWakeBriefRenderer,
  VOICE_WAKE_BRIEF_PROVIDER_KEY,
  VOICE_WAKE_BRIEF_EXTRA_KEY,
  type VoiceWakeBriefInputs,
  type VoiceWakeBriefRenderer,
} from '../../../../src/services/assistant-continuation/providers/voice-wake-brief';
import {
  validateContinuationCandidate,
  type ContinuationDecisionContext,
  type ProviderResult,
} from '../../../../src/services/assistant-continuation/types';
import { decideContinuation } from '../../../../src/services/assistant-continuation/decide-continuation';
import { createProviderRegistry } from '../../../../src/services/assistant-continuation/provider-registry';
import type { DecisionPillarMomentum, PillarKey } from '../../../../src/orb/context/types';

/**
 * A pillar-momentum view that QUALIFIES for the grounded proactive line:
 * confidence high, suggested_focus set, and that pillar is slipping.
 */
function qualifyingPm(focus: PillarKey = 'sleep'): DecisionPillarMomentum {
  return {
    per_pillar: [
      { pillar: 'sleep', momentum: focus === 'sleep' ? 'slipping' : 'steady' },
      { pillar: 'nutrition', momentum: focus === 'nutrition' ? 'slipping' : 'steady' },
      { pillar: 'exercise', momentum: focus === 'exercise' ? 'slipping' : 'steady' },
      { pillar: 'hydration', momentum: focus === 'hydration' ? 'slipping' : 'steady' },
      { pillar: 'mental', momentum: focus === 'mental' ? 'slipping' : 'steady' },
    ],
    weakest_pillar: focus,
    strongest_pillar: focus === 'sleep' ? 'nutrition' : 'sleep',
    suggested_focus: focus,
    confidence: 'high',
    warnings: [],
  };
}

function makeCtx(
  inputs: VoiceWakeBriefInputs | undefined,
  over: Partial<ContinuationDecisionContext> = {},
): ContinuationDecisionContext {
  const ctx: ContinuationDecisionContext = {
    surface: 'orb_wake',
    sessionId: 's1',
    userId: 'u1',
    tenantId: 't1',
    ...over,
  };
  if (inputs !== undefined) {
    ctx.extra = { ...(ctx.extra ?? {}), [VOICE_WAKE_BRIEF_EXTRA_KEY]: inputs };
  }
  return ctx;
}

function frozenNewId(prefix = 'id') {
  let i = 0;
  return () => `${prefix}-${++i}`;
}

function frozenNow(start = 1_700_000_000_000) {
  let t = start;
  return () => {
    const v = t;
    t += 5;
    return v;
  };
}

describe('B0d.2 — Voice Wake Brief provider', () => {
  describe('greeting-policy gating', () => {
    it('suppresses on policy="skip" with reason greeting_policy_skip', async () => {
      const provider = makeVoiceWakeBriefProvider({
        now: frozenNow(),
        newId: frozenNewId(),
      });
      const result = (await provider.produce(
        makeCtx({ greetingPolicy: 'skip' }),
      )) as ProviderResult;
      expect(result.status).toBe('suppressed');
      expect(result.reason).toBe('greeting_policy_skip');
      expect(result.candidate).toBeUndefined();
    });

    it.each(['brief_resume', 'warm_return', 'fresh_intro'] as const)(
      'suppresses (grounded-or-silent) on policy="%s" with no grounded line',
      async (policy) => {
        const provider = makeVoiceWakeBriefProvider({
          now: frozenNow(),
          newId: frozenNewId(),
        });
        const result = (await provider.produce(
          makeCtx({ greetingPolicy: policy }),
        )) as ProviderResult;
        expect(result.status).toBe('suppressed');
        expect(result.reason).toBe('no_grounded_line_grounded_or_silent');
        expect(result.candidate).toBeUndefined();
      },
    );

    it.each(['warm_return', 'fresh_intro'] as const)(
      'returns the grounded pillar line on policy="%s" with qualifying pillar momentum',
      async (policy) => {
        const provider = makeVoiceWakeBriefProvider({
          now: frozenNow(),
          newId: frozenNewId(),
        });
        const result = (await provider.produce(
          makeCtx({ greetingPolicy: policy, pillarMomentum: qualifyingPm('sleep') }),
        )) as ProviderResult;
        expect(result.status).toBe('returned');
        expect(result.candidate).toBeDefined();
        expect(result.candidate?.kind).toBe('wake_brief');
        expect(result.candidate?.userFacingLine.length).toBeGreaterThan(0);
      },
    );
  });

  describe('input handling', () => {
    it('skips when ctx.extra is absent', async () => {
      const provider = makeVoiceWakeBriefProvider({
        now: frozenNow(),
        newId: frozenNewId(),
      });
      const result = (await provider.produce({
        surface: 'orb_wake',
      })) as ProviderResult;
      expect(result.status).toBe('skipped');
      expect(result.reason).toBe('no_voice_wake_brief_inputs');
    });

    it('skips when extra.voiceWakeBrief is missing the policy', async () => {
      const provider = makeVoiceWakeBriefProvider({
        now: frozenNow(),
        newId: frozenNewId(),
      });
      const result = (await provider.produce({
        surface: 'orb_wake',
        extra: { [VOICE_WAKE_BRIEF_EXTRA_KEY]: {} },
      })) as ProviderResult;
      expect(result.status).toBe('skipped');
      expect(result.reason).toBe('no_voice_wake_brief_inputs');
    });

    it('skips when greetingPolicy is a bogus value', async () => {
      const provider = makeVoiceWakeBriefProvider({
        now: frozenNow(),
        newId: frozenNewId(),
      });
      const result = (await provider.produce({
        surface: 'orb_wake',
        extra: { [VOICE_WAKE_BRIEF_EXTRA_KEY]: { greetingPolicy: 'made_up' } },
      })) as ProviderResult;
      expect(result.status).toBe('skipped');
      expect(result.reason).toBe('no_voice_wake_brief_inputs');
    });

    it('ignores a non-string lang field (falls back to English pillar line)', async () => {
      const provider = makeVoiceWakeBriefProvider({
        now: frozenNow(),
        newId: frozenNewId(),
      });
      const result = (await provider.produce({
        surface: 'orb_wake',
        extra: {
          [VOICE_WAKE_BRIEF_EXTRA_KEY]: {
            greetingPolicy: 'fresh_intro',
            lang: 42,
            pillarMomentum: qualifyingPm('sleep'),
          },
        },
      })) as ProviderResult;
      expect(result.status).toBe('returned');
      // English fallback when lang is unusable — the grounded sleep line.
      expect(result.candidate?.userFacingLine).toBe(
        "Your sleep pillar has been slipping lately. Let me show you what's getting in the way.",
      );
    });
  });

  describe('language selection (grounded pillar line)', () => {
    it('renders German when lang="de"', async () => {
      const provider = makeVoiceWakeBriefProvider({
        now: frozenNow(),
        newId: frozenNewId(),
      });
      const result = (await provider.produce(
        makeCtx({ greetingPolicy: 'fresh_intro', lang: 'de', pillarMomentum: qualifyingPm('sleep') }),
      )) as ProviderResult;
      expect(result.candidate?.userFacingLine).toBe(
        'Deine Schlaf-Säule sackt in letzter Zeit etwas ab. Lass mich dir zeigen, was da hineinspielt.',
      );
    });

    it('falls back to English for an unknown lang', async () => {
      const provider = makeVoiceWakeBriefProvider({
        now: frozenNow(),
        newId: frozenNewId(),
      });
      const result = (await provider.produce(
        makeCtx({ greetingPolicy: 'fresh_intro', lang: 'xx', pillarMomentum: qualifyingPm('sleep') }),
      )) as ProviderResult;
      expect(result.candidate?.userFacingLine).toBe(
        "Your sleep pillar has been slipping lately. Let me show you what's getting in the way.",
      );
    });

    it('defaults to English when lang is absent', async () => {
      const provider = makeVoiceWakeBriefProvider({
        now: frozenNow(),
        newId: frozenNewId(),
      });
      const result = (await provider.produce(
        makeCtx({ greetingPolicy: 'warm_return', pillarMomentum: qualifyingPm('sleep') }),
      )) as ProviderResult;
      expect(result.candidate?.userFacingLine).toBe(
        "Your sleep pillar has been slipping lately. Let me show you what's getting in the way.",
      );
    });
  });

  describe('renderer injection + error paths', () => {
    // The injected-renderer paths are only reached when pillar momentum
    // qualifies — produce() suppresses BEFORE rendering otherwise. So
    // every renderer test supplies qualifying pillar momentum.
    it('uses the injected renderer when supplied', async () => {
      const customRenderer: VoiceWakeBriefRenderer = {
        render: () => 'CUSTOM LINE',
      };
      const provider = makeVoiceWakeBriefProvider({
        renderer: customRenderer,
        now: frozenNow(),
        newId: frozenNewId(),
      });
      const result = (await provider.produce(
        makeCtx({ greetingPolicy: 'fresh_intro', pillarMomentum: qualifyingPm('sleep') }),
      )) as ProviderResult;
      expect(result.candidate?.userFacingLine).toBe('CUSTOM LINE');
    });

    it('reports renderer throws as status=errored (no exception escapes)', async () => {
      const exploding: VoiceWakeBriefRenderer = {
        render: () => {
          throw new Error('kaboom');
        },
      };
      const provider = makeVoiceWakeBriefProvider({
        renderer: exploding,
        now: frozenNow(),
        newId: frozenNewId(),
      });
      const result = (await provider.produce(
        makeCtx({ greetingPolicy: 'fresh_intro', pillarMomentum: qualifyingPm('sleep') }),
      )) as ProviderResult;
      expect(result.status).toBe('errored');
      expect(result.reason).toBe('kaboom');
    });

    it('reports empty renderer output as status=errored', async () => {
      const emptyRenderer: VoiceWakeBriefRenderer = { render: () => '   ' };
      const provider = makeVoiceWakeBriefProvider({
        renderer: emptyRenderer,
        now: frozenNow(),
        newId: frozenNewId(),
      });
      const result = (await provider.produce(
        makeCtx({ greetingPolicy: 'fresh_intro', pillarMomentum: qualifyingPm('sleep') }),
      )) as ProviderResult;
      expect(result.status).toBe('errored');
      expect(result.reason).toBe('renderer_produced_empty_line');
    });
  });

  describe('candidate shape', () => {
    it('produces a candidate that passes the runtime validator', async () => {
      const provider = makeVoiceWakeBriefProvider({
        now: frozenNow(),
        newId: frozenNewId(),
      });
      const result = (await provider.produce(
        makeCtx({ greetingPolicy: 'warm_return', pillarMomentum: qualifyingPm('sleep') }),
      )) as ProviderResult;
      expect(result.status).toBe('returned');
      const validation = validateContinuationCandidate(result.candidate);
      expect(validation).toEqual({ ok: true });
    });

    it('carries evidence pointing back to the greeting policy + the grounded pillar', async () => {
      const provider = makeVoiceWakeBriefProvider({
        now: frozenNow(),
        newId: frozenNewId(),
      });
      const result = (await provider.produce(
        makeCtx({ greetingPolicy: 'warm_return', pillarMomentum: qualifyingPm('sleep') }),
      )) as ProviderResult;
      expect(
        result.candidate?.evidence.some((e) => e.kind === 'greeting_policy' && e.detail === 'warm_return'),
      ).toBe(true);
      expect(
        result.candidate?.evidence.some(
          (e) => e.kind === 'pillar_momentum_slipping' && e.detail === 'sleep',
        ),
      ).toBe(true);
    });

    it('uses a stable dedupeKey per policy+pillar (same inputs → same key)', async () => {
      const provider = makeVoiceWakeBriefProvider({
        now: frozenNow(),
        newId: frozenNewId(),
      });
      const r1 = (await provider.produce(
        makeCtx({ greetingPolicy: 'fresh_intro', pillarMomentum: qualifyingPm('sleep') }),
      )) as ProviderResult;
      const r2 = (await provider.produce(
        makeCtx({ greetingPolicy: 'fresh_intro', pillarMomentum: qualifyingPm('sleep') }),
      )) as ProviderResult;
      expect(r1.candidate?.dedupeKey).toBe('wake-brief-fresh_intro-pillar-sleep');
      expect(r2.candidate?.dedupeKey).toBe(r1.candidate?.dedupeKey);
    });

    it('honors an overridden priority', async () => {
      const provider = makeVoiceWakeBriefProvider({
        priority: 5,
        now: frozenNow(),
        newId: frozenNewId(),
      });
      const result = (await provider.produce(
        makeCtx({ greetingPolicy: 'warm_return', pillarMomentum: qualifyingPm('sleep') }),
      )) as ProviderResult;
      expect(result.candidate?.priority).toBe(5);
    });

    it('default priority is 80', async () => {
      const provider = makeVoiceWakeBriefProvider({
        now: frozenNow(),
        newId: frozenNewId(),
      });
      const result = (await provider.produce(
        makeCtx({ greetingPolicy: 'warm_return', pillarMomentum: qualifyingPm('sleep') }),
      )) as ProviderResult;
      expect(result.candidate?.priority).toBe(80);
    });
  });

  describe('provider identity', () => {
    it('exports the canonical key', () => {
      const provider = makeVoiceWakeBriefProvider();
      expect(provider.key).toBe(VOICE_WAKE_BRIEF_PROVIDER_KEY);
      expect(VOICE_WAKE_BRIEF_PROVIDER_KEY).toBe('voice_wake_brief');
    });

    it('services the orb_wake surface only', () => {
      const provider = makeVoiceWakeBriefProvider();
      expect(provider.surfaces).toEqual(['orb_wake']);
    });
  });

  describe('latency capture (B0d.3 dependency)', () => {
    it('reports a non-negative latency', async () => {
      const provider = makeVoiceWakeBriefProvider({ now: frozenNow() });
      const result = (await provider.produce(
        makeCtx({ greetingPolicy: 'fresh_intro' }),
      )) as ProviderResult;
      expect(typeof result.latencyMs).toBe('number');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });
});

// ──────────────────────────────────────────────────────────────────────
// End-to-end integration with decideContinuation. Confirms the
// provider plugs into the B0d.1 orchestrator without surprises.
// ──────────────────────────────────────────────────────────────────────

describe('B0d.2 — end-to-end through decideContinuation', () => {
  it('a registered wake-brief provider gets selected on orb_wake when grounded', async () => {
    const registry = createProviderRegistry();
    registry.register(
      makeVoiceWakeBriefProvider({
        now: frozenNow(),
        newId: frozenNewId('wb'),
      }),
    );

    const decision = await decideContinuation({
      surface: 'orb_wake',
      context: {
        sessionId: 's1',
        userId: 'u1',
        tenantId: 't1',
        extra: {
          [VOICE_WAKE_BRIEF_EXTRA_KEY]: {
            greetingPolicy: 'fresh_intro',
            lang: 'en',
            pillarMomentum: qualifyingPm('sleep'),
          } satisfies VoiceWakeBriefInputs,
        },
      },
      registry,
    });

    expect(decision.selectedContinuation).not.toBeNull();
    expect(decision.selectedContinuation?.kind).toBe('wake_brief');
    expect(decision.selectedContinuation?.userFacingLine).toMatch(/sleep pillar/);
    expect(decision.suppressionReason).toBeUndefined();
    // sourceProviderResults still carries the provider's row (B0d.3 dep).
    expect(decision.sourceProviderResults).toHaveLength(1);
    expect(decision.sourceProviderResults[0].status).toBe('returned');
    expect(decision.sourceProviderResults[0].providerKey).toBe(
      VOICE_WAKE_BRIEF_PROVIDER_KEY,
    );
  });

  it('a non-skip policy with no grounded line → decision suppresses (grounded-or-silent)', async () => {
    const registry = createProviderRegistry();
    registry.register(
      makeVoiceWakeBriefProvider({
        now: frozenNow(),
        newId: frozenNewId('wb'),
      }),
    );

    const decision = await decideContinuation({
      surface: 'orb_wake',
      context: {
        sessionId: 's1',
        extra: {
          [VOICE_WAKE_BRIEF_EXTRA_KEY]: {
            greetingPolicy: 'fresh_intro',
          } satisfies VoiceWakeBriefInputs,
        },
      },
      registry,
    });

    expect(decision.selectedContinuation).toBeNull();
    expect(decision.suppressionReason).toBe('all_providers_suppressed');
    expect(decision.sourceProviderResults[0].status).toBe('suppressed');
    expect(decision.sourceProviderResults[0].reason).toBe('no_grounded_line_grounded_or_silent');
  });

  it('a registered provider on skip greeting policy → decision is none_with_reason path', async () => {
    const registry = createProviderRegistry();
    registry.register(
      makeVoiceWakeBriefProvider({
        now: frozenNow(),
        newId: frozenNewId('wb'),
      }),
    );

    const decision = await decideContinuation({
      surface: 'orb_wake',
      context: {
        sessionId: 's1',
        extra: {
          [VOICE_WAKE_BRIEF_EXTRA_KEY]: {
            greetingPolicy: 'skip',
          } satisfies VoiceWakeBriefInputs,
        },
      },
      registry,
    });

    expect(decision.selectedContinuation).toBeNull();
    expect(decision.suppressionReason).toBe('all_providers_suppressed');
    // The provider's specific reason lives in sourceProviderResults.
    expect(decision.sourceProviderResults[0].status).toBe('suppressed');
    expect(decision.sourceProviderResults[0].reason).toBe('greeting_policy_skip');
  });

  it('the default renderer is grounded-or-silent: pillar line when grounded, else empty', () => {
    // Grounded → pillar line.
    const grounded = defaultVoiceWakeBriefRenderer.render(
      { greetingPolicy: 'fresh_intro', lang: 'en', pillarMomentum: qualifyingPm('sleep') },
      { surface: 'orb_wake' },
    );
    expect(grounded.length).toBeGreaterThan(0);
    expect(grounded).toMatch(/sleep pillar/);

    // No grounded input → empty string (no canned greeting any more).
    const policies: Array<'brief_resume' | 'warm_return' | 'fresh_intro'> = [
      'brief_resume',
      'warm_return',
      'fresh_intro',
    ];
    for (const policy of policies) {
      const line = defaultVoiceWakeBriefRenderer.render(
        { greetingPolicy: policy, lang: 'en' },
        { surface: 'orb_wake' },
      );
      expect(line).toBe('');
    }
  });
});
