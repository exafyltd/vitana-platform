/**
 * VTID-04761 — Audiobook listening mode: the per-topic MP3 HTTP route.
 * (Unit tests for the renderer live in vtid-04761-audiobook-audio.test.ts.)
 */
import request from 'supertest';
import express from 'express';

// ---------------------------------------------------------------------------
// HTTP route
// ---------------------------------------------------------------------------
const mockSeed = jest.fn();
const mockSynth = jest.fn();

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (req.headers.authorization === 'Bearer valid-user') {
      req.identity = { user_id: 'u-1' };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'unauthenticated' });
  },
}));
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => ({}) }));
jest.mock('../src/services/guided-journey/checklist-service', () => ({
  ...jest.requireActual('../src/services/guided-journey/checklist-service'),
  getOrbTopicSeed: (...args: unknown[]) => mockSeed(...args),
}));
jest.mock('../src/services/guided-journey/audiobook-episode-audio', () => ({
  synthesizeAudiobookTopicMp3: (...args: unknown[]) => mockSynth(...args),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../src/routes/guided-journey').default;
const app = () => {
  const a = express();
  a.use('/api/v1/journey', router);
  return a;
};
const AUDIO = '/api/v1/journey/audiobook/topics/T001/audio';
const seed = {
  topicId: 'T001',
  displayLabel: 'What Is Vitanaland',
  vitanaVoiceScript: 'Hallo.',
  explanation: { whatItIs: null, userBenefit: null, whenToUse: null, tryThis: null },
  guidedPracticeTarget: null,
  source: 'published',
};

describe('GET /api/v1/journey/audiobook/topics/:topicId/audio', () => {
  beforeEach(() => {
    mockSeed.mockReset();
    mockSynth.mockReset();
  });

  it('401 without a token', async () => {
    expect((await request(app()).get(AUDIO)).status).toBe(401);
  });

  it('400 for a malformed topic id', async () => {
    const res = await request(app()).get('/api/v1/journey/audiobook/topics/..%2Fetc/audio').set('Authorization', 'Bearer valid-user');
    expect(res.status).toBe(400);
  });

  it('404 when the topic is not in the published catalog', async () => {
    mockSeed.mockResolvedValue(null);
    const res = await request(app()).get(AUDIO).set('Authorization', 'Bearer valid-user');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('topic_not_live');
  });

  it('422 when narration is unavailable for the language', async () => {
    mockSeed.mockResolvedValue(seed);
    mockSynth.mockResolvedValue(null);
    const res = await request(app()).get(`${AUDIO}?lang=sr`).set('Authorization', 'Bearer valid-user');
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ ok: false, error: 'narration_unavailable', lang: 'sr' });
  });

  it('200 audio/mpeg, private cache, in the requested language', async () => {
    mockSeed.mockResolvedValue(seed);
    mockSynth.mockResolvedValue({ mp3: Buffer.from('ID3fake'), cached: true });
    const res = await request(app()).get(`${AUDIO}?lang=en`).set('Authorization', 'Bearer valid-user');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.headers['cache-control']).toBe('private, max-age=86400');
    expect(res.headers['x-audiobook-cache']).toBe('hit');
    expect(mockSeed.mock.calls[0][1]).toBe('T001');
    expect(mockSeed.mock.calls[0][3]).toBe('en');
    expect(mockSynth.mock.calls[0][1]).toBe('en');
  });

  it('an unknown language falls back to German', async () => {
    mockSeed.mockResolvedValue(seed);
    mockSynth.mockResolvedValue({ mp3: Buffer.from('x'), cached: false });
    await request(app()).get(`${AUDIO}?lang=xx`).set('Authorization', 'Bearer valid-user');
    expect(mockSeed.mock.calls[0][3]).toBe('de');
  });
});
