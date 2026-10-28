/**
 * VTID-05026 — Audiobook voices: Google for ru/sr, Polly for the other nine.
 *
 * Pins (plan-sparring.md, Version 2, "Phase 1 — scope" item 10):
 *   - provider selection: ru/sr → Google only when THEIR OWN switch is on and
 *     the daily cap is set; the other nine → Polly; Google is never chosen
 *     for any other language;
 *   - the Google request shape (explicit voice, MP3, model_name only where the
 *     family takes one) and the client's auth: always the task-role client;
 *   - the 4,500-byte splitter on a long Russian script;
 *   - in-flight dedupe, provider-separated cache keys, 422 (null) on a Google
 *     failure and at the daily cap — never another voice;
 *   - Polly: existing callers byte-identical; the override reaches Polly.
 */

const mockSynthesizeSpeech = jest.fn();
const mockTtsCtor = jest.fn();
jest.mock('@google-cloud/text-to-speech', () => ({
  __esModule: true,
  default: {
    TextToSpeechClient: jest.fn().mockImplementation((opts: unknown) => {
      mockTtsCtor(opts);
      return { synthesizeSpeech: mockSynthesizeSpeech, listVoices: jest.fn() };
    }),
  },
}));
const mockAwsClient = { kind: 'task-role-aws-client' };
const mockGetGoogleAwsClient = jest.fn(() => mockAwsClient);
jest.mock('../src/lib/google-access-token', () => ({
  getGoogleAwsClient: () => mockGetGoogleAwsClient(),
}));
const mockPollySend = jest.fn();
jest.mock('@aws-sdk/client-polly', () => ({
  PollyClient: jest.fn().mockImplementation(() => ({ send: mockPollySend })),
  SynthesizeSpeechCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
}));

import {
  splitTextByBytes,
  synthesizeGoogleNarrationMp3,
  buildGoogleSynthesizeRequest,
  synthesizeGoogleChunk,
  __resetGoogleNarrationClientForTests,
  GOOGLE_TTS_CHUNK_BYTES,
} from '../src/services/tts/google-narration';
import {
  resolveAudiobookVoice,
  AUDIOBOOK_GOOGLE_VOICES,
} from '../src/services/guided-journey/audiobook-voices';
import {
  reserveAudiobookGoogleChars,
  readAudiobookGoogleDailyCap,
  __resetAudiobookGoogleBudgetForTests,
} from '../src/services/guided-journey/audiobook-google-budget';
import { isAudiobookGoogleRuLanguage, isAudiobookGoogleRuEnabled } from '../src/services/guided-journey/audiobook-google-ru';
import { isAudiobookGoogleSrLanguage, isAudiobookGoogleSrEnabled } from '../src/services/guided-journey/audiobook-google-sr';
import {
  synthesizeAudiobookTopicMp3,
  __inFlightAudiobookRendersForTests,
} from '../src/services/guided-journey/audiobook-episode-audio';
import { MemoryNarrationStore } from '../src/services/tts/narration-audio-cache';
import { synthesizePolly, resetPollyClientForTests } from '../src/services/tts/polly';
import * as fs from 'fs';
import * as path from 'path';

const ALL = ['de', 'en', 'es', 'fr', 'pt', 'pl', 'ru', 'sr', 'ar', 'zh', 'tr'];
const ON = {
  AUDIOBOOK_GOOGLE_RU_ENABLED: 'true',
  AUDIOBOOK_GOOGLE_SR_ENABLED: 'true',
  AUDIOBOOK_GOOGLE_DAILY_CHAR_CAP_PER_TASK: '1040000',
} as unknown as NodeJS.ProcessEnv;
const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;

const content = (script: string, topic = 'T001') =>
  ({
    topic_id: topic,
    topic_title: 't',
    voice_script: script,
    explanation: { whatItIs: null, userBenefit: null, whenToUse: null, tryThis: null },
    practice_target: null,
    source: 'published',
    narrationAudio: null,
  }) as any;

const pollyOk = jest.fn(async () => ({
  audioB64: Buffer.from('POLLY').toString('base64'),
  sampleRateHz: 24000,
  voice: 'x',
  engine: 'x',
  languageCode: 'x',
}));

beforeEach(() => {
  __resetAudiobookGoogleBudgetForTests();
  pollyOk.mockClear();
  mockSynthesizeSpeech.mockReset();
  mockPollySend.mockReset();
});

describe('provider selection', () => {
  it('everything off: nine Polly languages, ru on Polly Tatyana, sr has no voice', () => {
    for (const lang of ALL) {
      const v = resolveAudiobookVoice(lang, env({}));
      if (lang === 'sr') expect(v).toBeNull();
      else expect(v?.provider).toBe('polly');
    }
    expect(resolveAudiobookVoice('ru', env({}))).toMatchObject({ voiceId: 'Tatyana', engine: 'standard' });
  });

  it('the owner\'s Polly picks', () => {
    const picks = Object.fromEntries(
      ['en', 'de', 'fr', 'es', 'pt', 'pl', 'ar', 'zh', 'tr'].map((l) => {
        const v = resolveAudiobookVoice(l, ON) as any;
        return [l, `${v.voiceId}/${v.engine}/${v.languageCode}`];
      }),
    );
    expect(picks).toEqual({
      en: 'Tiffany/generative/en-US',
      de: 'Vicki/generative/de-DE',
      fr: 'Ambre/generative/fr-FR',
      es: 'Lucia/generative/es-ES',
      pt: 'Camila/generative/pt-BR',
      pl: 'Ola/generative/pl-PL',
      ar: 'Hala/neural/ar-AE',
      zh: 'Zhiyu/neural/cmn-CN',
      tr: 'Burcu/neural/tr-TR',
    });
  });

  it('all on: Google for ru and sr only — never any other language', () => {
    for (const lang of ALL) {
      const v = resolveAudiobookVoice(lang, ON);
      expect({ lang, p: v?.provider }).toEqual({ lang, p: lang === 'ru' || lang === 'sr' ? 'google' : 'polly' });
    }
    expect(resolveAudiobookVoice('ru-RU', ON)).toMatchObject({ provider: 'google', name: 'ru-RU-Chirp3-HD-Aoede' });
    expect(resolveAudiobookVoice('sr_Latn_RS', ON)).toMatchObject({ provider: 'google', name: 'sr-RS-Chirp3-HD-Aoede' });
    for (const near of ['hr', 'bs', 'uk', 'be', 'bg', 'mk', 'xx']) {
      expect(resolveAudiobookVoice(near, ON)?.provider).not.toBe('google');
    }
  });

  it('each switch is independent of the other', () => {
    const ruOnly = env({ AUDIOBOOK_GOOGLE_RU_ENABLED: 'true', AUDIOBOOK_GOOGLE_DAILY_CHAR_CAP_PER_TASK: '10' });
    expect(resolveAudiobookVoice('ru', ruOnly)?.provider).toBe('google');
    expect(resolveAudiobookVoice('sr', ruOnly)).toBeNull();
    const srOnly = env({ AUDIOBOOK_GOOGLE_SR_ENABLED: 'true', AUDIOBOOK_GOOGLE_DAILY_CHAR_CAP_PER_TASK: '10' });
    expect(resolveAudiobookVoice('sr', srOnly)?.provider).toBe('google');
    expect(resolveAudiobookVoice('ru', srOnly)?.provider).toBe('polly');
  });

  it('a switch must be exactly "true"', () => {
    for (const v of ['TRUE', '1', 'yes', 'on', 'staging-only', '']) {
      expect(isAudiobookGoogleRuEnabled(env({ AUDIOBOOK_GOOGLE_RU_ENABLED: v }))).toBe(false);
      expect(isAudiobookGoogleSrEnabled(env({ AUDIOBOOK_GOOGLE_SR_ENABLED: v }))).toBe(false);
    }
    expect(isAudiobookGoogleRuEnabled(env({ AUDIOBOOK_GOOGLE_RU_ENABLED: ' true ' }))).toBe(true);
  });

  it('each predicate matches one language', () => {
    expect(['ru', 'ru-RU', 'RU'].every(isAudiobookGoogleRuLanguage)).toBe(true);
    expect(['sr', 'sr-RS', 'sr_Latn_RS'].every(isAudiobookGoogleSrLanguage)).toBe(true);
    for (const l of ALL.filter((x) => x !== 'ru')) expect(isAudiobookGoogleRuLanguage(l)).toBe(false);
    for (const l of ALL.filter((x) => x !== 'sr')) expect(isAudiobookGoogleSrLanguage(l)).toBe(false);
  });

  it('no cap (unset, 0, junk) means Google is off: ru on Polly, sr no voice', () => {
    for (const cap of [undefined, '0', '-5', 'lots', '1e6']) {
      const e = env({ AUDIOBOOK_GOOGLE_RU_ENABLED: 'true', AUDIOBOOK_GOOGLE_SR_ENABLED: 'true', ...(cap === undefined ? {} : { AUDIOBOOK_GOOGLE_DAILY_CHAR_CAP_PER_TASK: cap }) });
      expect(readAudiobookGoogleDailyCap(e)).toBe(0);
      expect(resolveAudiobookVoice('ru', e)?.provider).toBe('polly');
      expect(resolveAudiobookVoice('sr', e)).toBeNull();
    }
  });

  it('both Google voices are pinned, Chirp 3 HD, no model_name', () => {
    expect(AUDIOBOOK_GOOGLE_VOICES).toEqual({
      ru: { name: 'ru-RU-Chirp3-HD-Aoede', languageCode: 'ru-RU', modelName: null },
      sr: { name: 'sr-RS-Chirp3-HD-Aoede', languageCode: 'sr-RS', modelName: null },
    });
  });
});

describe('byte splitter', () => {
  const longRussian = Array.from(
    { length: 120 },
    (_, i) => `Это предложение номер ${i}, и оно объясняет, как работает здоровый сон и почему он важен.`,
  ).join(' ');

  it('a long Russian script: every chunk ≤ 4,500 bytes, nothing lost, sentence boundaries kept', () => {
    expect(Buffer.byteLength(longRussian)).toBeGreaterThan(3 * GOOGLE_TTS_CHUNK_BYTES);
    const chunks = splitTextByBytes(longRussian);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(Buffer.byteLength(c, 'utf8')).toBeLessThanOrEqual(GOOGLE_TTS_CHUNK_BYTES);
      expect(c.endsWith('.')).toBe(true);
    }
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(longRussian.replace(/\s+/g, ' '));
  });

  it('the Polly character budget would overflow Google on the same text', () => {
    // 2,800 Cyrillic characters is ~5,600 bytes — over Google's 5,000.
    expect(Buffer.byteLength('я'.repeat(2800))).toBeGreaterThan(5000);
  });

  it('a single sentence over the budget is cut at words, then characters', () => {
    const run = 'слово '.repeat(1500).trim();
    for (const c of splitTextByBytes(run)) expect(Buffer.byteLength(c)).toBeLessThanOrEqual(GOOGLE_TTS_CHUNK_BYTES);
    const noSpaces = 'я'.repeat(6000);
    const parts = splitTextByBytes(noSpaces);
    expect(parts.join('')).toBe(noSpaces);
    for (const c of parts) expect(Buffer.byteLength(c)).toBeLessThanOrEqual(GOOGLE_TTS_CHUNK_BYTES);
  });

  it('short and empty text', () => {
    expect(splitTextByBytes('Здраво.')).toEqual(['Здраво.']);
    expect(splitTextByBytes('   ')).toEqual([]);
  });
});

describe('Google request and auth', () => {
  it('request shape: explicit voice, MP3; model_name only when the voice takes one', () => {
    expect(buildGoogleSynthesizeRequest('Привет.', AUDIOBOOK_GOOGLE_VOICES.ru!)).toEqual({
      input: { text: 'Привет.' },
      voice: { languageCode: 'ru-RU', name: 'ru-RU-Chirp3-HD-Aoede' },
      audioConfig: { audioEncoding: 'MP3' },
    });
    expect(
      buildGoogleSynthesizeRequest('x', { name: 'Kore', languageCode: 'sr-RS', modelName: 'gemini-2.5-flash-tts' }).voice,
    ).toEqual({ languageCode: 'sr-RS', name: 'Kore', modelName: 'gemini-2.5-flash-tts' });
  });

  it('the client always runs on the task-role auth client, whatever GOOGLE_AUTH_AWS_SUPPLIER_ENABLED says', async () => {
    for (const flag of [undefined, 'false', 'true']) {
      if (flag === undefined) delete process.env.GOOGLE_AUTH_AWS_SUPPLIER_ENABLED;
      else process.env.GOOGLE_AUTH_AWS_SUPPLIER_ENABLED = flag;
      __resetGoogleNarrationClientForTests();
      mockTtsCtor.mockClear();
      mockGetGoogleAwsClient.mockClear();
      mockSynthesizeSpeech.mockResolvedValueOnce([{ audioContent: Buffer.from('MP3') }]);
      expect(await synthesizeGoogleChunk(buildGoogleSynthesizeRequest('x', AUDIOBOOK_GOOGLE_VOICES.sr!))).toEqual(Buffer.from('MP3'));
      expect(mockGetGoogleAwsClient).toHaveBeenCalledTimes(1);
      const auth = (mockTtsCtor.mock.calls[0][0] as any).auth;
      expect(auth.cachedCredential).toBe(mockAwsClient);
    }
    delete process.env.GOOGLE_AUTH_AWS_SUPPLIER_ENABLED;
  });

  it('the module never calls the ADC lookup itself', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/services/tts/google-narration.ts'), 'utf8');
    expect(src).not.toMatch(/new\s+(textToSpeech\.)?TextToSpeechClient\(\s*\)/);
    expect(src).not.toMatch(/getApplicationDefault|GOOGLE_APPLICATION_CREDENTIALS/);
  });

  it('a thrown or empty response is null', async () => {
    mockSynthesizeSpeech.mockRejectedValueOnce(new Error('PERMISSION_DENIED'));
    expect(await synthesizeGoogleChunk(buildGoogleSynthesizeRequest('x', AUDIOBOOK_GOOGLE_VOICES.ru!))).toBeNull();
    mockSynthesizeSpeech.mockResolvedValueOnce([{}]);
    expect(await synthesizeGoogleChunk(buildGoogleSynthesizeRequest('x', AUDIOBOOK_GOOGLE_VOICES.ru!))).toBeNull();
  });

  it('chunks render two at a time and join in text order', async () => {
    let active = 0;
    let peak = 0;
    const seen: string[] = [];
    const text = Array.from({ length: 6 }, (_, i) => `${i}${'ж'.repeat(1400)}.`).join(' ');
    const out = await synthesizeGoogleNarrationMp3(text, AUDIOBOOK_GOOGLE_VOICES.ru!, {
      synthesize: async (req) => {
        active++;
        peak = Math.max(peak, active);
        const id = req.input.text.slice(0, 1);
        seen.push(id);
        await new Promise((r) => setTimeout(r, id === '0' ? 30 : 5));
        active--;
        return Buffer.from(`[${id}]`);
      },
    });
    expect(peak).toBe(2);
    expect(out?.mp3.toString()).toBe('[0][1][2][3][4][5]');
  });

  it('one failed chunk fails the whole render', async () => {
    let n = 0;
    const text = Array.from({ length: 4 }, (_, i) => `${i}${'ж'.repeat(1400)}.`).join(' ');
    const out = await synthesizeGoogleNarrationMp3(text, AUDIOBOOK_GOOGLE_VOICES.ru!, {
      synthesize: async () => (++n === 2 ? null : Buffer.from('x')),
    });
    expect(out).toBeNull();
  });
});

describe('daily cap (per task, approximate)', () => {
  const e = env({ AUDIOBOOK_GOOGLE_DAILY_CHAR_CAP_PER_TASK: '100' });
  const day1 = new Date('2026-10-10T10:00:00Z');

  it('reserves until the cap, then refuses and logs once', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(reserveAudiobookGoogleChars(60, { env: e, now: day1 })).toBe(true);
    expect(reserveAudiobookGoogleChars(40, { env: e, now: day1 })).toBe(true);
    expect(reserveAudiobookGoogleChars(1, { env: e, now: day1 })).toBe(false);
    expect(reserveAudiobookGoogleChars(1, { env: e, now: day1 })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('resets at 00:00 UTC', () => {
    expect(reserveAudiobookGoogleChars(100, { env: e, now: new Date('2026-10-10T23:59:59Z') })).toBe(true);
    expect(reserveAudiobookGoogleChars(1, { env: e, now: new Date('2026-10-10T23:59:59Z') })).toBe(false);
    expect(reserveAudiobookGoogleChars(100, { env: e, now: new Date('2026-10-11T00:00:00Z') })).toBe(true);
  });

  it('no cap set → nothing may be reserved', () => {
    expect(reserveAudiobookGoogleChars(1, { env: env({}), now: day1 })).toBe(false);
  });
});

describe('the renderer', () => {
  const okGoogle = jest.fn(async () => Buffer.from('GOOGLE'));
  beforeEach(() => okGoogle.mockClear());

  it('ru with its switch on: Google, logged per render with chars/voice/topic/lang', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const out = await synthesizeAudiobookTopicMp3(content('Привет, это урок.'), 'ru', {
      synthesizeGoogle: okGoogle, synthesize: pollyOk as any, store: null, env: ON,
    });
    expect(out).toMatchObject({ provider: 'google', cached: false });
    expect(out?.mp3.toString()).toBe('GOOGLE');
    expect(pollyOk).not.toHaveBeenCalled();
    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('{'));
    expect(JSON.parse(line!)).toEqual({
      event: 'audiobook_google_tts', vtid: 'VTID-05026', ok: true,
      chars: 'Привет, это урок.'.length, voice: 'ru-RU-Chirp3-HD-Aoede', topic: 'T001', lang: 'ru',
    });
    log.mockRestore();
  });

  it('ru with its switch off: Polly Tatyana', async () => {
    const out = await synthesizeAudiobookTopicMp3(content('Привет.'), 'ru', {
      synthesizeGoogle: okGoogle, synthesize: pollyOk as any, store: null, env: env({}),
    });
    expect(out?.provider).toBe('polly');
    expect(okGoogle).not.toHaveBeenCalled();
    expect((pollyOk.mock.calls[0] as any)[0].voiceOverride).toEqual({ voiceId: 'Tatyana', engine: 'standard', languageCode: 'ru-RU' });
  });

  it('a Google failure is null (422) for both ru and sr — never Polly, never another voice', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    for (const lang of ['ru', 'sr']) {
      const store = new MemoryNarrationStore();
      const put = jest.spyOn(store, 'put');
      const out = await synthesizeAudiobookTopicMp3(content('Текст.'), lang, {
        synthesizeGoogle: async () => null, synthesize: pollyOk as any, store, env: ON,
      });
      expect(out).toBeNull();
      expect(put).not.toHaveBeenCalled();
    }
    expect(pollyOk).not.toHaveBeenCalled();
    (console.log as jest.Mock).mockRestore();
  });

  it('at the cap: null for ru and sr, no Google call, no Polly', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const tiny = env({ ...(ON as any), AUDIOBOOK_GOOGLE_DAILY_CHAR_CAP_PER_TASK: '5' });
    for (const lang of ['ru', 'sr']) {
      expect(
        await synthesizeAudiobookTopicMp3(content('Длинный текст урока.'), lang, {
          synthesizeGoogle: okGoogle, synthesize: pollyOk as any, store: null, env: tiny,
        }),
      ).toBeNull();
    }
    expect(okGoogle).not.toHaveBeenCalled();
    expect(pollyOk).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('concurrent plays of the same episode share one render', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = jest.fn(async () => {
      await gate;
      return Buffer.from('ONE');
    });
    const store = new MemoryNarrationStore();
    const deps = { synthesizeGoogle: slow, store, env: ON };
    const a = synthesizeAudiobookTopicMp3(content('Здраво.'), 'sr', deps);
    const b = synthesizeAudiobookTopicMp3(content('Здраво.'), 'sr', deps);
    await new Promise((r) => setImmediate(r));
    expect(__inFlightAudiobookRendersForTests()).toBe(1);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(slow).toHaveBeenCalledTimes(1);
    expect(ra?.mp3.toString()).toBe('ONE');
    expect(rb?.mp3.toString()).toBe('ONE');
    expect(__inFlightAudiobookRendersForTests()).toBe(0);
    (console.log as jest.Mock).mockRestore();
  });

  it('cache keys separate providers: a Polly render is never served as the Google one', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const store = new MemoryNarrationStore();
    const polly = await synthesizeAudiobookTopicMp3(content('Привет.'), 'ru', { synthesize: pollyOk as any, store, env: env({}) });
    expect(polly?.mp3.toString()).toBe('POLLY');
    const google = await synthesizeAudiobookTopicMp3(content('Привет.'), 'ru', { synthesizeGoogle: okGoogle, store, env: ON });
    expect(google).toMatchObject({ provider: 'google', cached: false });
    expect(google?.mp3.toString()).toBe('GOOGLE');
    const again = await synthesizeAudiobookTopicMp3(content('Привет.'), 'ru', { synthesizeGoogle: okGoogle, store, env: ON });
    expect(again).toMatchObject({ provider: 'google', cached: true });
    (console.log as jest.Mock).mockRestore();
  });
});

describe('Polly voiceOverride', () => {
  beforeEach(() => {
    resetPollyClientForTests();
    mockPollySend.mockResolvedValue({
      AudioStream: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
    });
  });

  it('existing callers: the request is unchanged (receptionist voice, neural)', async () => {
    await synthesizePolly({ text: 'Hallo.', lang: 'de', format: 'mp3' });
    expect(mockPollySend.mock.calls[0][0].input).toEqual({
      Text: 'Hallo.', TextType: 'text', VoiceId: 'Vicki', Engine: 'neural', LanguageCode: 'de-DE', OutputFormat: 'mp3', SampleRate: '24000',
    });
    await synthesizePolly({ text: 'Hi.', lang: 'en', format: 'pcm', speakingRate: 1.2 });
    expect(mockPollySend.mock.calls[1][0].input).toEqual({
      Text: '<speak><prosody rate="120%">Hi.</prosody></speak>', TextType: 'ssml', VoiceId: 'Joanna', Engine: 'neural', LanguageCode: 'en-US', OutputFormat: 'pcm', SampleRate: '16000',
    });
  });

  it('the override reaches Polly; generative at rate 1.0 is plain text', async () => {
    const out = await synthesizePolly({
      text: 'Hello.', lang: 'en', format: 'mp3',
      voiceOverride: { voiceId: 'Tiffany' as any, engine: 'generative' as any, languageCode: 'en-US' },
    });
    expect(mockPollySend.mock.calls[0][0].input).toMatchObject({ Text: 'Hello.', TextType: 'text', VoiceId: 'Tiffany', Engine: 'generative', LanguageCode: 'en-US' });
    expect(out).toMatchObject({ voice: 'Tiffany', engine: 'generative' });
  });

  it('an invalid voice/engine pair is null — the caller answers 422, no other voice is tried', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockPollySend.mockReset();
    mockPollySend.mockRejectedValue(new Error('ValidationException: engine not supported'));
    const out = await synthesizePolly({
      text: 'Hola.', lang: 'es', format: 'mp3',
      voiceOverride: { voiceId: 'Lucia' as any, engine: 'longform' as any, languageCode: 'es-ES' },
    });
    expect(out).toBeNull();
    expect(mockPollySend).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('staging wiring', () => {
  const wf = fs.readFileSync(path.join(__dirname, '../../../.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml'), 'utf8');
  it('both switches and the cap are on in staging', () => {
    expect(wf).toMatch(/name:"AUDIOBOOK_GOOGLE_RU_ENABLED", value:"true"/);
    expect(wf).toMatch(/name:"AUDIOBOOK_GOOGLE_SR_ENABLED", value:"true"/);
    expect(wf).toMatch(/name:"AUDIOBOOK_GOOGLE_DAILY_CHAR_CAP_PER_TASK", value:"\d+"/);
  });
  it('production does not set them (they arrive through env_overrides at PUBLISH)', () => {
    const prod = fs.readFileSync(path.join(__dirname, '../../../.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml'), 'utf8');
    expect(prod).not.toMatch(/AUDIOBOOK_GOOGLE_(RU|SR)_ENABLED", value:"true"/);
  });
});
