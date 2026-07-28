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
jest.mock('@google-cloud/text-to-speech', () => ({
  __esModule: true,
  default: {
    TextToSpeechClient: jest.fn().mockImplementation(() => ({
      synthesizeSpeech: mockSynthesizeSpeech,
    })),
  },
  protos: {},
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

  it('synthesizes with the default English voice and returns audio/mpeg bytes', async () => {
    mockIdentity = ADMIN_IDENTITY;
    const res = await request(app).post('/api/v1/voice/preview').send({ text: 'Hello there' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/audio\/mpeg/);
    expect(Buffer.compare(res.body, Buffer.from('fake-mp3-bytes'))).toBe(0);
    expect(mockSynthesizeSpeech).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { text: 'Hello there' },
        voice: { languageCode: 'en-US', name: 'en-US-Neural2-H' },
        audioConfig: expect.objectContaining({ speakingRate: 1.0, pitch: 0 }),
      }),
    );
  });

  it('sets modelName for a gemini-tier voice', async () => {
    mockIdentity = ADMIN_IDENTITY;
    const res = await request(app)
      .post('/api/v1/voice/preview')
      .send({ text: 'Hallo', language: 'de', voice: 'Kore' });

    expect(res.status).toBe(200);
    const callArg = mockSynthesizeSpeech.mock.calls[0][0];
    expect(callArg.voice.name).toBe('Kore');
    expect(callArg.voice.modelName).toBe('gemini-2.5-flash-tts');
  });

  it('clamps an out-of-range speaking_rate', async () => {
    mockIdentity = ADMIN_IDENTITY;
    await request(app).post('/api/v1/voice/preview').send({ text: 'hi', speaking_rate: 99 });
    const callArg = mockSynthesizeSpeech.mock.calls[0][0];
    expect(callArg.audioConfig.speakingRate).toBe(4.0);
  });

  it('returns 500 when the TTS client returns no audio content', async () => {
    mockIdentity = ADMIN_IDENTITY;
    mockSynthesizeSpeech.mockResolvedValue([{}]);
    const res = await request(app).post('/api/v1/voice/preview').send({ text: 'hi' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('no audio content');
  });

  it('returns 500 when the TTS client throws', async () => {
    mockIdentity = ADMIN_IDENTITY;
    mockSynthesizeSpeech.mockRejectedValue(new Error('quota exceeded'));
    const res = await request(app).post('/api/v1/voice/preview').send({ text: 'hi' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('quota exceeded');
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
