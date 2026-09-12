/**
 * routes/reminders.ts POST /:id/snooze — previously had no test coverage.
 * Added alongside the 2026-08-30 fix for the swallowed
 * fetchReminderSnoozeCount error: a Postgres-level failure resolved `row`
 * to null, indistinguishable from a genuinely-deleted/nonexistent reminder
 * (404 NOT_FOUND) rather than the 500 a real DB error should produce.
 */

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  optionalAuth: (req: any, _res: any, next: any) => {
    req.identity = { user_id: 'user-1', tenant_id: 'tenant-1' };
    next();
  },
}));

const mockGetSupabase = jest.fn();
jest.mock('../../src/lib/supabase', () => ({
  getSupabase: (...args: unknown[]) => mockGetSupabase(...args),
}));

const mockFetchReminderSnoozeCount = jest.fn();
const mockUpdateReminderSnooze = jest.fn();
jest.mock('../../src/routes/reminders-repository', () => {
  const actual = jest.requireActual('../../src/routes/reminders-repository');
  return {
    ...actual,
    fetchReminderSnoozeCount: (...args: unknown[]) => mockFetchReminderSnoozeCount(...args),
    updateReminderSnooze: (...args: unknown[]) => mockUpdateReminderSnooze(...args),
  };
});

import express from 'express';
import request from 'supertest';
import router from '../../src/routes/reminders';

const app = express();
app.use(express.json());
app.use('/api/v1/reminders', router);

describe('POST /api/v1/reminders/:id/snooze — fetchReminderSnoozeCount error handling', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSupabase.mockReturnValue({});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('returns 500 (not the misleading 404 NOT_FOUND) when the lookup errors', async () => {
    mockFetchReminderSnoozeCount.mockResolvedValue({
      data: null,
      error: { message: 'connection terminated unexpectedly' },
    });

    const res = await request(app).post('/api/v1/reminders/rem-1/snooze').send({ minutes: 10 });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'Internal error' });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('POST /:id/snooze error:'),
      'connection terminated unexpectedly',
    );
    expect(mockUpdateReminderSnooze).not.toHaveBeenCalled();
  });

  it('returns 404 NOT_FOUND for a genuinely missing/deleted reminder (no error) — unchanged', async () => {
    mockFetchReminderSnoozeCount.mockResolvedValue({ data: null, error: null });

    const res = await request(app).post('/api/v1/reminders/rem-1/snooze').send({ minutes: 10 });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, error: 'NOT_FOUND' });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('snoozes successfully when the row is found (unchanged)', async () => {
    mockFetchReminderSnoozeCount.mockResolvedValue({ data: { snooze_count: 1 }, error: null });
    mockUpdateReminderSnooze.mockResolvedValue({ data: { id: 'rem-1', snooze_count: 2 }, error: null });

    const res = await request(app).post('/api/v1/reminders/rem-1/snooze').send({ minutes: 10 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
