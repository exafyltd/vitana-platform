/**
 * VTID-04543 — upsertActiveDay() writes at most once per user per UTC date
 * per process. The first call of the day runs exactly as before; a failed
 * write is retried by the next call; the day rolling over starts fresh.
 */

const upsertMock = jest.fn();
jest.mock('../../../src/services/guide/active-usage-repository', () => ({
  upsertActiveUsageDay: (...args: unknown[]) => upsertMock(...args),
  countActiveUsageDaysForUser: jest.fn(),
}));

const fakeSupabase = { tag: 'supabase' };
jest.mock('../../../src/lib/supabase', () => ({
  getSupabase: () => fakeSupabase,
}));

import {
  upsertActiveDay,
  __resetActiveDayThrottleForTests,
} from '../../../src/services/guide/active-usage';

beforeEach(() => {
  __resetActiveDayThrottleForTests();
  upsertMock.mockReset();
  upsertMock.mockResolvedValue({ error: null });
  jest.useRealTimers();
});

afterAll(() => {
  jest.useRealTimers();
});

describe('VTID-04543: upsertActiveDay throttle', () => {
  it('the first call writes exactly as before; repeats the same day do not write again', async () => {
    const today = new Date().toISOString().slice(0, 10);
    for (let i = 0; i < 50; i++) await upsertActiveDay('user-1');
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(upsertMock).toHaveBeenCalledWith(fakeSupabase, 'user-1', today);
  });

  it('each user gets their own first write', async () => {
    await upsertActiveDay('user-1');
    await upsertActiveDay('user-2');
    await upsertActiveDay('user-1');
    await upsertActiveDay('user-2');
    expect(upsertMock.mock.calls.map((c) => c[1])).toEqual(['user-1', 'user-2']);
  });

  it('concurrent calls share the one in-flight write', async () => {
    let release!: (v: { error: null }) => void;
    upsertMock.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const calls = [upsertActiveDay('user-1'), upsertActiveDay('user-1'), upsertActiveDay('user-1')];
    release({ error: null });
    await Promise.all(calls);
    expect(upsertMock).toHaveBeenCalledTimes(1);
  });

  it('a write that returned an error is retried on the next call', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      upsertMock.mockResolvedValueOnce({ error: { message: 'db down' } });
      await upsertActiveDay('user-1');
      await upsertActiveDay('user-1');
      await upsertActiveDay('user-1');
      expect(upsertMock).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('a write that threw propagates to the caller (as before) and is retried next time', async () => {
    upsertMock.mockRejectedValueOnce(new Error('network'));
    await expect(upsertActiveDay('user-1')).rejects.toThrow('network');
    await upsertActiveDay('user-1');
    await upsertActiveDay('user-1');
    expect(upsertMock).toHaveBeenCalledTimes(2);
  });

  it('a new UTC date writes again', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date('2026-09-25T23:59:00Z'));
    await upsertActiveDay('user-1');
    await upsertActiveDay('user-1');
    jest.setSystemTime(new Date('2026-09-26T00:01:00Z'));
    await upsertActiveDay('user-1');
    await upsertActiveDay('user-1');
    expect(upsertMock.mock.calls.map((c) => c[2])).toEqual(['2026-09-25', '2026-09-26']);
  });

  it('empty user id still does nothing', async () => {
    await upsertActiveDay('');
    expect(upsertMock).not.toHaveBeenCalled();
  });
});
