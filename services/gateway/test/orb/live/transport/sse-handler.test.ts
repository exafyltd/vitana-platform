/**
 * A9.2 (orb-live-refactor / VTID-02958): runtime tests for the SSE transport
 * helpers — `orb/live/transport/sse-handler.ts`.
 *
 * Covers the legacy wire format byte-for-byte:
 *   - 4 SSE upgrade headers
 *   - `data: ${JSON.stringify(payload)}\n\n` event encoding
 *   - 10 s data heartbeat (NOT an SSE `:` comment)
 *   - Safe-write swallows errors / closed sockets
 *   - Heartbeat clear() is idempotent
 *   - Heartbeat auto-clears on write failure (matches legacy catch arm)
 */

import {
  SSE_HEADERS,
  SSE_DEFAULT_HEARTBEAT_MS,
  attachSseHeaders,
  encodeSseEvent,
  writeSseEvent,
  startSseHeartbeat,
} from '../../../../src/orb/live/transport/sse-handler';
import type { SseResponseLike } from '../../../../src/orb/live/transport/types';

function makeMockRes(opts: {
  flushHeaders?: boolean;
  throwOnWrite?: boolean;
  writableEnded?: boolean;
} = {}): SseResponseLike & {
  headers: Record<string, string>;
  writes: string[];
  flushedHeaders: number;
} {
  const headers: Record<string, string> = {};
  const writes: string[] = [];
  let flushedHeaders = 0;

  return {
    headers,
    writes,
    get flushedHeaders() {
      return flushedHeaders;
    },
    writableEnded: opts.writableEnded === true,
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
    write(chunk: string): boolean {
      if (opts.throwOnWrite) {
        throw new Error('socket closed');
      }
      writes.push(chunk);
      return true;
    },
    flushHeaders: opts.flushHeaders === false ? undefined : () => {
      flushedHeaders++;
    },
  };
}

describe('A9.2: SSE transport helpers', () => {
  describe('SSE_HEADERS constant', () => {
    it('declares the 4 canonical SSE upgrade headers in order', () => {
      expect(SSE_HEADERS).toEqual([
        ['Content-Type', 'text/event-stream'],
        ['Cache-Control', 'no-cache'],
        ['Connection', 'keep-alive'],
        ['X-Accel-Buffering', 'no'],
      ]);
    });

    it('is frozen (anti-mutation)', () => {
      expect(Object.isFrozen(SSE_HEADERS)).toBe(true);
    });
  });

  describe('SSE_DEFAULT_HEARTBEAT_MS', () => {
    it('matches the legacy 10s cadence', () => {
      expect(SSE_DEFAULT_HEARTBEAT_MS).toBe(10_000);
    });
  });

  describe('attachSseHeaders', () => {
    it('sets the 4 SSE headers and calls flushHeaders', () => {
      const res = makeMockRes();
      attachSseHeaders(res);
      expect(res.headers['Content-Type']).toBe('text/event-stream');
      expect(res.headers['Cache-Control']).toBe('no-cache');
      expect(res.headers['Connection']).toBe('keep-alive');
      expect(res.headers['X-Accel-Buffering']).toBe('no');
      expect(res.flushedHeaders).toBe(1);
    });

    it('is a no-op when flushHeaders is missing (some Response shims)', () => {
      const res = makeMockRes({ flushHeaders: false });
      expect(() => attachSseHeaders(res)).not.toThrow();
      expect(res.headers['Content-Type']).toBe('text/event-stream');
    });

    it('does not write to the body during header attach', () => {
      const res = makeMockRes();
      attachSseHeaders(res);
      expect(res.writes).toHaveLength(0);
    });
  });

  describe('encodeSseEvent', () => {
    it('encodes a payload as `data: ${json}\\n\\n`', () => {
      expect(encodeSseEvent({ type: 'ready' })).toBe('data: {"type":"ready"}\n\n');
    });

    it('preserves nested objects + arrays', () => {
      const payload = { type: 'ready', meta: { model: 'gemini', items: [1, 2] } };
      expect(encodeSseEvent(payload)).toBe(
        'data: {"type":"ready","meta":{"model":"gemini","items":[1,2]}}\n\n',
      );
    });

    it('matches the heartbeat payload format used by the legacy handlers', () => {
      const out = encodeSseEvent({ type: 'heartbeat', ts: 1234567890 });
      expect(out).toBe('data: {"type":"heartbeat","ts":1234567890}\n\n');
    });
  });

  describe('writeSseEvent', () => {
    it('writes the encoded event to the response', () => {
      const res = makeMockRes();
      const ok = writeSseEvent(res, { type: 'ready' });
      expect(ok).toBe(true);
      expect(res.writes).toEqual(['data: {"type":"ready"}\n\n']);
    });

    it('returns false (without throwing) when the socket is already ended', () => {
      const res = makeMockRes({ writableEnded: true });
      const ok = writeSseEvent(res, { type: 'ready' });
      expect(ok).toBe(false);
      expect(res.writes).toHaveLength(0);
    });

    it('returns false (without throwing) when res.write throws', () => {
      const res = makeMockRes({ throwOnWrite: true });
      const ok = writeSseEvent(res, { type: 'audio' });
      expect(ok).toBe(false);
    });
  });

  describe('startSseHeartbeat', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('ticks every 10s by default with { type: "heartbeat", ts }', () => {
      const res = makeMockRes();
      const h = startSseHeartbeat(res);
      try {
        expect(res.writes).toHaveLength(0);
        jest.advanceTimersByTime(10_000);
        expect(res.writes).toHaveLength(1);
        const parsed = JSON.parse(res.writes[0].replace(/^data: /, '').trim());
        expect(parsed.type).toBe('heartbeat');
        expect(typeof parsed.ts).toBe('number');

        jest.advanceTimersByTime(10_000);
        expect(res.writes).toHaveLength(2);
      } finally {
        h.clear();
      }
    });

    it('honors a custom intervalMs', () => {
      const res = makeMockRes();
      const h = startSseHeartbeat(res, { intervalMs: 1_000 });
      try {
        jest.advanceTimersByTime(2_500);
        expect(res.writes).toHaveLength(2);
      } finally {
        h.clear();
      }
    });

    it('honors a custom type label', () => {
      const res = makeMockRes();
      const h = startSseHeartbeat(res, { type: 'keepalive' });
      try {
        jest.advanceTimersByTime(10_000);
        const parsed = JSON.parse(res.writes[0].replace(/^data: /, '').trim());
        expect(parsed.type).toBe('keepalive');
      } finally {
        h.clear();
      }
    });

    it('merges extend() output into each heartbeat payload', () => {
      const res = makeMockRes();
      let counter = 0;
      const h = startSseHeartbeat(res, { extend: () => ({ seq: ++counter }) });
      try {
        jest.advanceTimersByTime(20_000);
        const p1 = JSON.parse(res.writes[0].replace(/^data: /, '').trim());
        const p2 = JSON.parse(res.writes[1].replace(/^data: /, '').trim());
        expect(p1.seq).toBe(1);
        expect(p2.seq).toBe(2);
        expect(p1.type).toBe('heartbeat');
      } finally {
        h.clear();
      }
    });

    it('clear() is idempotent', () => {
      const res = makeMockRes();
      const h = startSseHeartbeat(res, { intervalMs: 1_000 });
      h.clear();
      h.clear();
      h.clear();
      jest.advanceTimersByTime(5_000);
      expect(res.writes).toHaveLength(0);
      expect(h.active).toBe(false);
    });

    it('auto-clears on the first failed write (matches legacy catch arm)', () => {
      const res = makeMockRes({ throwOnWrite: true });
      const h = startSseHeartbeat(res, { intervalMs: 1_000 });
      jest.advanceTimersByTime(1_000);
      // First tick wrote nothing (write threw); heartbeat self-cleared.
      expect(h.active).toBe(false);
      // Subsequent ticks do not produce any further attempts.
      jest.advanceTimersByTime(5_000);
      expect(res.writes).toHaveLength(0);
    });

    it('auto-clears when the socket has already ended (writableEnded=true)', () => {
      const res = makeMockRes({ writableEnded: true });
      const h = startSseHeartbeat(res, { intervalMs: 1_000 });
      jest.advanceTimersByTime(1_000);
      expect(h.active).toBe(false);
      expect(res.writes).toHaveLength(0);
    });

    it('active getter reflects the lifecycle', () => {
      const res = makeMockRes();
      const h = startSseHeartbeat(res, { intervalMs: 1_000 });
      expect(h.active).toBe(true);
      h.clear();
      expect(h.active).toBe(false);
    });
  });
});
