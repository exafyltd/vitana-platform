/**
 * VTID-04835: a gateway task ECS replaces must report the live voice sessions
 * it is ending. Before this the gateway installed no SIGTERM/SIGINT handler
 * anywhere (node runs as PID 1, which ignores a default-disposition SIGTERM),
 * so those sessions ended with no `vtid.live.session.stop` and no
 * voice_session_facts end.
 */

jest.mock('../src/services/voice-session-facts', () => {
  const actual = jest.requireActual('../src/services/voice-session-facts');
  return {
    ...actual,
    recordLiveSessionEnd: jest.fn(),
    flushVoiceSessionFactsWrites: jest.fn(async () => undefined),
  };
});

import * as fs from 'fs';
import * as path from 'path';
import {
  configureLiveSessionController,
  emitShutdownStopsForLiveSessions,
  cleanupWsSession,
  __resetLiveSessionControllerForTests,
} from '../src/orb/live/session/live-session-controller';
import { liveSessions, wsClientSessions } from '../src/orb/live/session/live-session-registry';
import { recordLiveSessionEnd, flushVoiceSessionFactsWrites } from '../src/services/voice-session-facts';
import { createShutdownHandler } from '../src/services/graceful-shutdown';

const recordEnd = recordLiveSessionEnd as jest.Mock;
const flushFacts = flushVoiceSessionFactsWrites as jest.Mock;
let emitted: Array<{ type: string; payload: any }>;
let emitImpl: (type: string, payload: any) => Promise<void>;

function makeLive(id: string, over: Record<string, unknown> = {}): any {
  return {
    sessionId: id,
    identity: { user_id: `u-${id}`, tenant_id: 't-1' },
    transcriptTurns: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }],
    active: true,
    createdAt: new Date(Date.now() - 45_000),
    lastActivity: new Date(Date.now() - 2_000),
    audioInChunks: 7,
    audioInForwarded: 7,
    audioOutChunks: 12,
    videoInFrames: 0,
    turn_count: 2,
    lang: 'en',
    upstreamProvider: 'nova_sonic',
    clientWs: { readyState: 1, send: jest.fn(), close: jest.fn() },
    assistantProfile: { surface: 'community', role: 'community' },
    ...over,
  };
}

beforeEach(() => {
  emitted = [];
  emitImpl = async () => undefined;
  recordEnd.mockClear();
  flushFacts.mockClear();
  flushFacts.mockImplementation(async () => undefined);
  liveSessions.clear();
  wsClientSessions.clear();
  __resetLiveSessionControllerForTests();
  configureLiveSessionController({
    resolveOrbIdentity: async () => null,
    clearResponseWatchdog: jest.fn(),
    sendEndOfTurn: () => true,
    emitLiveSessionEvent: jest.fn((type: string, payload: any) => {
      emitted.push({ type, payload });
      return emitImpl(type, payload);
    }),
  } as any);
});
afterAll(() => {
  liveSessions.clear();
  wsClientSessions.clear();
  __resetLiveSessionControllerForTests();
});

describe('VTID-04835: emitShutdownStopsForLiveSessions', () => {
  it('emits one server_shutdown stop + facts end per live session', async () => {
    liveSessions.set('live-a', makeLive('live-a'));
    liveSessions.set('live-b', makeLive('live-b', { clientWs: null }));

    const r = await emitShutdownStopsForLiveSessions('server_shutdown', 1_000);

    expect(r).toEqual({ emitted: 2, skipped: 0, timedOut: false });
    const stops = emitted.filter((e) => e.type === 'vtid.live.session.stop');
    expect(stops).toHaveLength(2);
    expect(stops.find((s) => s.payload.session_id === 'live-a')!.payload).toMatchObject({
      reason: 'server_shutdown',
      transport: 'websocket',
      user_id: 'u-live-a',
      tenant_id: 't-1',
      audio_in_chunks: 7,
      audio_out_chunks: 12,
      turn_count: 2,
      user_turns: 1,
      model_turns: 1,
      provider: 'nova_sonic',
      lang: 'en',
      surface: 'community',
    });
    expect(stops.find((s) => s.payload.session_id === 'live-b')!.payload.transport).toBe('sse');
    expect(recordEnd).toHaveBeenCalledTimes(2);
    expect(recordEnd).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'live-a' }), 'live-a', 'server_shutdown');
    expect(flushFacts).toHaveBeenCalledTimes(1); // the facts writes are awaited
  });

  it('skips sessions another end path already reported', async () => {
    liveSessions.set('live-a', makeLive('live-a', { stopEventEmitted: true }));
    liveSessions.set('live-b', makeLive('live-b'));
    const r = await emitShutdownStopsForLiveSessions('server_shutdown', 1_000);
    expect(r).toMatchObject({ emitted: 1, skipped: 1 });
    expect(emitted.map((e) => e.payload.session_id)).toEqual(['live-b']);
    expect(recordEnd).toHaveBeenCalledTimes(1);
  });

  it('is idempotent and latches, so a socket close after the drain books nothing more', async () => {
    const ls = makeLive('live-a');
    liveSessions.set('live-a', ls);
    wsClientSessions.set('ws-1', { sessionId: 'ws-1', clientWs: ls.clientWs, liveSession: ls } as any);

    await emitShutdownStopsForLiveSessions('server_shutdown', 1_000);
    const again = await emitShutdownStopsForLiveSessions('server_shutdown', 1_000);
    cleanupWsSession('ws-1', 'client_disconnect');

    expect(again).toMatchObject({ emitted: 0, skipped: 1 });
    expect(emitted.filter((e) => e.type === 'vtid.live.session.stop')).toHaveLength(1);
    expect(recordEnd).toHaveBeenCalledTimes(1);
  });

  it('is bounded by the timeout when a write hangs', async () => {
    emitImpl = () => new Promise<void>(() => { /* never settles */ });
    flushFacts.mockImplementation(() => new Promise<void>(() => { /* never settles */ }));
    liveSessions.set('live-a', makeLive('live-a'));

    const t0 = Date.now();
    const r = await emitShutdownStopsForLiveSessions('server_shutdown', 150);
    const took = Date.now() - t0;

    expect(r).toMatchObject({ emitted: 1, timedOut: true });
    expect(took).toBeGreaterThanOrEqual(140);
    expect(took).toBeLessThan(2_000);
  });

  it('never throws — a throwing emit loses only that OASIS row; every session still gets its stop attempt + facts end', async () => {
    let n = 0;
    emitImpl = () => {
      n++;
      if (n === 1) throw new Error('boom');
      return Promise.resolve();
    };
    liveSessions.set('live-a', makeLive('live-a'));
    liveSessions.set('live-b', makeLive('live-b'));
    const r = await emitShutdownStopsForLiveSessions('server_shutdown', 1_000);
    expect(r.emitted).toBe(2);
    expect(emitted).toHaveLength(2);
    expect(recordEnd).toHaveBeenCalledTimes(2);
    expect(liveSessions.get('live-a')!.stopEventEmitted).toBe(true); // no retry storm on a broken emitter
  });

  it('works with no live sessions and when the controller was never configured', async () => {
    __resetLiveSessionControllerForTests();
    await expect(emitShutdownStopsForLiveSessions('server_shutdown', 100)).resolves.toEqual({
      emitted: 0,
      skipped: 0,
      timedOut: false,
    });
  });
});

describe('VTID-04835: createShutdownHandler (SIGTERM/SIGINT)', () => {
  const quietLog = { log: jest.fn(), warn: jest.fn() };

  it('drains first, then closes the server, then exits 0 — once, however many signals', async () => {
    const order: string[] = [];
    const exit = jest.fn(() => order.push('exit'));
    const server = { close: jest.fn((cb?: () => void) => { order.push('close'); cb?.(); }) };
    const handler = createShutdownHandler(server as any, {
      drainTimeoutMs: 1_000,
      closeGraceMs: 1_000,
      exit,
      logger: quietLog,
      drainHooks: [async () => { order.push('drain'); }],
    });
    const p1 = handler('SIGTERM');
    const p2 = handler('SIGTERM');
    await Promise.all([p1, p2]);
    expect(order).toEqual(['drain', 'close', 'exit']);
    expect(exit).toHaveBeenCalledWith(0);
    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it('a hanging drain hook cannot hold shutdown past the drain bound; a hanging close past the grace', async () => {
    const exit = jest.fn();
    const server = { close: jest.fn(() => { /* never calls back: open WebSockets */ }) };
    const handler = createShutdownHandler(server as any, {
      drainTimeoutMs: 100,
      closeGraceMs: 100,
      exit,
      logger: quietLog,
      drainHooks: [() => new Promise(() => { /* hangs */ })],
    });
    const t0 = Date.now();
    await handler('SIGTERM');
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('a throwing drain hook does not stop the shutdown', async () => {
    const exit = jest.fn();
    const server = { close: jest.fn((cb?: () => void) => cb?.()) };
    const handler = createShutdownHandler(server as any, {
      exit,
      logger: quietLog,
      drainHooks: [async () => { throw new Error('boom'); }],
    });
    await expect(handler('SIGINT')).resolves.toBeUndefined();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('index.ts installs the handler with the live-session drain, and nothing else registers a signal handler', () => {
    const src = path.join(__dirname, '../src');
    const index = fs.readFileSync(path.join(src, 'index.ts'), 'utf8');
    expect(index).toMatch(/installGracefulShutdown\(server/);
    expect(index).toMatch(/emitShutdownStopsForLiveSessions\('server_shutdown'/);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'frontend' && e.name !== 'node_modules') walk(p);
        } else if (/\.ts$/.test(e.name) && /process\.(on|once)\(\s*['"]SIG(TERM|INT)/.test(fs.readFileSync(p, 'utf8'))) {
          offenders.push(path.relative(src, p));
        }
      }
    };
    walk(src);
    // The one installer registers via a loop (`process.on(sig, …)`), so no
    // file should register SIGTERM/SIGINT literally — a competing handler.
    expect(offenders).toEqual([]);
  });
});
