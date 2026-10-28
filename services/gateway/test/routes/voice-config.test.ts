/**
 * Tests for src/routes/voice-config.ts (VTID-02857)
 *
 *   GET  /api/v1/voice/config              — no auth
 *   PUT  /api/v1/voice/config              — requireAuthWithTenant + manual exafy_admin check
 *   GET  /api/v1/voice/tts-voices          — no auth
 *   POST /api/v1/voice/preview             — requireAuthWithTenant + manual exafy_admin check
 *   POST /api/v1/voice/config/cache/invalidate — requireAuthWithTenant + manual exafy_admin check
 *
 * Auth is NOT delegated to requireExafyAdmin middleware — each mutating
 * handler reads req.identity?.exafy_admin itself after requireAuthWithTenant
 * runs, so we mock requireAuthWithTenant and drive req.identity per-test.
 */
import request from 'supertest';
import express from 'express';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSynthesizeSpeech = jest.fn();
const mockListVoices = jest.fn();
jest.mock('@google-cloud/text-to-speech', () => ({
  __esModule: true,
  default: {
    TextToSpeechClient: jest.fn().mockImplementation(() => ({
      synthesizeSpeech: mockSynthesizeSpeech,
      listVoices: mockListVoices,
    })),
  },
  protos: {},
}));
// VTID-05026: the Google preview runs on the task-role auth client.
jest.mock('../../src/lib/google-access-token', () => ({
  getGoogleAwsClient: () => ({}),
}));

const mockGetVoiceConfig = jest.fn();
const mockPutVoiceConfig = jest.fn();
const mockInvalidateVoiceConfigCache = jest.fn();
jest.mock('../../src/services/voice-config', () => ({
  getVoiceConfig: (...args: unknown[]) => mockGetVoiceConfig(...args),
  putVoiceConfig: (...args: unknown[]) => mockPutVoiceConfig(...args),
  invalidateVoiceConfigCache: (...args: unknown[]) => mockInvalidateVoiceConfigCache(...args),
  IMPLEMENTED_TTS_PROVIDERS: new Set(['google_tts']),
  IMPLEMENTED_STT_PROVIDERS: new Set(['google_stt']),
}));

const mockEmitOasisEvent = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: unknown[]) => mockEmitOasisEvent(...args),
}));

// VTID-03970: mocked (unlike polly.ts, which this file has never mocked —
// its preview branch silently no-ops to null against real AWS creds absent
// here). Mocking Fish explicitly means the new preview tests below are
// real and deterministic rather than accidentally testing the fallthrough.
const mockSynthesizeFish = jest.fn();
const mockIsFishConfigured = jest.fn();
jest.mock('../../src/services/tts/fish', () => ({
  synthesizeFish: (...args: unknown[]) => mockSynthesizeFish(...args),
  isFishConfigured: (...args: unknown[]) => mockIsFishConfigured(...args),
}));

// null = unauthenticated. Otherwise treated as req.identity.
let mockIdentity: { user_id: string; exafy_admin: boolean } | null = null;
jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuthWithTenant: (req: any, res: any, next: any) => {
    if (!mockIdentity) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    req.identity = mockIdentity;
    next();
  },
}));

import router from '../../src/routes/voice-config';

const app = express();
app.use(express.json());
app.use('/api/v1', router);

const ADMIN_IDENTITY = { user_id: 'admin-1', exafy_admin: true };
const NON_ADMIN_IDENTITY = { user_id: 'user-1', exafy_admin: false };

const SAMPLE_CONFIG = {
  active_provider: 'vertex' as const,
  tts: { provider: 'google_tts', model: 'neural2', voice: null, language: null, speaking_rate: 1.0 },
  stt: { provider: 'google_stt', model: 'default' },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockIdentity = null;
  mockGetVoiceConfig.mockResolvedValue(SAMPLE_CONFIG);
});

// ---------------------------------------------------------------------------
// GET /api/v1/voice/config
// ---------------------------------------------------------------------------
describe('GET /api/v1/voice/config', () => {
  it('returns the config with supported languages + implemented providers (no auth required)', async () => {
    const res = await request(app).get('/api/v1/voice/config');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.active_provider).toBe('vertex');
    expect(res.body.tts).toEqual(SAMPLE_CONFIG.tts);
    expect(res.body.stt).toEqual(SAMPLE_CONFIG.stt);
    expect(res.body.supported_languages).toEqual(
      expect.arrayContaining([{ code: 'en', label: 'English (US)' }, { code: 'de', label: 'Deutsch (DE)' }]),
    );
    expect(res.body.implemented).toEqual({ tts_providers: ['google_tts'], stt_providers: ['google_stt'] });
    expect(res.body.vtid).toBe('VTID-02857');
    expect(mockGetVoiceConfig).toHaveBeenCalledWith(true);
  });

  it('returns 500 when the config lookup throws', async () => {
    mockGetVoiceConfig.mockRejectedValue(new Error('db unreachable'));
    const res = await request(app).get('/api/v1/voice/config');
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('db unreachable');
  });
});

// ---------------------------------------------------------------------------
// PUT /api/v1/voice/config
// ---------------------------------------------------------------------------
describe('PUT /api/v1/voice/config', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await request(app).put('/api/v1/voice/config').send({ tts: { model: 'wavenet' } });
    expect(res.status).toBe(401);
  });

  it('returns 403 when the caller is authenticated but not exafy_admin', async () => {
    mockIdentity = NON_ADMIN_IDENTITY;
    const res = await request(app).put('/api/v1/voice/config').send({ tts: { model: 'wavenet' } });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('exafy_admin role required to change voice config');
    expect(mockPutVoiceConfig).not.toHaveBeenCalled();
  });

  it('returns 400 when putVoiceConfig rejects the update', async () => {
    mockIdentity = ADMIN_IDENTITY;
    mockPutVoiceConfig.mockResolvedValue({ ok: false, error: "TTS provider 'x' has no dispatcher implementation" });
    const res = await request(app).put('/api/v1/voice/config').send({ tts: { provider: 'x' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("TTS provider 'x' has no dispatcher implementation");
  });

  it('applies the update, emits voice.config.updated when the diff is non-empty', async () => {
    mockIdentity = ADMIN_IDENTITY;
    const diff = { 'tts.model': { from: 'neural2', to: 'wavenet' } };
    mockPutVoiceConfig.mockResolvedValue({ ok: true, diff });

    const res = await request(app)
      .put('/api/v1/voice/config')
      .send({ tts: { model: 'wavenet' }, stt: { provider: 'google_stt' } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, diff, vtid: 'VTID-02857' });
    expect(mockPutVoiceConfig).toHaveBeenCalledWith(
      { tts: { model: 'wavenet' }, stt: { provider: 'google_stt' } },
      'admin-1',
    );
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'voice.config.updated',
        actor: 'admin-1',
        payload: { diff, vtid: 'VTID-02857' },
      }),
    );
  });

  it('does not emit an OASIS event when the diff is empty (no-op update)', async () => {
    mockIdentity = ADMIN_IDENTITY;
    mockPutVoiceConfig.mockResolvedValue({ ok: true, diff: {} });

    const res = await request(app).put('/api/v1/voice/config').send({ tts: {} });

    expect(res.status).toBe(200);
    expect(res.body.diff).toEqual({});
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });

  it('still returns 200 when the OASIS emit itself fails (telemetry never blocks the save)', async () => {
    mockIdentity = ADMIN_IDENTITY;
    mockPutVoiceConfig.mockResolvedValue({ ok: true, diff: { 'tts.model': { from: 'a', to: 'b' } } });
    mockEmitOasisEvent.mockRejectedValue(new Error('oasis down'));

    const res = await request(app).put('/api/v1/voice/config').send({ tts: { model: 'b' } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/voice/tts-voices
// ---------------------------------------------------------------------------
describe('GET /api/v1/voice/tts-voices', () => {
  it('defaults to google_tts / en and returns the built-in voice list (no auth required)', async () => {
    const res = await request(app).get('/api/v1/voice/tts-voices');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.provider).toBe('google_tts');
    expect(res.body.language).toBe('en');
    expect(res.body.voices).toHaveLength(5);
    expect(res.body.voices[0]).toEqual({ name: 'en-US-Neural2-H', languageCode: 'en-US', tier: 'neural2' });
  });

  it('returns the German voice set for language=de', async () => {
    const res = await request(app).get('/api/v1/voice/tts-voices?language=de');
    expect(res.status).toBe(200);
    expect(res.body.voices).toHaveLength(4);
    expect(res.body.voices[0].languageCode).toBe('de-DE');
  });

  it('returns an empty voice list for an unmapped language', async () => {
    const res = await request(app).get('/api/v1/voice/tts-voices?language=xx');
    expect(res.status).toBe(200);
    expect(res.body.voices).toEqual([]);
  });

  it('returns an empty list with a note for a non-google_tts provider', async () => {
    const res = await request(app).get('/api/v1/voice/tts-voices?provider=elevenlabs');
    expect(res.status).toBe(200);
    expect(res.body.voices).toEqual([]);
    expect(res.body.note).toMatch(/elevenlabs.*not implemented/);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/voice/preview
// ---------------------------------------------------------------------------
describe('POST /api/v1/voice/preview', () => {
  beforeEach(() => {
    mockSynthesizeSpeech.mockResolvedValue([{ audioContent: Buffer.from('fake-mp3-bytes') }]);
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request(app).post('/api/v1/voice/preview').send({ text: 'hello' });
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-admin caller', async () => {
    mockIdentity = NON_ADMIN_IDENTITY;
    const res = await request(app).post('/api/v1/voice/preview').send({ text: 'hello' });
    expect(res.status).toBe(403);
    expect(mockSynthesizeSpeech).not.toHaveBeenCalled();
  });

  it('returns 400 when text is missing/empty', async () => {
    mockIdentity = ADMIN_IDENTITY;
    const res = await request(app).post('/api/v1/voice/preview').send({ text: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('text required');
  });

  it('returns 400 for a provider other than google_tts', async () => {
    mockIdentity = ADMIN_IDENTITY;
    const res = await request(app).post('/api/v1/voice/preview').send({ text: 'hi', provider: 'elevenlabs' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/elevenlabs.*not implemented/);
  });

  // VTID-05026: `google_tts` is the Audiobook narration preview, ru and sr only.
  it('refuses google_tts (the default provider) for a language other than ru/sr', async () => {
    mockIdentity = ADMIN_IDENTITY;
    for (const language of [undefined, 'en', 'de', 'hr', 'bs']) {
      const res = await request(app).post('/api/v1/voice/preview').send({ text: 'Hello there', language });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/ru and sr/);
    }
    expect(mockSynthesizeSpeech).not.toHaveBeenCalled();
  });

  it('ru renders the pinned Audiobook voice, MP3, no model_name for Chirp 3 HD', async () => {
    mockIdentity = ADMIN_IDENTITY;
    const res = await request(app).post('/api/v1/voice/preview').send({ text: 'Привет', language: 'ru' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/audio\/mpeg/);
    expect(res.headers['x-vitana-tts-voice']).toBe('ru-RU-Chirp3-HD-Aoede');
    expect(res.headers['x-vitana-tts-render-ms']).toMatch(/^\d+$/);
    expect(Buffer.compare(res.body, Buffer.from('fake-mp3-bytes'))).toBe(0);
    expect(mockSynthesizeSpeech).toHaveBeenCalledWith({
      input: { text: 'Привет' },
      voice: { languageCode: 'ru-RU', name: 'ru-RU-Chirp3-HD-Aoede' },
      audioConfig: { audioEncoding: 'MP3' },
    });
  });

  it('sr auditions another sr-RS voice by name; a voice of another language is refused', async () => {
    mockIdentity = ADMIN_IDENTITY;
    const ok = await request(app)
      .post('/api/v1/voice/preview')
      .send({ text: 'Zdravo', language: 'sr', voice: 'sr-RS-Chirp3-HD-Leda' });
    expect(ok.status).toBe(200);
    expect(mockSynthesizeSpeech.mock.calls[0][0].voice).toEqual({ languageCode: 'sr-RS', name: 'sr-RS-Chirp3-HD-Leda' });
    const wrong = await request(app)
      .post('/api/v1/voice/preview')
      .send({ text: 'Zdravo', language: 'sr', voice: 'hr-HR-Standard-A' });
    expect(wrong.status).toBe(400);
  });

  it('answers 422 when Google returns no audio or throws', async () => {
    mockIdentity = ADMIN_IDENTITY;
    mockSynthesizeSpeech.mockResolvedValueOnce([{}]);
    const empty = await request(app).post('/api/v1/voice/preview').send({ text: 'hi', language: 'ru' });
    expect(empty.status).toBe(422);
    mockSynthesizeSpeech.mockRejectedValueOnce(new Error('quota exceeded'));
    const thrown = await request(app).post('/api/v1/voice/preview').send({ text: 'hi', language: 'sr' });
    expect(thrown.status).toBe(422);
    expect(thrown.body.error).toBe('google_tts synthesis failed');
  });

  // VTID-03970 — Fish Audio preview branch.
  describe('provider: fish', () => {
    it('returns 422 when Fish is not configured, without calling synthesizeFish', async () => {
      mockIdentity = ADMIN_IDENTITY;
      mockIsFishConfigured.mockReturnValue(false);
      const res = await request(app)
        .post('/api/v1/voice/preview')
        .send({ text: 'Zdravo', language: 'sr', provider: 'fish' });
      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/not configured/i);
      expect(mockSynthesizeFish).not.toHaveBeenCalled();
    });

    it('returns 422 when Fish has no curated voice for the language', async () => {
      mockIdentity = ADMIN_IDENTITY;
      mockIsFishConfigured.mockReturnValue(true);
      mockSynthesizeFish.mockResolvedValue(null);
      const res = await request(app)
        .post('/api/v1/voice/preview')
        .send({ text: 'Bonjour', language: 'fr', provider: 'fish' });
      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/no curated voice/i);
    });

    it('returns audio/mpeg bytes and the resolved voice header on success', async () => {
      mockIdentity = ADMIN_IDENTITY;
      mockIsFishConfigured.mockReturnValue(true);
      mockSynthesizeFish.mockResolvedValue({
        audioB64: Buffer.from('fake-fish-mp3-bytes').toString('base64'),
        sampleRateHz: 44100,
        voice: 'Milica (Fish Official)',
        languageCode: 'sr',
      });
      const res = await request(app)
        .post('/api/v1/voice/preview')
        .send({ text: 'Zdravo, ja sam Vitana.', language: 'sr', provider: 'fish' });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/audio\/mpeg/);
      expect(res.headers['x-vitana-tts-voice']).toBe('Milica (Fish Official)');
      expect(Buffer.compare(res.body, Buffer.from('fake-fish-mp3-bytes'))).toBe(0);
      expect(mockSynthesizeFish).toHaveBeenCalledWith({
        text: 'Zdravo, ja sam Vitana.',
        lang: 'sr',
        format: 'mp3',
      });
      // Deliberately does NOT call the Google TTS client on the fish path.
      expect(mockSynthesizeSpeech).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/voice/preview/google-voices — VTID-05026
// ---------------------------------------------------------------------------
describe('GET /api/v1/voice/preview/google-voices', () => {
  beforeEach(() => {
    mockListVoices.mockReset();
    mockListVoices.mockResolvedValue([
      {
        voices: [
          { name: 'ru-RU-Chirp3-HD-Aoede', languageCodes: ['ru-RU'], ssmlGender: 'FEMALE', naturalSampleRateHertz: 24000 },
          { name: 'ru-RU-Chirp3-HD-Charon', languageCodes: ['ru-RU'], ssmlGender: 'MALE', naturalSampleRateHertz: 24000 },
        ],
      },
    ]);
  });

  it('401 unauthenticated, 403 non-admin', async () => {
    expect((await request(app).get('/api/v1/voice/preview/google-voices?lang=ru')).status).toBe(401);
    mockIdentity = NON_ADMIN_IDENTITY;
    expect((await request(app).get('/api/v1/voice/preview/google-voices?lang=ru')).status).toBe(403);
    expect(mockListVoices).not.toHaveBeenCalled();
  });

  it('refuses every language but ru and sr', async () => {
    mockIdentity = ADMIN_IDENTITY;
    for (const lang of ['en', 'de', 'hr', '']) {
      expect((await request(app).get(`/api/v1/voice/preview/google-voices?lang=${lang}`)).status).toBe(400);
    }
    expect(mockListVoices).not.toHaveBeenCalled();
  });

  it('lists only the female voices, with the pinned one', async () => {
    mockIdentity = ADMIN_IDENTITY;
    const res = await request(app).get('/api/v1/voice/preview/google-voices?lang=ru');
    expect(res.status).toBe(200);
    expect(mockListVoices).toHaveBeenCalledWith({ languageCode: 'ru-RU' });
    expect(res.body.pinned).toBe('ru-RU-Chirp3-HD-Aoede');
    expect(res.body.voices).toEqual([
      { name: 'ru-RU-Chirp3-HD-Aoede', ssml_gender: 'FEMALE', natural_sample_rate_hertz: 24000 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/voice/config/cache/invalidate
// ---------------------------------------------------------------------------
describe('POST /api/v1/voice/config/cache/invalidate', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await request(app).post('/api/v1/voice/config/cache/invalidate');
    expect(res.status).toBe(401);
    expect(mockInvalidateVoiceConfigCache).not.toHaveBeenCalled();
  });

  it('returns 403 for a non-admin caller', async () => {
    mockIdentity = NON_ADMIN_IDENTITY;
    const res = await request(app).post('/api/v1/voice/config/cache/invalidate');
    expect(res.status).toBe(403);
    expect(mockInvalidateVoiceConfigCache).not.toHaveBeenCalled();
  });

  it('invalidates the cache for an admin caller', async () => {
    mockIdentity = ADMIN_IDENTITY;
    const res = await request(app).post('/api/v1/voice/config/cache/invalidate');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, vtid: 'VTID-02857' });
    expect(mockInvalidateVoiceConfigCache).toHaveBeenCalledTimes(1);
  });
});
