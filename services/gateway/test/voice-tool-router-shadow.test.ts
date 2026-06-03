/**
 * Phase 1 W2 (BOOTSTRAP-PHASE1-W2-SHADOW-RUNTIME-WIRE) — shadow wire unit tests.
 *
 * Verifies the contract the auto-promoter depends on:
 *   - When FEATURE_SHADOW_TOOL_ROUTER is OFF, the candidate is never invoked
 *     and no eval.shadow.compared event is emitted (zero overhead).
 *   - When ON, primary is returned to the caller unchanged, the candidate runs
 *     fire-and-forget, and exactly one eval.shadow.compared event is emitted with
 *     primary_key / candidate_key / agreement / latencies.
 *   - The W2 candidate stub echoes the primary tool (agreement trivially true).
 */

process.env.NODE_ENV = 'test';

jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../src/services/feature-flags', () => ({
  isFeatureLive: jest.fn(),
}));

import { runWithShadow, runWithShadowAwaitable } from '../src/services/llm-router-shadow';
import { predictVoiceToolRoute } from '../src/services/voice-tool-router-candidate';
import { emitOasisEvent } from '../src/services/oasis-event-service';
import { isFeatureLive } from '../src/services/feature-flags';

const mockEmit = emitOasisEvent as jest.Mock;
const mockFlag = isFeatureLive as jest.Mock;

/** Let the fire-and-forget candidate IIFE drain its microtasks. */
async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  mockEmit.mockClear();
  mockFlag.mockReset();
});

describe('predictVoiceToolRoute (W2 stub)', () => {
  test('echoes the primary tool name', async () => {
    await expect(
      predictVoiceToolRoute({ transcript: 'remind me to drink water', primaryTool: 'set_reminder' }),
    ).resolves.toBe('set_reminder');
  });
});

describe('runWithShadow — flag OFF', () => {
  test('returns primary, never invokes candidate, emits nothing', async () => {
    mockFlag.mockReturnValue(false);
    const candidate = jest.fn(async () => 'set_reminder');

    const result = await runWithShadow<{ t: string }, string>({
      feature: 'voice-tool-router',
      input: { t: 'x' },
      primary: async () => 'search_calendar',
      candidate,
      extractKey: (t) => t,
    });
    await flush();

    expect(result).toBe('search_calendar');
    expect(candidate).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

describe('runWithShadow — flag ON', () => {
  test('returns primary unchanged and emits eval.shadow.compared with agreement', async () => {
    mockFlag.mockReturnValue(true);
    const candidate = jest.fn(async () => 'set_reminder');

    const result = await runWithShadow<{ t: string }, string>({
      feature: 'voice-tool-router',
      input: { t: 'remind me' },
      primary: async () => 'set_reminder',
      candidate,
      extractKey: (t) => t,
      context: { actor_id: 'u-1', session_id: 's-1' },
    });
    await flush();

    expect(result).toBe('set_reminder');
    expect(candidate).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledTimes(1);

    const evt = mockEmit.mock.calls[0][0];
    expect(evt.type).toBe('eval.shadow.compared');
    expect(evt.payload.feature).toBe('voice-tool-router');
    expect(evt.payload.primary_key).toBe('set_reminder');
    expect(evt.payload.candidate_key).toBe('set_reminder');
    expect(evt.payload.agreement).toBe(true);
    expect(typeof evt.payload.primary_ms).toBe('number');
    expect(typeof evt.payload.candidate_ms).toBe('number');
  });

  test('records disagreement when candidate diverges', async () => {
    mockFlag.mockReturnValue(true);

    await runWithShadow<{ t: string }, string>({
      feature: 'voice-tool-router',
      input: { t: 'x' },
      primary: async () => 'set_reminder',
      candidate: async () => 'search_calendar',
      extractKey: (t) => t,
    });
    await flush();

    const evt = mockEmit.mock.calls[0][0];
    expect(evt.payload.agreement).toBe(false);
  });
});

/**
 * BOOTSTRAP-EVAL-SHADOW-EMIT — reliable-on-Cloud-Run awaitable variant.
 *
 * Root cause (W3-B0): the candidate + emit chain ran inside a detached
 * `void (async () => {…})()` IIFE. On Cloud Run with --min-instances=0 the
 * instance's CPU is de-allocated / scaled in right after the HTTP response is
 * sent, so the still-pending detached promise is dropped and the
 * eval.shadow.compared event never lands. These tests prove the emit is
 * awaitable so request handlers can flush it before returning the response.
 */
describe('runWithShadowAwaitable — flag ON', () => {
  test('returns primary immediately; shadowDone resolves after the awaited emit', async () => {
    mockFlag.mockReturnValue(true);
    const candidate = jest.fn(async () => 'set_reminder');

    const { result, shadowDone } = await runWithShadowAwaitable<{ t: string }, string>({
      feature: 'voice-tool-router',
      input: { t: 'remind me' },
      primary: async () => 'set_reminder',
      candidate,
      extractKey: (t) => t,
      context: { actor_id: 'u-1', session_id: 's-1' },
    });

    // Primary path is unaffected — result available before the emit completes.
    expect(result).toBe('set_reminder');

    // The key guarantee: awaiting shadowDone deterministically flushes the
    // emit. No setImmediate/flush hack — the caller can rely on this.
    await shadowDone;

    expect(candidate).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    const evt = mockEmit.mock.calls[0][0];
    expect(evt.type).toBe('eval.shadow.compared');
    expect(evt.payload.primary_key).toBe('set_reminder');
    expect(evt.payload.candidate_key).toBe('set_reminder');
    expect(evt.payload.agreement).toBe(true);
  });

  test('shadowDone never rejects even if the candidate throws', async () => {
    mockFlag.mockReturnValue(true);

    const { result, shadowDone } = await runWithShadowAwaitable<{ t: string }, string>({
      feature: 'voice-tool-router',
      input: { t: 'x' },
      primary: async () => 'set_reminder',
      candidate: async () => { throw new Error('candidate boom'); },
      extractKey: (t) => t,
    });

    expect(result).toBe('set_reminder');
    // Must resolve, not reject — awaiting it in a handler must be safe.
    await expect(shadowDone).resolves.toBeUndefined();

    // Candidate error is still recorded as a warning event.
    expect(mockEmit).toHaveBeenCalledTimes(1);
    const evt = mockEmit.mock.calls[0][0];
    expect(evt.status).toBe('warning');
    expect(evt.payload.candidate_error).toContain('candidate boom');
    expect(evt.payload.agreement).toBeNull();
  });

  test('shadowDone never rejects even if emitOasisEvent throws', async () => {
    mockFlag.mockReturnValue(true);
    mockEmit.mockRejectedValueOnce(new Error('oasis sink down'));

    const { shadowDone } = await runWithShadowAwaitable<{ t: string }, string>({
      feature: 'voice-tool-router',
      input: { t: 'x' },
      primary: async () => 'set_reminder',
      candidate: async () => 'set_reminder',
      extractKey: (t) => t,
    });

    // Emit failure is swallowed — the awaited chain still resolves cleanly so
    // it can never break the request handler.
    await expect(shadowDone).resolves.toBeUndefined();
    expect(mockEmit).toHaveBeenCalledTimes(1);
  });
});

describe('runWithShadowAwaitable — flag OFF', () => {
  test('returns primary, never invokes candidate, shadowDone is a no-op', async () => {
    mockFlag.mockReturnValue(false);
    const candidate = jest.fn(async () => 'set_reminder');

    const { result, shadowDone } = await runWithShadowAwaitable<{ t: string }, string>({
      feature: 'voice-tool-router',
      input: { t: 'x' },
      primary: async () => 'search_calendar',
      candidate,
      extractKey: (t) => t,
    });
    await shadowDone;

    expect(result).toBe('search_calendar');
    expect(candidate).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });
});
