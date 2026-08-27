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
}));

// VTID-03650: the provider now dynamic-imports the Polly narration
// synthesizer. Default to null (Polly unavailable) so the tests below
// exercise the short-opener fallback (VTID-03665) by default; individual
// tests override this to cover the Polly-success path.
const mockSynthesizeGuidedTopicNarrationAudio = jest.fn();
jest.mock('../../../../src/services/tts/guided-topic-narration-audio', () => ({
  synthesizeGuidedTopicNarrationAudio: (...args: any[]) => mockSynthesizeGuidedTopicNarrationAudio(...args),
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
  mockSynthesizeGuidedTopicNarrationAudio.mockReset();
  mockSynthesizeGuidedTopicNarrationAudio.mockResolvedValue(null); // Polly unavailable by default
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

  it('VTID-03677: still LEADS turn-1 with a topic even when isReconnect is true', async () => {
    // Regression guard for the live production incident: after VTID-03675
    // fixed the widget to resend guided_topic_id on a client-side retry, the
    // retry request ALSO legitimately sets isReconnect (a client WS drop is
    // exactly what that flag exists to detect, for transport-continuity
    // reasons unrelated to whether this specific topic was ever taught) —
    // and the provider used to unconditionally suppress on it, silently
    // discarding the very retry VTID-03675 exists to make possible. A topic
    // reaching this provider at all means (per the widget's own contract)
    // it has not been delivered yet, reconnect or not.
    mockGetOrbTopicSeed.mockResolvedValue(SEED);
    const p = makeGuidedTopicNarrationProvider();
    const r = await p.produce(makeCtx({ isReconnect: true }));
    expect(r.status).toBe('returned');
    expect((r.candidate as any).priority).toBe(96);
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
    // VTID-03665: without pre-recorded Polly audio, turn-1 is the SHORT
    // opener line (names the topic, invites the teaching to begin) — NOT
    // the raw voice_script recited word-for-word. The raw script is the
    // exact payload VTID-03647/03648 measured Nova and Vertex both
    // independently rejecting; it now only ever lives in the system
    // instruction as paraphrase material, never as a literal spoken trigger.
    expect(c.userFacingLine).not.toContain('Vitanaland ist deine');
    expect(c.userFacingLine).toContain(SEED.displayLabel);
    // TEACH content bundled for the controller / livekit handler
    expect(c.guidedTopicNarration.topic_id).toBe('T001');
    expect(c.guidedTopicNarration.voice_script).toContain('Vitanaland');
    expect(c.guidedTopicNarration.practice_target).toBe('community');
    // VTID-03644: locale is now forwarded so the seed overlays
    // journey_checklist_translations instead of always narrating German.
    expect(mockGetOrbTopicSeed).toHaveBeenCalledWith(FAKE_SB, 'T001', 'v2', 'de');
  });

  it('VTID-03644: forwards a non-German lang as the seed locale', async () => {
    mockGetOrbTopicSeed.mockResolvedValue(SEED);
    const p = makeGuidedTopicNarrationProvider();
    await p.produce(makeCtx({ lang: 'pt' }));
    expect(mockGetOrbTopicSeed).toHaveBeenCalledWith(FAKE_SB, 'T001', 'v2', 'pt');
  });

  it('greets by name when firstName is provided', async () => {
    mockGetOrbTopicSeed.mockResolvedValue(SEED);
    const p = makeGuidedTopicNarrationProvider();
    const r = await p.produce(makeCtx({ firstName: 'Dragan' }));
    expect((r.candidate as any).userFacingLine).toContain('Dragan');
  });

  describe('VTID-03650: Polly narration bridge', () => {
    it('tries Polly with the resolved content and locale before deciding the turn-1 line', async () => {
      mockGetOrbTopicSeed.mockResolvedValue(SEED);
      mockSynthesizeGuidedTopicNarrationAudio.mockResolvedValue({ audioB64: 'YQ==', sampleRateHz: 16000 });
      const p = makeGuidedTopicNarrationProvider();
      await p.produce(makeCtx());
      expect(mockSynthesizeGuidedTopicNarrationAudio).toHaveBeenCalledWith(
        expect.objectContaining({ topic_id: 'T001', voice_script: SEED.vitanaVoiceScript }),
        'de',
      );
    });

    it('when Polly succeeds: turn-1 line is the SHORT post-narration line, not the raw script', async () => {
      mockGetOrbTopicSeed.mockResolvedValue(SEED);
      mockSynthesizeGuidedTopicNarrationAudio.mockResolvedValue({ audioB64: 'YQ==', sampleRateHz: 16000 });
      const p = makeGuidedTopicNarrationProvider();
      const r = await p.produce(makeCtx());
      const c = r.candidate as any;
      expect(c.userFacingLine).not.toContain('Vitanaland ist deine');
      expect(c.userFacingLine).toContain(SEED.displayLabel);
      expect(c.userFacingLine.length).toBeLessThan(200);
    });

    it('when Polly succeeds: the audio is bundled on the candidate content for the controller to send', async () => {
      mockGetOrbTopicSeed.mockResolvedValue(SEED);
      mockSynthesizeGuidedTopicNarrationAudio.mockResolvedValue({ audioB64: 'YQ==', sampleRateHz: 16000 });
      const p = makeGuidedTopicNarrationProvider();
      const r = await p.produce(makeCtx());
      expect((r.candidate as any).guidedTopicNarration.narrationAudio).toEqual({ audioB64: 'YQ==', sampleRateHz: 16000 });
    });

    it('VTID-03665: when Polly fails, turn-1 is the SHORT opener line — NEVER the raw script verbatim', async () => {
      // Regression guard for the live production incident: a guided-topic
      // candidate won the ranker correctly but Polly never once succeeded,
      // so every session still spoke the raw voice_script as a literal
      // "say this word-for-word" trigger — the exact payload VTID-03647/
      // 03648 measured Nova and Vertex both rejecting. The user experienced
      // this as "tapping a session opens regular conversation instead."
      mockGetOrbTopicSeed.mockResolvedValue(SEED);
      mockSynthesizeGuidedTopicNarrationAudio.mockResolvedValue(null);
      const p = makeGuidedTopicNarrationProvider();
      const r = await p.produce(makeCtx());
      const c = r.candidate as any;
      expect(c.userFacingLine).not.toContain('Vitanaland ist deine');
      expect(c.userFacingLine).toContain(SEED.displayLabel);
      expect(c.userFacingLine.length).toBeLessThan(200);
      expect(c.guidedTopicNarration.narrationAudio).toBeNull();
      // The raw material still reaches the model — just as paraphrase
      // material in the system instruction, not as the literal spoken line.
      expect(c.guidedTopicNarration.voice_script).toContain('Vitanaland');
    });
  });

  describe('VTID-03774 (Codex review follow-up): isResume — a reconnect after audio was already delivered', () => {
    // The widget only ever sets isResume when it's resending topicId for a
    // topic whose turn-1 audio (opener + narration bridge) was already
    // delivered before this reconnect (orb-widget.js's
    // _guidedTopicAudioDelivered). Without this branch, that reconnect
    // re-synthesized and replayed the FULL narration from scratch and
    // re-injected the verbatim opener instruction — restarting/duplicating
    // already-heard content instead of resuming.

    it('still LEADS turn-1 (candidate still wins) on a resume — the topic context must not be lost', async () => {
      mockGetOrbTopicSeed.mockResolvedValue(SEED);
      const p = makeGuidedTopicNarrationProvider();
      const r = await p.produce(makeCtx({ isResume: true }));
      expect(r.status).toBe('returned');
      expect((r.candidate as any).priority).toBe(96);
    });

    it('does NOT call Polly synthesis on a resume — nothing new to play', async () => {
      mockGetOrbTopicSeed.mockResolvedValue(SEED);
      const p = makeGuidedTopicNarrationProvider();
      await p.produce(makeCtx({ isResume: true }));
      expect(mockSynthesizeGuidedTopicNarrationAudio).not.toHaveBeenCalled();
    });

    it('userFacingLine is empty on a resume — no forced re-opener, the model resumes naturally', async () => {
      mockGetOrbTopicSeed.mockResolvedValue(SEED);
      const p = makeGuidedTopicNarrationProvider();
      const r = await p.produce(makeCtx({ isResume: true }));
      expect((r.candidate as any).userFacingLine).toBe('');
    });

    it('an empty userFacingLine still passes the framework validator (a resume candidate is not a malformed one)', async () => {
      mockGetOrbTopicSeed.mockResolvedValue(SEED);
      const p = makeGuidedTopicNarrationProvider();
      const r = await p.produce(makeCtx({ isResume: true }));
      expect(validateContinuationCandidate(r.candidate as any).ok).toBe(true);
    });

    it('narrationAudio stays null on a resume (the audio bridge already treats null as nothing-to-send)', async () => {
      mockGetOrbTopicSeed.mockResolvedValue(SEED);
      const p = makeGuidedTopicNarrationProvider();
      const r = await p.produce(makeCtx({ isResume: true }));
      expect((r.candidate as any).guidedTopicNarration.narrationAudio).toBeNull();
    });

    it('the TEACH content (topic/explanation/practice_target) is STILL bundled on a resume — only the spoken line and audio are suppressed', async () => {
      mockGetOrbTopicSeed.mockResolvedValue(SEED);
      const p = makeGuidedTopicNarrationProvider();
      const r = await p.produce(makeCtx({ isResume: true }));
      const c = (r.candidate as any).guidedTopicNarration;
      expect(c.topic_id).toBe('T001');
      expect(c.voice_script).toContain('Vitanaland');
      expect(c.practice_target).toBe('community');
    });

    it('no regression: isResume=false (default/unset) behaves exactly as before — Polly is still attempted', async () => {
      mockGetOrbTopicSeed.mockResolvedValue(SEED);
      mockSynthesizeGuidedTopicNarrationAudio.mockResolvedValue({ audioB64: 'YQ==', sampleRateHz: 16000 });
      const p = makeGuidedTopicNarrationProvider();
      const r = await p.produce(makeCtx());
      expect(mockSynthesizeGuidedTopicNarrationAudio).toHaveBeenCalled();
      expect((r.candidate as any).userFacingLine.length).toBeGreaterThan(0);
    });
  });
});
