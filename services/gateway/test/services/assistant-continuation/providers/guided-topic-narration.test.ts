/**
 * VTID-03290 — guided-topic-narration provider tests.
 *
 * Locks the product contract: when a user taps a Guided Journey catalog topic,
 * the provider LEADS turn-1 (priority 96 > first_time_welcome 95) — the spoken
 * opener names the topic, the TEACH content is bundled, the cta is a valid
 * KNOWN_CTA_TYPES value. Skips when no topic was tapped, suppresses on reconnect
 * and when the topic isn't live, errors-not-throws when the seed read fails.
 */

import {
  makeGuidedTopicNarrationProvider,
  GUIDED_TOPIC_NARRATION_PROVIDER_KEY,
  GUIDED_TOPIC_NARRATION_EXTRA_KEY,
} from '../../../../src/services/assistant-continuation/providers/guided-topic-narration';
import { validateContinuationCandidate } from '../../../../src/services/assistant-continuation/types';

// The provider statically imports getOrbTopicSeed — mock the service module.
const mockGetOrbTopicSeed = jest.fn();
jest.mock('../../../../src/services/guided-journey/checklist-service', () => ({
  getOrbTopicSeed: (...args: any[]) => mockGetOrbTopicSeed(...args),
  // VTID-03309: the provider also normalizes the session language → voice locale.
  normalizeVoiceLocale: (lang: string | null | undefined) => {
    const l = (lang || '').toLowerCase();
    if (l.startsWith('en')) return 'en';
    if (l.startsWith('es')) return 'es';
    if (l.startsWith('sr')) return 'sr';
    return 'de';
  },
}));

const FAKE_SB = { from: () => ({}) } as any;

function makeCtx(extraOverride: any = {}) {
  return {
    surface: 'orb_wake',
    sessionId: 's1',
    userId: 'u1',
    tenantId: 't1',
    extra: {
      [GUIDED_TOPIC_NARRATION_EXTRA_KEY]: {
        supabase: FAKE_SB,
        userId: 'u1',
        isReconnect: false,
        lang: 'de',
        topicId: 'T001',
        ...extraOverride,
      },
    },
  } as any;
}

const SEED = {
  topicId: 'T001',
  displayLabel: 'Was ist Vitanaland',
  vitanaVoiceScript: 'Vitanaland ist deine Langlebigkeits-Community …',
  explanation: { whatItIs: 'Eine Community', userBenefit: 'Du lernst', whenToUse: 'Täglich', tryThis: 'Schau rein' },
  guidedPracticeTarget: 'community',
  source: 'published' as const,
};

beforeEach(() => {
  mockGetOrbTopicSeed.mockReset();
});

describe('guided-topic-narration provider', () => {
  it('skips when no inputs are present', async () => {
    const p = makeGuidedTopicNarrationProvider();
    const r = await p.produce({ surface: 'orb_wake', extra: {} } as any);
    expect(r.status).toBe('skipped');
    expect(r.providerKey).toBe(GUIDED_TOPIC_NARRATION_PROVIDER_KEY);
  });

  it('skips when no topic was tapped (normal open)', async () => {
    const p = makeGuidedTopicNarrationProvider();
    const r = await p.produce(makeCtx({ topicId: null }));
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('no_topic_tapped');
    expect(mockGetOrbTopicSeed).not.toHaveBeenCalled();
  });

  it('suppresses on transparent reconnect', async () => {
    const p = makeGuidedTopicNarrationProvider();
    const r = await p.produce(makeCtx({ isReconnect: true }));
    expect(r.status).toBe('suppressed');
    expect(r.reason).toBe('forced_skip_reconnect');
  });

  it('suppresses when the topic is not live (no seed)', async () => {
    mockGetOrbTopicSeed.mockResolvedValue(null);
    const p = makeGuidedTopicNarrationProvider();
    const r = await p.produce(makeCtx());
    expect(r.status).toBe('suppressed');
    expect(r.reason).toBe('topic_not_live');
  });

  it('errors (not throws) when the seed read fails', async () => {
    mockGetOrbTopicSeed.mockRejectedValue(new Error('db down'));
    const p = makeGuidedTopicNarrationProvider();
    const r = await p.produce(makeCtx());
    expect(r.status).toBe('errored');
    expect(r.reason).toContain('guided_topic_seed_failed');
  });

  it('LEADS turn-1 with a valid, bundled candidate when a topic was tapped', async () => {
    mockGetOrbTopicSeed.mockResolvedValue(SEED);
    const p = makeGuidedTopicNarrationProvider();
    const r = await p.produce(makeCtx());
    expect(r.status).toBe('returned');
    const c = r.candidate as any;
    // priority beats first_time_welcome (95)
    expect(c.priority).toBe(96);
    // cta MUST be a KNOWN_CTA_TYPES value (the journey-guide 'guide_step' bug)
    expect(c.cta.type).toBe('explain');
    // the whole candidate passes the framework validator (else it errors + never wins)
    expect(validateContinuationCandidate(c).ok).toBe(true);
    // VTID-03293: the spoken LINE is now the LESSON itself (the authored voice
    // script), so native-audio reliably speaks it; not a short opener + a long
    // "teach more" instruction (which stalled audio).
    expect(c.userFacingLine).toContain('Vitanaland ist deine');
    // TEACH content bundled for the controller / livekit handler
    expect(c.guidedTopicNarration.topic_id).toBe('T001');
    expect(c.guidedTopicNarration.voice_script).toContain('Vitanaland');
    expect(c.guidedTopicNarration.practice_target).toBe('community');
    // VTID-03309: the session language ('de') is normalized to a voice locale
    // and threaded into the seed read so the spoken script is single-language.
    expect(mockGetOrbTopicSeed).toHaveBeenCalledWith(FAKE_SB, 'T001', 'v2', 'de');
  });

  it('greets by name when firstName is provided', async () => {
    mockGetOrbTopicSeed.mockResolvedValue(SEED);
    const p = makeGuidedTopicNarrationProvider();
    const r = await p.produce(makeCtx({ firstName: 'Dragan' }));
    expect((r.candidate as any).userFacingLine).toContain('Dragan');
  });
});
