/**
 * VTID-03927: GET /api/v1/events/stream's `channel` query param.
 *
 * The route's own doc comment has said since it was written that `channel`
 * filters the SSE stream (e.g. "operator"), but the handler never read
 * `req.query.channel` — only `topic` and `vtid`. Command Hub's
 * `startOperatorSse()` requests `?channel=operator` expecting a scoped feed
 * and silently got the full platform-wide last-20-events firehose instead.
 *
 * Fix maps `channel` to the existing `surface` column (already written as
 * 'operator'/'orb' by conversation.ts/tenant-specialists.ts), so this pins
 * that the query PostgREST actually receives carries the filter.
 *
 * The endpoint never terminates on its own (only on client disconnect), so
 * this can't be driven with supertest's request/response completion — it
 * spins up a real ephemeral server and polls for the mocked fetch call
 * instead of waiting on the HTTP response to end.
 */

import express from 'express';
import http from 'http';
import { router as eventsRouter } from '../src/routes/events';

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

describe('VTID-03927: GET /api/v1/events/stream honors ?channel=', () => {
  const mockFetch = jest.fn();
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(jsonResp([]));
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
    req.on('error', () => {
      // destroying the socket to end the test raises an error event —
      // expected, not a real failure.
    });
    return req;
  }

  async function waitForFetchCall(): Promise<void> {
    const start = Date.now();
    while (mockFetch.mock.calls.length === 0) {
      if (Date.now() - start > 2000) {
        throw new Error('timed out waiting for the SSE route to poll oasis_events');
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  // Destroying the client socket triggers the server's `req.on("close")`
  // handler (which clears the route's own intervals) asynchronously — wait
  // a beat so that teardown lands before the next test/suite starts,
  // instead of logging into an already-torn-down Jest console.
  async function destroyAndSettle(req: http.ClientRequest): Promise<void> {
    req.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  it('translates channel=operator into surface=eq.operator on the oasis_events query', async () => {
    const req = fireStream('/api/v1/events/stream?channel=operator');
    try {
      await waitForFetchCall();
      const [url] = mockFetch.mock.calls[0];
      expect(String(url)).toContain('surface=eq.operator');
    } finally {
      await destroyAndSettle(req);
    }
  });

  it('omits the surface filter entirely when no channel is passed', async () => {
    const req = fireStream('/api/v1/events/stream');
    try {
      await waitForFetchCall();
      const [url] = mockFetch.mock.calls[0];
      expect(String(url)).not.toContain('surface=eq.');
    } finally {
      await destroyAndSettle(req);
    }
  });

  it('still applies vtid/topic filters alongside channel', async () => {
    const req = fireStream('/api/v1/events/stream?channel=operator&vtid=VTID-03927&topic=vtid.spec.approved');
    try {
      await waitForFetchCall();
      const [url] = mockFetch.mock.calls[0];
      expect(String(url)).toContain('surface=eq.operator');
      expect(String(url)).toContain('vtid=eq.VTID-03927');
      expect(String(url)).toContain('topic=eq.vtid.spec.approved');
    } finally {
      await destroyAndSettle(req);
    }
  });
});
