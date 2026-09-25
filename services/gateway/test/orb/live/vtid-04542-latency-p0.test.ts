/**
 * VTID-04542 — ORB voice latency P0 (measurement only).
 *
 * Unit tests for the pure measurement primitives:
 *   - LatencyTracker: the new greeting phases, setMeta, setSessionStart.
 *   - deriveLatencyEntry (mobile / desktop / command_hub).
 *   - resolveLatencyProviderLabel (the cascade mislabel fix).
 *   - SessionStartTimer.
 *   - startWaitProbe (timed_out without rewriting the race).
 *   - the turn-0 attach / finalize / dispatch helpers.
 *   - persona hand-off timing (voice.latency.handoff).
 *   - prewarm miss reasons.
 */

import { isFeatureLive } from '../../../src/services/feature-flags';
import { emitOasisEvent } from '../../../src/services/oasis-event-service';

jest.mock('../../../src/services/feature-flags', () => ({
  isFeatureLive: jest.fn(),
}));
jest.mock('../../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

const mockIsFeatureLive = isFeatureLive as jest.MockedFunction<typeof isFeatureLive>;
const mockEmit = emitOasisEvent as jest.MockedFunction<typeof emitOasisEvent>;

import { LatencyTracker } from '../../../src/orb/live/latency-tracker';
import {
  deriveLatencyEntry,
  resolveLatencyProviderLabel,
  SessionStartTimer,
  startWaitProbe,
  attachEstablishLatencyContext,
  prepareEstablishLatencyFinalize,
  markGreetingDispatched,
} from '../../../src/orb/live/latency-context';
import {
  notePersonaSwapRequested,
  notePersonaSwapDrained,
  notePersonaSwapConnectStarted,
  notePersonaSwapConnected,
  notePersonaSwapFirstAudio,
  buildHandoffLatencyPayload,
} from '../../../src/orb/live/persona-swap-latency';
import { NOVA_SONIC_MODEL_ID } from '../../../src/orb/live/upstream/nova-sonic-config';
import { VERTEX_LIVE_MODEL } from '../../../src/orb/live/protocol';

function lastPayload(): Record<string, any> {
  const calls = mockEmit.mock.calls;
  return calls[calls.length - 1][0].payload as Record<string, any>;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsFeatureLive.mockReturnValue(true);
});

describe('LatencyTracker — VTID-04542 additions', () => {
  it('records the new greeting phases with their detail, in order', async () => {
    const t = new LatencyTracker({ session_id: 's', surface: 'voice', turn: 0 });
    t.mark('greeting_sent', { deferred: false });
    t.mark('greeting_facts_awaited', { ms: 12, timed_out: false });
    t.mark('greeting_gather_awaited', { kind: 'newday', ms: 800, timed_out: false });
    t.mark('greeting_ledger_awaited', { ms: 800, timed_out: true });
    t.mark('greeting_dispatched', { wake_opener: 'conv_resume', directive_chars: 420, path: 'safe_fast' });
    t.mark('audio_out_first_chunk', { source: 'greeting' });
    await t.finalize('success');
    const phases = lastPayload().phases as Array<{ phase: string; detail?: any }>;
    expect(phases.map((p) => p.phase)).toEqual([
      'greeting_sent',
      'greeting_facts_awaited',
      'greeting_gather_awaited',
      'greeting_ledger_awaited',
      'greeting_dispatched',
      'audio_out_first_chunk',
    ]);
    expect(phases[2].detail).toEqual({ kind: 'newday', ms: 800, timed_out: false });
    expect(phases[4].detail).toEqual({ wake_opener: 'conv_resume', directive_chars: 420, path: 'safe_fast' });
  });

  it('setMeta merges top-level fields, and core fields win on a clash', async () => {
    const t = new LatencyTracker({ session_id: 'real', surface: 'voice', turn: 0 });
    t.setMeta({ entry: 'mobile', surface: 'community' });
    t.setMeta({ greeting_rung: 'conv_resume', session_id: 'spoofed', total_ms: -1 });
    await t.finalize('success');
    const p = lastPayload();
    expect(p.entry).toBe('mobile');
    expect(p.greeting_rung).toBe('conv_resume');
    expect(p.session_id).toBe('real');
    expect(p.surface).toBe('voice'); // the tracker's own surface field wins
    expect(p.total_ms).toBeGreaterThanOrEqual(0);
  });

  it('setSessionStart emits a session_start block with the offset to tracker start', async () => {
    const now = Date.now();
    const t = new LatencyTracker({ session_id: 's', surface: 'voice', turn: 0 });
    t.setSessionStart({
      started_at_ms: now - 1500,
      total_ms: 900,
      steps: [{ step: 'resolve_identity', offset_ms: 5, ms: 40 }],
    });
    await t.finalize('success');
    const block = lastPayload().session_start;
    expect(block.total_ms).toBe(900);
    expect(block.steps).toEqual([{ step: 'resolve_identity', offset_ms: 5, ms: 40 }]);
    expect(block.tracker_start_offset_ms).toBeGreaterThanOrEqual(1500);
  });

  it('no session_start block when none was attached', async () => {
    const t = new LatencyTracker({ session_id: 's', surface: 'voice' });
    await t.finalize('success');
    expect(lastPayload()).not.toHaveProperty('session_start');
  });

  it('flag off: marks, meta and session start are all no-ops and nothing is emitted', async () => {
    mockIsFeatureLive.mockReturnValue(false);
    const t = new LatencyTracker({ session_id: 's', surface: 'voice' });
    t.mark('greeting_dispatched', { path: 'ladder' });
    t.setMeta({ entry: 'desktop' });
    t.setSessionStart({ started_at_ms: 1, total_ms: 1, steps: [] });
    await t.finalize('success');
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('finalize never throws when the OASIS write rejects', async () => {
    mockEmit.mockRejectedValueOnce(new Error('boom'));
    const t = new LatencyTracker({ session_id: 's', surface: 'voice' });
    await expect(t.finalize('success')).resolves.toBeUndefined();
  });
});

describe('deriveLatencyEntry', () => {
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
  const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';
  const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/120 Safari/537.36';

  it('origin containing "gateway" → command_hub, even with a mobile UA', () => {
    expect(deriveLatencyEntry({ origin: 'https://gateway.vitanaland.com', userAgent: IPHONE })).toBe('command_hub');
    expect(deriveLatencyEntry({ origin: 'https://preview-aws-gateway.vitanaland.com', userAgent: MAC })).toBe('command_hub');
  });

  it('falls back to the Referer when Origin is absent', () => {
    expect(deriveLatencyEntry({ referer: 'https://gateway.vitanaland.com/command-hub/', userAgent: MAC })).toBe('command_hub');
  });

  it('mobile user agents → mobile', () => {
    expect(deriveLatencyEntry({ origin: 'https://vitanaland.com', userAgent: IPHONE })).toBe('mobile');
    expect(deriveLatencyEntry({ origin: 'https://vitanaland.com', userAgent: ANDROID })).toBe('mobile');
  });

  it('everything else → desktop, including missing headers', () => {
    expect(deriveLatencyEntry({ origin: 'https://vitanaland.com', userAgent: MAC })).toBe('desktop');
    expect(deriveLatencyEntry({})).toBe('desktop');
    expect(deriveLatencyEntry({ origin: null, referer: null, userAgent: null })).toBe('desktop');
  });
});

describe('resolveLatencyProviderLabel', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('nova_sonic → nova_sonic/<model>', () => {
    expect(resolveLatencyProviderLabel({ upstreamProvider: 'nova_sonic', lang: 'de' }))
      .toBe(`nova_sonic/${NOVA_SONIC_MODEL_ID}`);
  });

  it('cascaded → cascade/polly for a Polly-backed cascade language (was vertex/…)', () => {
    const label = resolveLatencyProviderLabel({ upstreamProvider: 'cascaded', lang: 'ru' });
    expect(label).toBe('cascade/polly');
    expect(label).not.toMatch(/^vertex/);
  });

  it('cascaded with no TTS backend for the language → cascade/unknown, never vertex', () => {
    delete process.env.TTS_FISH_FALLBACK_ENABLED;
    delete process.env.FISH_API_KEY;
    expect(resolveLatencyProviderLabel({ upstreamProvider: 'cascaded', lang: 'sr' })).toBe('cascade/unknown');
  });

  it('vertex only when the session is really on Vertex, with the live model', () => {
    expect(resolveLatencyProviderLabel({ upstreamProvider: 'vertex', lang: 'sr' }))
      .toBe(`vertex/${VERTEX_LIVE_MODEL}`);
    expect(resolveLatencyProviderLabel({ upstreamProvider: 'vertex' })).not.toContain('gemini-2.0-flash-exp');
  });

  it('unset provider → unknown (no guessed vertex label)', () => {
    expect(resolveLatencyProviderLabel({})).toBe('unknown');
    expect(resolveLatencyProviderLabel({ upstreamProvider: null })).toBe('unknown');
  });
});

describe('SessionStartTimer', () => {
  it('records step offsets and durations from handler entry', () => {
    let clock = 1_000;
    const t = new SessionStartTimer(() => clock);
    clock = 1_010; const a = clock;
    clock = 1_050; t.step('resolve_identity', a);
    const b = clock;
    clock = 1_300; t.step('context_kickoff', b);
    clock = 1_320;
    const done = t.finish();
    expect(done.started_at_ms).toBe(1_000);
    expect(done.total_ms).toBe(320);
    expect(done.steps).toEqual([
      { step: 'resolve_identity', offset_ms: 10, ms: 40 },
      { step: 'context_kickoff', offset_ms: 50, ms: 250 },
    ]);
  });
});

describe('startWaitProbe', () => {
  it('timed_out=false when the awaited promise wins the race', async () => {
    const p = Promise.resolve('facts');
    const probe = startWaitProbe(p);
    await Promise.race([p, new Promise((r) => setTimeout(r, 1000))]);
    expect(probe().timed_out).toBe(false);
  });

  it('timed_out=true when the timeout wins the race', async () => {
    let resolveSlow!: () => void;
    const slow = new Promise<void>((r) => { resolveSlow = r; });
    const probe = startWaitProbe(slow);
    await Promise.race([slow, new Promise<void>((r) => setTimeout(r, 5))]);
    const result = probe();
    expect(result.timed_out).toBe(true);
    expect(result.ms).toBeGreaterThanOrEqual(0);
    resolveSlow();
  });

  it('a rejected promise counts as settled and is still visible to the race', async () => {
    const failing = Promise.reject(new Error('gather failed'));
    const probe = startWaitProbe(failing);
    const raced = await Promise.race([failing, new Promise((r) => setTimeout(r, 1000))]).catch(() => 'caught');
    expect(raced).toBe('caught');
    expect(probe().timed_out).toBe(false);
  });

  it('an absent promise (the code races Promise.resolve()) is never a timeout', () => {
    expect(startWaitProbe(undefined)().timed_out).toBe(false);
    expect(startWaitProbe(null)().timed_out).toBe(false);
  });
});

describe('turn-0 attach / finalize / dispatch helpers', () => {
  it('attach puts session_start + entry/surface/authenticated on the event', async () => {
    const tracker = new LatencyTracker({ session_id: 's', surface: 'voice', turn: 0 });
    const session: any = {
      establishLatency: tracker,
      sessionStartTiming: { started_at_ms: Date.now() - 50, total_ms: 30, steps: [] },
      latencyContext: { entry: 'mobile', surface: 'community', authenticated: true },
    };
    attachEstablishLatencyContext(session);
    await tracker.finalize('success');
    const p = lastPayload();
    expect(p.entry).toBe('mobile');
    expect(p.orb_surface).toBe('community');
    expect(p.surface).toBe('voice'); // the tracker's own field is untouched
    expect(p.authenticated).toBe(true);
    expect(p.session_start.total_ms).toBe(30);
  });

  it('finalize prep sets the real provider label, role, prewarm and rung', async () => {
    const tracker = new LatencyTracker({ session_id: 's', surface: 'voice', turn: 0, provider: 'vertex/x' });
    const session: any = {
      establishLatency: tracker,
      upstreamProvider: 'cascaded',
      lang: 'ru',
      active_role: 'community',
      latencyContext: { entry: 'desktop', surface: 'community', authenticated: true, prewarm_claimed: true },
    };
    markGreetingDispatched(session, { wake_opener: 'safe_fast_newday_overview', directive_chars: 1096, path: 'safe_fast' });
    prepareEstablishLatencyFinalize(session);
    await tracker.finalize('success');
    const p = lastPayload();
    expect(p.provider).toBe('cascade/polly');
    expect(p.active_role).toBe('community');
    expect(p.prewarm_claimed).toBe(true);
    expect(p.greeting_rung).toBe('safe_fast_newday_overview');
    expect(p.phases.map((x: any) => x.phase)).toContain('greeting_dispatched');
  });

  it('all helpers are no-ops (and never throw) without a tracker', () => {
    const session: any = { latencyContext: null };
    expect(() => attachEstablishLatencyContext(session)).not.toThrow();
    expect(() => prepareEstablishLatencyFinalize(session)).not.toThrow();
    expect(() => markGreetingDispatched(session, { path: 'ladder' })).not.toThrow();
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

describe('persona hand-off timing (voice.latency.handoff)', () => {
  it('reconnect mode: emits once, after the new upstream connected, with every leg', () => {
    const session: any = { sessionId: 'sess-1', activePersona: 'vitana', identity: { user_id: 'u1' } };
    notePersonaSwapRequested(session, 'devon', 1_000);
    // The old persona's bridge sentence starts speaking before the drain —
    // that audio must NOT close the hand-off.
    notePersonaSwapFirstAudio(session, 'nova_sonic/m', 1_100);
    expect(mockEmit).not.toHaveBeenCalled();
    notePersonaSwapDrained(session, 'reconnect', 2_500);
    notePersonaSwapConnectStarted(session, 2_550);
    // Audio before the reconnect finished is still not the new persona.
    notePersonaSwapFirstAudio(session, 'nova_sonic/m', 2_600);
    expect(mockEmit).not.toHaveBeenCalled();
    notePersonaSwapConnected(session, 3_400);
    notePersonaSwapFirstAudio(session, 'nova_sonic/m', 4_200);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    const call = mockEmit.mock.calls[0][0];
    expect(call.type).toBe('voice.latency.handoff');
    expect(call.actor_id).toBe('u1');
    expect(call.payload).toEqual(expect.objectContaining({
      session_id: 'sess-1',
      from_persona: 'vitana',
      to_persona: 'devon',
      provider: 'nova_sonic/m',
      mode: 'reconnect',
      swap_to_first_audio_ms: 3_200,
      drain_ms: 1_500,
      connect_ms: 850,
      reconnect_to_first_audio_ms: 800,
    }));
    // Cleared: a later speaking turn does not emit again.
    notePersonaSwapFirstAudio(session, 'nova_sonic/m', 9_000);
    expect(mockEmit).toHaveBeenCalledTimes(1);
  });

  it('in-process mode (cascade): no connect leg', () => {
    const session: any = { sessionId: 'sess-2', activePersona: 'devon' };
    notePersonaSwapRequested(session, 'vitana', 0);
    notePersonaSwapDrained(session, 'in_process', 300);
    notePersonaSwapFirstAudio(session, 'cascade/polly', 1_300);
    const payload = mockEmit.mock.calls[0][0].payload as any;
    expect(payload.mode).toBe('in_process');
    expect(payload.connect_ms).toBeNull();
    expect(payload.drain_ms).toBe(300);
    expect(payload.swap_to_first_audio_ms).toBe(1_300);
    expect(payload.from_persona).toBe('devon');
  });

  it('a rejected OASIS write never throws out of the hand-off hook', () => {
    mockEmit.mockRejectedValueOnce(new Error('down'));
    const session: any = { sessionId: 's3' };
    notePersonaSwapRequested(session, 'devon', 0);
    notePersonaSwapDrained(session, 'in_process', 1);
    expect(() => notePersonaSwapFirstAudio(session, 'x', 2)).not.toThrow();
  });

  it('first audio with no swap in flight is a no-op', () => {
    notePersonaSwapFirstAudio({ sessionId: 'x' }, 'nova', 5);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('buildHandoffLatencyPayload is pure and ISO-stamps the request', () => {
    const p = buildHandoffLatencyPayload('s', {
      from_persona: 'vitana', to_persona: 'devon', requested_at_ms: 0, mode: 'reconnect',
      drained_at_ms: 10, connect_started_at_ms: 20, connected_at_ms: 70,
    }, 'nova', 100);
    expect(p.swap_requested_at).toBe(new Date(0).toISOString());
    expect(p.connect_ms).toBe(50);
    expect(p.reconnect_to_first_audio_ms).toBe(30);
  });
});

describe('VTID-04542 × VTID-04544 — wait marks on the concurrent greeting reads', () => {
  const { timeBoundedGreetingRead, withLedgerWaitMark } = require('../../../src/orb/live/latency-context');

  it('timeBoundedGreetingRead passes the value through and marks timed_out from the read\'s own timeout branch', async () => {
    const marks: any[] = [];
    let t = 0;
    const v1 = await timeBoundedGreetingRead(async () => 'x', (w: any) => marks.push(w), () => (t += 5));
    const v2 = await timeBoundedGreetingRead(async (onTimeout: () => void) => { onTimeout(); return null; }, (w: any) => marks.push(w), () => (t += 5));
    expect(v1).toBe('x');
    expect(v2).toBeNull();
    expect(marks.map((m) => m.timed_out)).toEqual([false, true]);
    expect(marks.every((m) => m.ms >= 0)).toBe(true);
  });

  it('a throwing mark never reaches the caller', async () => {
    await expect(timeBoundedGreetingRead(async () => 1, () => { throw new Error('x'); })).resolves.toBe(1);
  });

  it('withLedgerWaitMark marks only on consume, with timed_out = read not settled', async () => {
    const marks: any[] = [];
    let settled = false;
    const wrapped = withLedgerWaitMark({ consume: async () => 'L', readSettled: () => settled }, (w: any) => marks.push(w));
    expect(marks).toHaveLength(0);
    expect(await wrapped.consume()).toBe('L');
    settled = true;
    await wrapped.consume();
    expect(marks.map((m) => m.timed_out)).toEqual([true, false]);
  });
});
