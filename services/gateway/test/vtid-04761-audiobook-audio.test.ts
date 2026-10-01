/**
 * VTID-04761 — Audiobook listening mode: per-topic MP3 narration.
 *
 * Pins:
 *   - the narration is the authored script, rendered by Polly as MP3 in the
 *     Vitana (receptionist) voice, chunks joined end to end;
 *   - a partial render is never returned and never cached;
 *   - a language Polly cannot voice (sr) yields null, not wrong-language audio;
 *   - cache hits skip synthesis, and the MP3 key never collides with PCM;
 *   - the HTTP route: auth, topic validation, 404 for an unpublished topic,
 *     422 when narration is unavailable, audio/mpeg with a private cache
 *     (route: vtid-04761-audiobook-audio-route.test.ts).
 */
import { synthesizeAudiobookTopicMp3 } from '../src/services/guided-journey/audiobook-episode-audio';
import { MemoryNarrationStore } from '../src/services/tts/narration-audio-cache';

const content = (script: string) => ({
  topic_id: 'T001',
  topic_title: 'What Is Vitanaland',
  voice_script: script,
  explanation: { whatItIs: null, userBenefit: null, whenToUse: null, tryThis: null },
  practice_target: null,
  source: 'published',
  narrationAudio: null,
}) as any;

function fakeSynth(failOnCall?: number) {
  const calls: Array<{ text: string; lang: string; format: string }> = [];
  const fn = jest.fn(async (opts: { text: string; lang: string; format: 'mp3' | 'pcm' }) => {
    calls.push(opts);
    if (failOnCall !== undefined && calls.length === failOnCall) return null;
    return {
      audioB64: Buffer.from(`MP3[${calls.length}]`).toString('base64'),
      sampleRateHz: 24000,
      voice: 'Vicki',
      engine: 'neural',
      languageCode: 'de-DE',
    };
  });
  return { fn, calls };
}

describe('synthesizeAudiobookTopicMp3', () => {
  it('renders the authored script as MP3', async () => {
    const { fn, calls } = fakeSynth();
    const out = await synthesizeAudiobookTopicMp3(content('Hallo und willkommen.'), 'de', { synthesize: fn as any, store: null });
    expect(out?.mp3.toString()).toBe('MP3[1]');
    expect(out?.cached).toBe(false);
    expect(calls).toEqual([{ text: 'Hallo und willkommen.', lang: 'de', format: 'mp3' }]);
  });

  it('joins a long script chunk by chunk into one file', async () => {
    const { fn, calls } = fakeSynth();
    const long = Array.from({ length: 80 }, (_, i) => `Satz Nummer ${i} ist hier und erklärt etwas.`).join(' ');
    const out = await synthesizeAudiobookTopicMp3(content(long), 'de', { synthesize: fn as any, store: null });
    expect(calls.length).toBeGreaterThan(1);
    expect(out?.mp3.toString()).toBe(calls.map((_, i) => `MP3[${i + 1}]`).join(''));
  });

  it('returns null and caches nothing when any chunk fails', async () => {
    const { fn } = fakeSynth(2);
    const store = new MemoryNarrationStore();
    const put = jest.spyOn(store, 'put');
    const long = Array.from({ length: 80 }, (_, i) => `Satz Nummer ${i} ist hier und erklärt etwas.`).join(' ');
    const out = await synthesizeAudiobookTopicMp3(content(long), 'de', { synthesize: fn as any, store });
    expect(out).toBeNull();
    expect(put).not.toHaveBeenCalled();
  });

  it('returns null for a language Polly has no voice for (sr)', async () => {
    const { fn } = fakeSynth();
    expect(await synthesizeAudiobookTopicMp3(content('Zdravo.'), 'sr', { synthesize: fn as any, store: null })).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it('returns null for an empty topic', async () => {
    const { fn } = fakeSynth();
    expect(await synthesizeAudiobookTopicMp3(content(''), 'de', { synthesize: fn as any, store: null })).toBeNull();
  });

  it('serves a repeat from the cache without synthesizing', async () => {
    const store = new MemoryNarrationStore();
    const first = fakeSynth();
    await synthesizeAudiobookTopicMp3(content('Hallo.'), 'de', { synthesize: first.fn as any, store });
    const second = fakeSynth();
    const out = await synthesizeAudiobookTopicMp3(content('Hallo.'), 'de', { synthesize: second.fn as any, store });
    expect(out?.cached).toBe(true);
    expect(out?.mp3.toString()).toBe('MP3[1]');
    expect(second.fn).not.toHaveBeenCalled();
  });
});

