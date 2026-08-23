/**
 * VTID-03650 — guided-topic lesson narration via Amazon Polly.
 *
 * Locks the product contract this module exists for: the authored curriculum
 * text is read via deterministic TTS instead of handed to a conversational
 * model (VTID-03647/03648 measured both Nova and Vertex independently
 * rejecting the identical payload). Covers spoken-text assembly (voice_script
 * preferred, explanation-field fallback), Polly-only routing (never falls
 * back to a second provider/model), long-text chunking + PCM concatenation,
 * and the "any chunk fails → whole narration fails, caller degrades
 * cleanly" contract.
 */

import {
  buildGuidedTopicSpokenText,
  splitTextForPolly,
  synthesizeGuidedTopicNarrationAudio,
} from '../../../src/services/tts/guided-topic-narration-audio';
import { resetNarrationAudioStoreForTests } from '../../../src/services/tts/narration-audio-cache';
import type { GuidedTopicNarrationContent } from '../../../src/services/assistant-continuation/providers/guided-topic-narration';

const mockSynthesizePolly = jest.fn();
jest.mock('../../../src/services/tts/polly', () => ({
  synthesizePolly: (...args: any[]) => mockSynthesizePolly(...args),
  // BOOTSTRAP-POLLY-NARRATION-CACHE: the synthesis path now resolves the voice
  // BEFORE synthesizing, because the cache key is derived from the voice id and
  // engine. `sr` returns null here to preserve this suite's existing
  // "Polly cannot serve the language" case, which previously relied on
  // synthesizePolly itself returning null.
  resolvePollyVoice: (lang: string) =>
    lang === 'sr'
      ? null
      : { voiceId: 'Vicki', engine: 'neural', languageCode: 'de-DE' },
}));

function makeContent(overrides: Partial<GuidedTopicNarrationContent> = {}): GuidedTopicNarrationContent {
  return {
    topic_id: 'T001',
    topic_title: 'Vitanaland',
    voice_script: 'Vitanaland ist deine Langlebigkeits-Community.',
    explanation: { whatItIs: null, userBenefit: null, whenToUse: null, tryThis: null },
    practice_target: 'community',
    source: 'published',
    ...overrides,
  };
}

beforeEach(() => {
  mockSynthesizePolly.mockReset();
  // BOOTSTRAP-POLLY-NARRATION-CACHE: the store is memoized per process and the
  // in-process cache deliberately outlives a single call, so without this reset
  // one test's successful render is served to the next test that happens to use
  // the same (text, lang, voice, engine) — which silently masked the
  // "any chunk fails ⇒ whole narration fails" assertion below.
  resetNarrationAudioStoreForTests();
});

describe('buildGuidedTopicSpokenText', () => {
  it('prefers the authored voice_script', () => {
    const content = makeContent({ voice_script: '  Read this exactly.  ' });
    expect(buildGuidedTopicSpokenText(content)).toBe('Read this exactly.');
  });

  it('falls back to the explanation fields when voice_script is empty', () => {
    const content = makeContent({
      voice_script: null,
      explanation: { whatItIs: 'A community.', userBenefit: 'You learn things.', whenToUse: null, tryThis: 'Look around.' },
    });
    expect(buildGuidedTopicSpokenText(content)).toBe('A community. You learn things. Look around.');
  });

  it('falls back to explanation when voice_script is whitespace-only', () => {
    const content = makeContent({ voice_script: '   ', explanation: { whatItIs: 'Fallback.', userBenefit: null, whenToUse: null, tryThis: null } });
    expect(buildGuidedTopicSpokenText(content)).toBe('Fallback.');
  });

  it('returns empty string when there is neither a script nor any explanation field', () => {
    const content = makeContent({ voice_script: null, explanation: { whatItIs: null, userBenefit: null, whenToUse: null, tryThis: null } });
    expect(buildGuidedTopicSpokenText(content)).toBe('');
  });
});

describe('splitTextForPolly', () => {
  it('returns a single chunk for short text', () => {
    expect(splitTextForPolly('Short sentence.', 2800)).toEqual(['Short sentence.']);
  });

  it('returns an empty array for empty text', () => {
    expect(splitTextForPolly('', 2800)).toEqual([]);
  });

  it('splits long text on sentence boundaries into chunks under the limit', () => {
    const sentence = 'This is one sentence that repeats. ';
    const text = sentence.repeat(200); // ~7200 chars
    const chunks = splitTextForPolly(text, 2800);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2800 + sentence.length); // sentence-boundary slack
    }
    // No content lost — every chunk concatenated back reconstructs the sentences.
    expect(chunks.join(' ').replace(/\s+/g, ' ').trim()).toBe(text.replace(/\s+/g, ' ').trim());
  });

  it('does not drop a single sentence longer than the whole chunk budget', () => {
    const longSentence = 'A'.repeat(5000) + '.';
    const chunks = splitTextForPolly(longSentence, 2800);
    expect(chunks.join('')).toContain('A'.repeat(5000));
  });
});

describe('synthesizeGuidedTopicNarrationAudio', () => {
  it('returns null when there is no text to speak', async () => {
    const content = makeContent({ voice_script: null, explanation: { whatItIs: null, userBenefit: null, whenToUse: null, tryThis: null } });
    expect(await synthesizeGuidedTopicNarrationAudio(content, 'de')).toBeNull();
    expect(mockSynthesizePolly).not.toHaveBeenCalled();
  });

  it('synthesizes short text in a single Polly call', async () => {
    mockSynthesizePolly.mockResolvedValue({
      audioB64: Buffer.from([1, 2, 3]).toString('base64'),
      sampleRateHz: 16000,
      voice: 'Vicki',
      engine: 'neural',
      languageCode: 'de-DE',
    });
    const content = makeContent();
    const result = await synthesizeGuidedTopicNarrationAudio(content, 'de');
    expect(mockSynthesizePolly).toHaveBeenCalledTimes(1);
    expect(mockSynthesizePolly).toHaveBeenCalledWith({
      text: 'Vitanaland ist deine Langlebigkeits-Community.',
      lang: 'de',
      format: 'pcm',
    });
    expect(result).toEqual({ audioB64: Buffer.from([1, 2, 3]).toString('base64'), sampleRateHz: 16000 });
  });

  it('calls Polly directly — never routes through the TTS_PROVIDER-gated seam', async () => {
    // Regression guard for the design decision in the module header: this
    // call site is Polly-only, unconditional on TTS_PROVIDER. Asserting the
    // mocked module is `polly.ts` (not `tts-provider.ts`) is the test.
    mockSynthesizePolly.mockResolvedValue({
      audioB64: 'YQ==',
      sampleRateHz: 16000,
      voice: 'Joanna',
      engine: 'neural',
      languageCode: 'en-US',
    });
    await synthesizeGuidedTopicNarrationAudio(makeContent(), 'en');
    expect(mockSynthesizePolly).toHaveBeenCalled();
  });

  it('chunks long text into multiple Polly calls and concatenates PCM in order', async () => {
    const sentence = 'This is one sentence that repeats. ';
    const longScript = sentence.repeat(200);
    const content = makeContent({ voice_script: longScript });

    mockSynthesizePolly.mockImplementation(async ({ text }: { text: string }) => ({
      audioB64: Buffer.from(`[${text.length}]`).toString('base64'),
      sampleRateHz: 16000,
      voice: 'Vicki',
      engine: 'neural',
      languageCode: 'de-DE',
    }));

    const result = await synthesizeGuidedTopicNarrationAudio(content, 'de');
    expect(mockSynthesizePolly.mock.calls.length).toBeGreaterThan(1);
    expect(result?.sampleRateHz).toBe(16000);

    const expectedConcat = Buffer.concat(
      mockSynthesizePolly.mock.calls.map((call: any[]) => Buffer.from(`[${call[0].text.length}]`)),
    );
    expect(Buffer.from(result!.audioB64, 'base64')).toEqual(expectedConcat);
  });

  it('fails the WHOLE narration when any one chunk fails — no partial lesson', async () => {
    const sentence = 'This is one sentence that repeats. ';
    const longScript = sentence.repeat(200);
    const content = makeContent({ voice_script: longScript });

    let call = 0;
    mockSynthesizePolly.mockImplementation(async () => {
      call += 1;
      if (call === 2) return null; // second chunk fails
      return { audioB64: 'YQ==', sampleRateHz: 16000, voice: 'Vicki', engine: 'neural', languageCode: 'de-DE' };
    });

    const result = await synthesizeGuidedTopicNarrationAudio(content, 'de');
    expect(result).toBeNull();
  });

  it('returns null when Polly cannot serve the language at all', async () => {
    mockSynthesizePolly.mockResolvedValue(null);
    const result = await synthesizeGuidedTopicNarrationAudio(makeContent(), 'sr');
    expect(result).toBeNull();
  });
});
