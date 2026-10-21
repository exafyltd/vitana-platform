/**
 * VTID-03980: GET /api/v1/events/stream must not starve the shared database.
 *
 * Measured live 2026-09-16: every open Command Hub tab polled oasis_events
 * every 3s; the first poll was unbounded (`ORDER BY created_at DESC LIMIT
 * 20` = seq scan + sort over ~540 MB), and once that page hit PostgREST's
 * 8s statement_timeout the cursor was never set, so the identical heaviest
 * query was re-issued every 3s, overlapping, per tab, forever. Logins and
 * profile reads for the mobile app were starved behind it.
 *
 * Pure-helper tests cover the query shape and the backoff schedule; the
 * server tests reuse the ephemeral-server pattern from
 * events-stream-channel-filter.test.ts because the route never ends on its
 * own.
 */

import express from 'express';
import http from 'http';
import {
  router as eventsRouter,
  buildSseEventsQuery,
  nextSsePollDelay,
  SSE_INITIAL_WINDOW_MS,
  SSE_POLL_INTERVAL_MS,
  SSE_POLL_MAX_BACKOFF_MS,
} from '../src/routes/events';

process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';

function jsonResp(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('VTID-03980: buildSseEventsQuery', () => {
  it('bounds the FIRST poll (no cursor) to a recent window instead of scanning the whole table', () => {
    const now = new Date('2026-09-16T16:00:00.000Z');
    const q = buildSseEventsQuery({ lastSeenTimestamp: null, now });
    const since = new Date(now.getTime() - SSE_INITIAL_WINDOW_MS).toISOString();
    expect(q).toContain(`created_at=gt.${encodeURIComponent(since)}`);
    expect(q).toContain('limit=20');
    expect(q).toContain('order=created_at.desc');
  });

  it('uses the cursor once one exists', () => {
    const q = buildSseEventsQuery({ lastSeenTimestamp: '2026-09-16T15:59:00.000Z' });
    expect(q).toContain(`created_at=gt.${encodeURIComponent('2026-09-16T15:59:00.000Z')}`);
    expect((q.match(/created_at=gt\./g) || []).length).toBe(1);
  });

  it('keeps the VTID-03927 channel→surface mapping and the topic/vtid filters', () => {
    const q = buildSseEventsQuery({ lastSeenTimestamp: null, channel: 'operator', topic: 'vtid.spec.approved', vtid: 'VTID-03980' });
    expect(q).toContain('surface=eq.operator');
    expect(q).toContain('topic=eq.vtid.spec.approved');
    expect(q).toContain('vtid=eq.VTID-03980');
  });
});

describe('VTID-03980: nextSsePollDelay', () => {
  it('resets to the base interval after a successful poll', () => {
    expect(nextSsePollDelay(24_000, true)).toBe(SSE_POLL_INTERVAL_MS);
  });

  it('doubles after each failed poll and caps at the maximum', () => {
    let d = SSE_POLL_INTERVAL_MS;
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      d = nextSsePollDelay(d, false);
      seen.push(d);
    }
    expect(seen).toEqual([6000, 12_000, 24_000, 30_000, 30_000, 30_000]);
    expect(Math.max(...seen)).toBe(SSE_POLL_MAX_BACKOFF_MS);
  });
});

describe('VTID-03980: GET /api/v1/events/stream back-pressure (live route)', () => {
  const mockFetch = jest.fn();
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    mockFetch.mockReset();
    global.fetch = mockFetch as any;
    const app = express();
    app.use(eventsRouter);
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    port = typeof address === 'object' && address ? address.port : 0;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function fireStream(path: string): http.ClientRequest {
    const req = http.get(`http://127.0.0.1:${port}${path}`);
    req.on('error', () => { /* socket destroyed on purpose at the end of each test */ });
    return req;
  }

  async function waitForCalls(n: number, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (mockFetch.mock.calls.length < n) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timed out waiting for ${n} oasis_events poll(s); saw ${mockFetch.mock.calls.length}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function destroyAndSettle(req: http.ClientRequest): Promise<void> {
    req.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('the very first poll already carries a created_at lower bound and an abort signal', async () => {
    mockFetch.mockResolvedValue(jsonResp([]));
    const req = fireStream('/api/v1/events/stream?channel=operator');
    try {
      await waitForCalls(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(String(url)).toContain('created_at=gt.');
      expect(String(url)).toContain('surface=eq.operator');
      expect(init && init.signal).toBeInstanceOf(AbortSignal);
    } finally {
      await destroyAndSettle(req);
    }
  });

  it('never overlaps polls: while one poll is still in flight, the next tick is skipped', async () => {
    // A poll that takes longer than the poll interval.
    mockFetch.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(jsonResp([])), SSE_POLL_INTERVAL_MS + 1500)));
    const req = fireStream('/api/v1/events/stream');
    try {
      await waitForCalls(1);
      await sleep(SSE_POLL_INTERVAL_MS + 500);
      // Old behaviour (fixed setInterval) would have fired a second, stacked
      // fetch by now; the self-scheduling loop waits for the first to finish.
      expect(mockFetch.mock.calls.length).toBe(1);
    } finally {
      await destroyAndSettle(req);
    }
  }, 10_000);

  it('stops polling when the client disconnects during a slow FIRST poll (no zombie ticker)', async () => {
    // First poll takes 1.5s; the client gives up after 300ms.
    mockFetch.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(jsonResp([])), 1500)));
    const req = fireStream('/api/v1/events/stream');
    await waitForCalls(1);
    await sleep(300);
    await destroyAndSettle(req);
    // Let the slow first poll finish and give a would-be zombie loop time to
    // fire its next tick (base interval 3s) — it must not.
    await sleep(1500 + SSE_POLL_INTERVAL_MS + 500);
    expect(mockFetch.mock.calls.length).toBe(1);
  }, 10_000);

  it('backs off after a failed poll instead of hammering at the base interval', async () => {
    mockFetch.mockRejectedValue(new Error('upstream request timeout'));
    const req = fireStream('/api/v1/events/stream');
    try {
      await waitForCalls(1);
      // First retry lands after the doubled delay (6s), not after 3s.
      await sleep(SSE_POLL_INTERVAL_MS + 500);
      expect(mockFetch.mock.calls.length).toBe(1);
      await sleep(SSE_POLL_INTERVAL_MS + 500);
      expect(mockFetch.mock.calls.length).toBe(2);
    } finally {
      await destroyAndSettle(req);
    }
  }, 15_000);
});
