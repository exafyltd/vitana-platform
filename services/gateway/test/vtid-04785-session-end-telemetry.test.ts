/**
 * VTID-04785: ORB voice session ends + provider selection never landed.
 *
 * Measured on prod oasis_events (24 h to 2026-10-01 12:25 UTC):
 *   - 117 `vtid.live.session.start`, 34 `vtid.live.session.stop`.
 *     By transport: SSE 25/107 had a stop, WS 12/12. 76 of the 82 stop-less
 *     SSE sessions carry `conversation.session.finalized` reason
 *     `sse_disconnect` — i.e. they ended through `GET /live/stream`'s
 *     `req.on('close')`, which deleted the session without emitting a stop
 *     (the SSE twin of VTID-03561). The other 6 had empty transcripts, so
 *     finalize emitted nothing, consistent with the same path.
 *   - Zero `orb.upstream.*` rows, ever: the emits omit `source`/`status`/
 *     `message`, which are NOT NULL in oasis_events, so PostgREST rejected
 *     every INSERT and the `.catch(() => {})` never saw the `{ ok: false }`.
 *
 * These tests prove the SSE end path now emits the stop + facts end exactly
 * once, that it is wired into the handler before the session is deleted, and
 * that an event missing the NOT NULL fields is filled instead of rejected.
 */

jest.mock('../src/services/voice-session-facts', () => {
  const actual = jest.requireActual('../src/services/voice-session-facts');
  return { ...actual, recordLiveSessionEnd: jest.fn() };
});
jest.mock('../src/services/timeline-projector', () => ({
  projectOasisEventToTimeline: jest.fn(async () => undefined),
}));
jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  resolveVitanaId: jest.fn(async () => null),
}));

import * as fs from 'fs';
import * as path from 'path';
import {
  configureLiveSessionController,
  emitSseDisconnectStop,
  __resetLiveSessionControllerForTests,
} from '../src/orb/live/session/live-session-controller';
import { recordLiveSessionEnd } from '../src/services/voice-session-facts';
import {
  emitOasisEvent,
  missingOasisRequiredFields,
} from '../src/services/oasis-event-service';

const recordEnd = recordLiveSessionEnd as jest.Mock;

const ORB_LIVE = fs.readFileSync(path.join(__dirname, '../src/routes/orb-live.ts'), 'utf8');
const CONTROLLER = fs.readFileSync(
  path.join(__dirname, '../src/orb/live/session/live-session-controller.ts'),
  'utf8',
);

const makeLiveSession = (over: Record<string, unknown> = {}): any => ({
  sessionId: 'live-abc',
  identity: { user_id: 'u1', tenant_id: 't1' },
  transcriptTurns: [
    { role: 'user', text: 'hi' },
    { role: 'assistant', text: 'hello' },
  ],
  active: true,
  createdAt: new Date(Date.now() - 20_000),
  lastActivity: new Date(Date.now() - 3_000),
  audioInChunks: 11,
  audioInForwarded: 10,
  audioOutChunks: 30,
  turn_count: 1,
  lang: 'de',
  upstreamProvider: 'nova_sonic',
  assistantProfile: { surface: 'community', role: 'community' },
  ...over,
});

describe('VTID-04785: SSE disconnect emits vtid.live.session.stop + facts end', () => {
  let emitted: Array<{ type: string; payload: any }>;

  beforeEach(() => {
    emitted = [];
    recordEnd.mockClear();
    __resetLiveSessionControllerForTests();
    configureLiveSessionController({
      resolveOrbIdentity: async () => null,
      clearResponseWatchdog: jest.fn(),
      sendEndOfTurn: () => true,
      emitLiveSessionEvent: jest.fn(async (type: string, payload: any) => {
        emitted.push({ type, payload });
      }),
    } as any);
  });

  afterAll(() => __resetLiveSessionControllerForTests());

  it('emits exactly one stop with transport sse and reason sse_disconnect (the regression)', () => {
    const ls = makeLiveSession();
    expect(emitSseDisconnectStop(ls, 'live-abc')).toBe(true);

    const stops = emitted.filter((e) => e.type === 'vtid.live.session.stop');
    expect(stops).toHaveLength(1);
    expect(stops[0].payload).toMatchObject({
      session_id: 'live-abc',
      user_id: 'u1',
      tenant_id: 't1',
      transport: 'sse',
      reason: 'sse_disconnect',
      audio_in_chunks: 11,
      audio_out_chunks: 30,
      turn_count: 1,
      user_turns: 1,
      model_turns: 1,
      provider: 'nova_sonic',
      lang: 'de',
      surface: 'community',
    });
    expect(stops[0].payload.duration_ms).toBeGreaterThanOrEqual(20_000);
    expect(stops[0].payload.idle_ms).toBeGreaterThanOrEqual(3_000);
  });

  it('records the voice_session_facts end for the same session and reason', () => {
    const ls = makeLiveSession();
    emitSseDisconnectStop(ls, 'live-abc');
    expect(recordEnd).toHaveBeenCalledTimes(1);
    expect(recordEnd).toHaveBeenCalledWith(ls, 'live-abc', 'sse_disconnect');
  });

  it('latches stopEventEmitted so a repeat close cannot double-book', () => {
    const ls = makeLiveSession();
    emitSseDisconnectStop(ls, 'live-abc');
    expect(ls.stopEventEmitted).toBe(true);
    expect(emitSseDisconnectStop(ls, 'live-abc')).toBe(false);
    expect(emitted.filter((e) => e.type === 'vtid.live.session.stop')).toHaveLength(1);
    expect(recordEnd).toHaveBeenCalledTimes(1);
  });

  it('does NOT emit when POST /live/session/stop already reported the end', () => {
    // The ordinary clean sequence: POST stop (emits client_stop, latches),
    // then the EventSource closes.
    const ls = makeLiveSession({ stopEventEmitted: true });
    expect(emitSseDisconnectStop(ls, 'live-abc')).toBe(false);
    expect(emitted).toHaveLength(0);
    expect(recordEnd).not.toHaveBeenCalled();
  });

  it('keys the stop by the LIVE session id when it differs from the route id', () => {
    emitSseDisconnectStop(makeLiveSession({ sessionId: 'live-xyz' }), 'route-id');
    expect(emitted[0].payload.session_id).toBe('live-xyz');
    expect(recordEnd.mock.calls[0][1]).toBe('live-xyz');
  });

  it('never throws from the socket close callback, even when the emit throws', () => {
    __resetLiveSessionControllerForTests();
    configureLiveSessionController({
      resolveOrbIdentity: async () => null,
      clearResponseWatchdog: jest.fn(),
      sendEndOfTurn: () => true,
      emitLiveSessionEvent: jest.fn(() => {
        throw new Error('oasis down');
      }),
    } as any);
    const ls = makeLiveSession();
    expect(() => emitSseDisconnectStop(ls, 'live-abc')).not.toThrow();
    expect(ls.stopEventEmitted).toBe(true);
  });

  it('reports null duration/idle for a session closed before it finished starting', () => {
    emitSseDisconnectStop(makeLiveSession({ createdAt: undefined, lastActivity: undefined, identity: null }), 'live-abc');
    expect(emitted[0].payload.duration_ms).toBeNull();
    expect(emitted[0].payload.idle_ms).toBeNull();
    expect(emitted[0].payload.user_id).toBeNull();
  });

  it('ignores a missing session', () => {
    expect(emitSseDisconnectStop(undefined, 'live-abc')).toBe(false);
    expect(emitted).toHaveLength(0);
  });
});

describe('VTID-04785: wiring — every live-session delete is preceded by a stop', () => {
  it("GET /live/stream req.on('close') calls emitSseDisconnectStop before deleting the session", () => {
    const idx = ORB_LIVE.indexOf("finalizeLiveSession(session, { sessionId, reason: 'sse_disconnect' });");
    expect(idx).toBeGreaterThan(0);
    const after = ORB_LIVE.slice(idx);
    const emitAt = after.indexOf("emitSseDisconnectStop(session, sessionId, 'sse_disconnect')");
    const deleteAt = after.indexOf('liveSessions.delete(sessionId);');
    expect(emitAt).toBeGreaterThan(0);
    expect(deleteAt).toBeGreaterThan(emitAt);
  });

  it.each([
    ['orb-live.ts', ORB_LIVE],
    ['live-session-controller.ts', CONTROLLER],
  ])('%s: each liveSessions.delete( has a stop emit within the preceding 120 lines', (_name, src) => {
    const lines = src.split('\n');
    const sites = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /liveSessions\.delete\(/.test(l) && !/^\s*\/\//.test(l));
    expect(sites.length).toBeGreaterThan(0);
    for (const { i } of sites) {
      // Code lines only — a comment mentioning the topic is not an emit.
      const window = lines
        .slice(Math.max(0, i - 120), i)
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
      expect({
        line: i + 1,
        hasStop:
          /emitLiveSessionEvent\??\.?\(\s*'vtid\.live\.session\.stop'|emitSseDisconnectStop\(/.test(window),
      }).toEqual({ line: i + 1, hasStop: true });
    }
  });
});

describe('VTID-04785: an OASIS event missing a NOT NULL column fails loudly, never silently', () => {
  const originalFetch = global.fetch;
  let bodies: any[];

  beforeEach(() => {
    bodies = [];
    process.env.SUPABASE_URL = 'https://example.invalid';
    process.env.SUPABASE_SERVICE_ROLE = 'test-key';
    (global as any).fetch = jest.fn(async (_url: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 201, text: async () => '' } as any;
    });
  });

  afterAll(() => {
    (global as any).fetch = originalFetch;
  });

  it('the old provider.selected shape (no source/status/message) is not inserted and says why', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await emitOasisEvent({
      type: 'orb.upstream.provider.selected',
      vtid: 'VTID-02980',
      payload: { session_id: 'live-abc', provider: 'nova_sonic', reason: 'nova_global_enabled' },
    } as any);
    expect(res).toEqual({ ok: false, error: 'missing_required_fields:source,status,message' });
    expect(bodies).toHaveLength(0);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('orb.upstream.provider.selected not recorded'));
    err.mockRestore();
  });

  it('nothing is defaulted: a complete event is inserted byte-for-byte', async () => {
    const res = await emitOasisEvent({
      type: 'vtid.live.session.stop',
      vtid: 'VTID-01155',
      source: 'orb-live',
      status: 'success',
      message: '',
      payload: { session_id: 'live-x' },
    } as any);
    expect(res.ok).toBe(true);
    expect(bodies[0]).toMatchObject({ topic: 'vtid.live.session.stop', service: 'orb-live', status: 'success', message: '' });
  });

  it('reports exactly which required fields are missing', () => {
    expect(missingOasisRequiredFields({ type: 't', vtid: 'X', source: 's', status: 'info' } as any)).toEqual(['message']);
    expect(missingOasisRequiredFields({ type: 't', vtid: 'X', source: 's', status: 'info', message: '' } as any)).toEqual([]);
  });

  it('the provider.selected call site now passes all three fields explicitly', () => {
    const i = ORB_LIVE.indexOf("type: 'orb.upstream.provider.selected'");
    expect(i).toBeGreaterThan(0);
    const block = ORB_LIVE.slice(i, i + 600);
    expect(block).toMatch(/source: 'gateway'/);
    expect(block).toMatch(/status: 'info'/);
    expect(block).toMatch(/message: `upstream provider selected/);
  });
});
