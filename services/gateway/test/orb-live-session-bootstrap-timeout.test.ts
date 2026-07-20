/**
 * BOOTSTRAP-ORB-CONNECT-HANG
 *
 * Pins the timeout-gate fallback behaviour added to the native WebSocket
 * ORB session-start bootstrap chain (handleWsClientMessage in orb-live.ts)
 * and to getUserContextSummary's fetch batch (user-context-profiler.ts).
 *
 * Before this fix, a slow/hung Supabase call anywhere in that chain could
 * block the whole handler forever — the client never got its "ready" ack
 * and the ORB UI sat on "connecting..." indefinitely. Both withBootstrapTimeout
 * and withProfilerTimeout race the real call against a timeout and resolve
 * with a caller-supplied fallback instead of hanging, so this test verifies:
 *   1. the real value wins when it resolves before the timeout (no behavior
 *      change in the common/healthy case)
 *   2. the fallback wins (and the call never hangs past the cap) when the
 *      real promise is slower than the timeout
 *   3. the fallback wins when the real promise rejects
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';

jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

jest.mock('../src/services/orb-memory-bridge', () => ({
  writeMemoryItemWithIdentity: jest.fn().mockResolvedValue({ ok: true }),
  // constants used elsewhere in orb-live — stub them so the module loads
  DEV_IDENTITY: { USER_ID: '00000000-0000-0000-0000-000000000099', TENANT_ID: '00000000-0000-0000-0000-000000000001' },
  isMemoryBridgeEnabled: () => false,
  isDevSandbox: () => false,
}));

import { withBootstrapTimeout } from '../src/routes/orb-live';
import { withProfilerTimeout } from '../src/services/user-context-profiler';

function delay<T>(value: T, ms: number): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

describe('BOOTSTRAP-ORB-CONNECT-HANG: withBootstrapTimeout (orb-live.ts native-WS bootstrap gate)', () => {
  it('resolves with the real value when it settles before the timeout', async () => {
    const result = await withBootstrapTimeout(delay('real-context', 5), 'fallback-context', 'label', 200);
    expect(result).toBe('real-context');
  });

  it('resolves with the fallback (not hanging) when the real call is slower than the cap', async () => {
    const start = Date.now();
    const result = await withBootstrapTimeout(delay('too-slow', 500), 'fallback-context', 'label', 50);
    const elapsed = Date.now() - start;
    expect(result).toBe('fallback-context');
    // Must return around the cap, not wait for the slow promise (500ms).
    expect(elapsed).toBeLessThan(400);
  });

  it('resolves with the fallback when the real call rejects', async () => {
    const rejecting = Promise.reject(new Error('supabase down'));
    const result = await withBootstrapTimeout(rejecting, 'fallback-context', 'label', 200);
    expect(result).toBe('fallback-context');
  });
});

describe('BOOTSTRAP-ORB-CONNECT-HANG: withProfilerTimeout (user-context-profiler.ts fetch gate)', () => {
  it('resolves with the real value when it settles before the timeout', async () => {
    const result = await withProfilerTimeout(delay({ ok: true }, 5), { ok: false }, 'label');
    expect(result).toEqual({ ok: true });
  });

  it('resolves with the fallback (not hanging) when the real call is slower than the cap', async () => {
    const previousTimeout = process.env.USER_CONTEXT_PROFILER_TIMEOUT_MS;
    process.env.USER_CONTEXT_PROFILER_TIMEOUT_MS = '50';
    jest.resetModules();
    const { withProfilerTimeout: withProfilerTimeoutFreshEnv } = await import('../src/services/user-context-profiler');
    try {
      const start = Date.now();
      const result = await withProfilerTimeoutFreshEnv(delay({ ok: true }, 500), { ok: false }, 'label');
      const elapsed = Date.now() - start;
      expect(result).toEqual({ ok: false });
      expect(elapsed).toBeLessThan(400);
    } finally {
      if (previousTimeout === undefined) delete process.env.USER_CONTEXT_PROFILER_TIMEOUT_MS;
      else process.env.USER_CONTEXT_PROFILER_TIMEOUT_MS = previousTimeout;
    }
  });

  it('resolves with the fallback when the real call rejects', async () => {
    const rejecting = Promise.reject(new Error('supabase down'));
    const result = await withProfilerTimeout(rejecting, { ok: false }, 'label');
    expect(result).toEqual({ ok: false });
  });
});
