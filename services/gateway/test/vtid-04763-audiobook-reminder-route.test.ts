/**
 * VTID-04763 — POST /api/v1/journey/audiobook/reminder and the local date on
 * POST /session-listened.
 */
import request from 'supertest';
import express from 'express';

const mockSet = jest.fn();
const mockEmit = jest.fn(async () => ({ ok: true }));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: (...a: unknown[]) => (mockEmit as any)(...a) }));
const mockRecord = jest.fn();

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
jest.mock('../src/services/guided-journey/guided-journey-state', () => ({
  ...jest.requireActual('../src/services/guided-journey/guided-journey-state'),
  setAudiobookReminder: (...a: unknown[]) => mockSet(...a),
  recordListenedSession: (...a: unknown[]) => mockRecord(...a),
}));
jest.mock('../src/services/guided-journey/journey-index-award', () => ({
  recordSessionListen: async () => ({ awarded: false, points: 0, totalBonus: 0 }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../src/routes/guided-journey').default;
const app = () => {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/journey', router);
  return a;
};
const URL_ = '/api/v1/journey/audiobook/reminder';

describe('POST /audiobook/reminder', () => {
  beforeEach(() => {
    mockSet.mockReset().mockResolvedValue({ audiobookReminder: null });
    mockRecord.mockReset().mockResolvedValue({ currentSession: 4 });
  });

  it('401 without a token', async () => {
    expect((await request(app()).post(URL_).send({ time: '08:00', tz: 'UTC' })).status).toBe(401);
  });

  it('sets a valid reminder', async () => {
    const res = await request(app()).post(URL_).set('Authorization', 'Bearer valid-user').send({ time: '08:00', tz: 'Europe/Berlin' });
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith({}, 'u-1', { time: '08:00', tz: 'Europe/Berlin' });
  });

  it('records the opt-in and the opt-out as OASIS events', async () => {
    mockEmit.mockClear();
    await request(app()).post(URL_).set('Authorization', 'Bearer valid-user').send({ time: '08:00', tz: 'UTC' });
    await request(app()).post(URL_).set('Authorization', 'Bearer valid-user').send({ time: null });
    expect((mockEmit.mock.calls as any[]).map((c) => c[0].type)).toEqual([
      'journey.audiobook.reminder.set',
      'journey.audiobook.reminder.cleared',
    ]);
    expect((mockEmit.mock.calls as any[])[0][0]).toMatchObject({ vtid: 'VTID-04763', actor_id: 'u-1', payload: { time: '08:00', tz: 'UTC' } });
  });

  it('switches it off', async () => {
    const res = await request(app()).post(URL_).set('Authorization', 'Bearer valid-user').send({ time: null });
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith({}, 'u-1', null);
  });

  it.each([
    [{ time: '25:00', tz: 'UTC' }],
    [{ time: '23:00', tz: 'UTC' }],
    [{ time: '08:00', tz: 'Not/AZone' }],
    [{}],
  ])('400 for %j', async (body) => {
    const res = await request(app()).post(URL_).set('Authorization', 'Bearer valid-user').send(body);
    expect(res.status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });
});

describe('POST /session-listened carries the local date', () => {
  it('passes localDate through to the state service', async () => {
    await request(app())
      .post('/api/v1/journey/session-listened')
      .set('Authorization', 'Bearer valid-user')
      .send({ session: 3, topicId: 'T255', localDate: '2026-10-01' });
    expect(mockRecord).toHaveBeenCalledWith({}, 'u-1', 3, undefined, '2026-10-01');
  });
});
