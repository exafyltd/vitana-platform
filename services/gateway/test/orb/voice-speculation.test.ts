/**
 * BOOTSTRAP-VOICE-LATENCY-SPECULATION — voice establishment speculation.
 *
 * Covers the pure timing/guard logic and the flag-OFF no-op contract for the
 * speculative persona-voice resolver (orb/live/voice-speculation.ts). The
 * speculation moves the persona-voice registry lookup off the turn-0 critical
 * path by running it in parallel with the upstream WS handshake.
 *
 * Contract under test:
 *   - shouldSpeculateVoice: pure guard (feature live + persona present).
 *   - computeSpeculationSavingsMs: pure, non-negative clamped arithmetic.
 *   - beginVoiceSpeculation: null when OFF (caller takes inline path); a
 *     non-rejecting handle when ON.
 *   - consumeSpeculatedVoice: null handle → undefined (inline fallback);
 *     resolves to the speculated value and emits a comparison telemetry.
 */

process.env.NODE_ENV = 'test';

import {
  shouldSpeculateVoice,
  computeSpeculationSavingsMs,
  beginVoiceSpeculation,
  consumeSpeculatedVoice,
  VOICE_SPECULATION_FEATURE,
  VOICE_SPECULATION_VTID,
} from '../../src/orb/live/voice-speculation';
import { isFeatureLive } from '../../src/services/feature-flags';
import { emitOasisEvent } from '../../src/services/oasis-event-service';

jest.mock('../../src/services/feature-flags', () => ({
  isFeatureLive: jest.fn(),
}));
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

const mockIsFeatureLive = isFeatureLive as jest.MockedFunction<typeof isFeatureLive>;
const mockEmit = emitOasisEvent as jest.MockedFunction<typeof emitOasisEvent>;

beforeEach(() => {
  mockIsFeatureLive.mockReset();
  mockEmit.mockReset();
  mockEmit.mockResolvedValue({ ok: true } as any);
});

describe('shouldSpeculateVoice — pure guard', () => {
  test('false when feature not live, even with a persona', () => {
    expect(shouldSpeculateVoice({ persona: 'vitana' }, false)).toBe(false);
  });

  test('false when persona is empty/blank, even when feature live', () => {
    expect(shouldSpeculateVoice({ persona: '' }, true)).toBe(false);
    expect(shouldSpeculateVoice({ persona: '   ' }, true)).toBe(false);
  });

  test('true only when feature live AND persona present', () => {
    expect(shouldSpeculateVoice({ persona: 'vitana' }, true)).toBe(true);
  });
});

describe('computeSpeculationSavingsMs — pure arithmetic', () => {
  test('saved = baseline - residual when positive', () => {
    expect(computeSpeculationSavingsMs(10, 2)).toBe(8);
  });

  test('clamps to 0 when residual exceeds baseline (no negative win)', () => {
    expect(computeSpeculationSavingsMs(5, 20)).toBe(0);
  });

  test('0 when residual equals baseline', () => {
    expect(computeSpeculationSavingsMs(7, 7)).toBe(0);
  });

  test('rounds fractional savings', () => {
    expect(computeSpeculationSavingsMs(10.7, 2.1)).toBe(9); // 8.6 → 9
  });
});

describe('beginVoiceSpeculation — flag OFF (no-op)', () => {
  test('returns null when feature is off, resolver never invoked', () => {
    mockIsFeatureLive.mockReturnValue(false);
    const resolver = jest.fn().mockResolvedValue('VoiceX');
    const handle = beginVoiceSpeculation(
      { session_id: 's1', persona: 'vitana' },
      resolver,
    );
    expect(handle).toBeNull();
    expect(resolver).not.toHaveBeenCalled();
    expect(mockIsFeatureLive).toHaveBeenCalledWith(VOICE_SPECULATION_FEATURE);
  });

  test('returns null when persona missing even if flag on', () => {
    mockIsFeatureLive.mockReturnValue(true);
    const resolver = jest.fn();
    const handle = beginVoiceSpeculation(
      { session_id: 's1', persona: '' },
      resolver,
    );
    expect(handle).toBeNull();
    expect(resolver).not.toHaveBeenCalled();
  });
});

describe('beginVoiceSpeculation — flag ON', () => {
  test('returns a handle and kicks the resolver off immediately', async () => {
    mockIsFeatureLive.mockReturnValue(true);
    const resolver = jest.fn().mockResolvedValue('Aoede');
    const handle = beginVoiceSpeculation(
      { session_id: 's1', persona: 'vitana', tenant_id: 't1', provider: 'vertex/m' },
      resolver,
    );
    expect(handle).not.toBeNull();
    // Resolver is kicked off via a microtask (Promise.resolve().then) so its
    // rejection is isolated; it has run by the time the handle promise settles.
    await expect(handle!.promise).resolves.toBe('Aoede');
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  test('handle promise never rejects — resolver failure becomes undefined', async () => {
    mockIsFeatureLive.mockReturnValue(true);
    const resolver = jest.fn().mockRejectedValue(new Error('registry down'));
    const handle = beginVoiceSpeculation(
      { session_id: 's1', persona: 'vitana' },
      resolver,
    );
    await expect(handle!.promise).resolves.toBeUndefined();
  });
});

describe('consumeSpeculatedVoice', () => {
  test('null handle → undefined (inline fallback), no telemetry', async () => {
    const voice = await consumeSpeculatedVoice(null, 8);
    expect(voice).toBeUndefined();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  test('returns the speculated voice and emits a comparison telemetry', async () => {
    mockIsFeatureLive.mockReturnValue(true);
    const resolver = jest.fn().mockResolvedValue('Puck');
    const handle = beginVoiceSpeculation(
      { session_id: 's9', persona: 'vitana', tenant_id: 't1', provider: 'vertex/gemini', actor_id: 'u1' },
      resolver,
    );
    const voice = await consumeSpeculatedVoice(handle, 8);
    expect(voice).toBe('Puck');

    expect(mockEmit).toHaveBeenCalledTimes(1);
    const evt = mockEmit.mock.calls[0][0];
    expect(evt.vtid).toBe(VOICE_SPECULATION_VTID);
    expect(evt.type).toBe('voice.latency.measured');
    expect(evt.actor_id).toBe('u1');
    const p = evt.payload as Record<string, unknown>;
    expect(p.speculation).toBe(true);
    expect(p.step).toBe('persona_voice_resolve');
    expect(p.surface).toBe('voice');
    expect(p.turn).toBe(0);
    expect(p.resolved).toBe(true);
    expect(p.inline_baseline_ms).toBe(8);
    expect(typeof p.saved_ms).toBe('number');
    expect(p.tenant_scoped).toBe(true);
  });

  test('uses an injectable clock so the savings are deterministic', async () => {
    mockIsFeatureLive.mockReturnValue(true);
    // Resolver already settled before consume is called.
    const resolver = jest.fn().mockResolvedValue('Charon');

    // Clock: begin@1000; consume awaits an already-resolved promise so the
    // residual window collapses to a single tick. Sequence: started_ms=1000,
    // awaitStart=1000, after-await=1000, total=1000 → residual 0, saved=baseline.
    let t = 1000;
    const clock = () => t;
    const handle = beginVoiceSpeculation(
      { session_id: 's-clock', persona: 'vitana' },
      resolver,
      clock,
    );
    const voice = await consumeSpeculatedVoice(handle, 12, clock);
    expect(voice).toBe('Charon');
    const p = mockEmit.mock.calls[0][0].payload as Record<string, unknown>;
    expect(p.speculative_residual_ms).toBe(0);
    expect(p.saved_ms).toBe(12); // full baseline hidden behind overlap
  });

  test('resolved=false telemetry when the speculative lookup returned nothing', async () => {
    mockIsFeatureLive.mockReturnValue(true);
    const resolver = jest.fn().mockResolvedValue(undefined);
    const handle = beginVoiceSpeculation(
      { session_id: 's-empty', persona: 'vitana' },
      resolver,
    );
    const voice = await consumeSpeculatedVoice(handle, 8);
    expect(voice).toBeUndefined(); // caller falls back to inline lookup
    const p = mockEmit.mock.calls[0][0].payload as Record<string, unknown>;
    expect(p.resolved).toBe(false);
  });

  test('telemetry failure never throws on the consume path', async () => {
    mockIsFeatureLive.mockReturnValue(true);
    mockEmit.mockRejectedValue(new Error('oasis down'));
    const resolver = jest.fn().mockResolvedValue('Kore');
    const handle = beginVoiceSpeculation(
      { session_id: 's-telemfail', persona: 'vitana' },
      resolver,
    );
    await expect(consumeSpeculatedVoice(handle, 8)).resolves.toBe('Kore');
  });
});
