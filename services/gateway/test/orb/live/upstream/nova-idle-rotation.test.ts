/**
 * BOOTSTRAP-NOVA-IDLE-ROTATION: the idle-deadline fail-safe.
 *
 * Bedrock enforces TWO deadlines on a bidirectional stream:
 *   - ~8 min wall-clock since connect  → covered by `rotationAfterMs` (435s)
 *   - ~295s since the last ACCEPTED input → covered by NOTHING, until now
 *
 * The production P0 was the second one: a healthy 10-turn session was killed
 * ~292s after its last input while the wall-clock rotation timer was still
 * 140s away. These tests pin the behavior of the watchdog that closes that
 * gap, and — most importantly — the input-accounting rules that decide when
 * it is allowed to fire.
 */

import {
  NovaSonicLiveClient,
  type NovaBedrockLike,
} from '../../../../src/orb/live/upstream/nova-sonic-live-client';
import { getNovaSonicConfig } from '../../../../src/orb/live/upstream/nova-sonic-config';
import type { UpstreamConnectOptions } from '../../../../src/orb/live/upstream/types';

/**
 * Bedrock's documented idle limit, from the live termination message:
 * "Timed out waiting for audio bytes or interactive content … less than 295
 * seconds". The fail-safe is only a fail-safe if it fires BEFORE this.
 */
const BEDROCK_IDLE_DEADLINE_MS = 295_000;

function baseOptions(overrides: Partial<UpstreamConnectOptions> = {}): UpstreamConnectOptions {
  return {
    model: 'amazon.nova-2-sonic-v1:0',
    voiceName: 'tina',
    responseModalities: ['audio'],
    vadSilenceMs: 2000,
    systemInstruction: 'You are Vitana.',
    connectTimeoutMs: 1000,
    ...overrides,
  };
}

class SilentBody implements AsyncIterable<{ chunk?: { bytes?: Uint8Array } }> {
  [Symbol.asyncIterator](): AsyncIterator<{ chunk?: { bytes?: Uint8Array } }> {
    // Never resolves — the stream stays open and produces nothing, which is
    // exactly the shape of the sessions that died in production.
    return { next: () => new Promise(() => {}) };
  }
}

function makeClient(env: Record<string, string> = {}, audioHighWaterMark?: number) {
  const config = getNovaSonicConfig({
    NOVA_SONIC_ENABLED: 'true',
    ...env,
  } as NodeJS.ProcessEnv);
  const bedrock: NovaBedrockLike = { send: async () => ({ body: new SilentBody() }) };
  const onIdleDeadlineApproaching = jest.fn();
  const onRotationDue = jest.fn();
  const client = new NovaSonicLiveClient({
    config,
    voiceId: 'tina',
    createBedrockClient: () => bedrock,
    createCommand: (input) => input,
    onRotationDue,
    onIdleDeadlineApproaching,
    audioHighWaterMark,
  });
  return { client, config, onIdleDeadlineApproaching, onRotationDue };
}

const SILENCE_FRAME = Buffer.alloc(640).toString('base64');

describe('nova idle-deadline config', () => {
  it('defaults to 240s — comfortably ahead of Bedrock’s ~295s idle kill', () => {
    const cfg = getNovaSonicConfig({ NOVA_SONIC_ENABLED: 'true' } as NodeJS.ProcessEnv);
    expect(cfg.idleRotationAfterMs).toBe(240_000);
    // The whole point of the value. If someone raises it past the deadline
    // the fail-safe silently stops being a fail-safe, so assert the relation
    // rather than just the number.
    expect(cfg.idleRotationAfterMs).toBeLessThan(BEDROCK_IDLE_DEADLINE_MS);
    // Enough headroom to open + validate + swap a replacement stream.
    expect(BEDROCK_IDLE_DEADLINE_MS - cfg.idleRotationAfterMs).toBeGreaterThanOrEqual(30_000);
  });

  it('is a DIFFERENT clock from the wall-clock rotation timer', () => {
    const cfg = getNovaSonicConfig({ NOVA_SONIC_ENABLED: 'true' } as NodeJS.ProcessEnv);
    // The bug: rotationAfterMs (435s) is past the idle deadline, so it can
    // never protect it. This asserts the two are not conflated again.
    expect(cfg.rotationAfterMs).toBeGreaterThan(BEDROCK_IDLE_DEADLINE_MS);
    expect(cfg.idleRotationAfterMs).toBeLessThan(cfg.rotationAfterMs);
  });

  it('honours NOVA_SONIC_IDLE_ROTATION_AFTER_MS and treats 0 as disabled', () => {
    const tuned = getNovaSonicConfig({
      NOVA_SONIC_ENABLED: 'true',
      NOVA_SONIC_IDLE_ROTATION_AFTER_MS: '120000',
    } as NodeJS.ProcessEnv);
    expect(tuned.idleRotationAfterMs).toBe(120_000);
    expect(tuned.ready).toBe(true);

    const off = getNovaSonicConfig({
      NOVA_SONIC_ENABLED: 'true',
      NOVA_SONIC_IDLE_ROTATION_AFTER_MS: '0',
    } as NodeJS.ProcessEnv);
    expect(off.idleRotationAfterMs).toBe(0);
    expect(off.ready).toBe(true);
  });

  it('fails readiness loudly on a malformed value instead of silently defaulting', () => {
    const bad = getNovaSonicConfig({
      NOVA_SONIC_ENABLED: 'true',
      NOVA_SONIC_IDLE_ROTATION_AFTER_MS: 'soon',
    } as NodeJS.ProcessEnv);
    expect(bad.issues).toContain('nova_idle_rotation_after_invalid');
    expect(bad.ready).toBe(false);
  });
});

describe('nova idle-deadline watchdog', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('fires when no input has been accepted for the configured window', async () => {
    const { client, onIdleDeadlineApproaching } = makeClient();
    await client.connect(baseOptions());
    expect(client.getState()).toBe('open');

    jest.advanceTimersByTime(239_000);
    expect(onIdleDeadlineApproaching).not.toHaveBeenCalled();

    jest.advanceTimersByTime(6_000);
    expect(onIdleDeadlineApproaching).toHaveBeenCalledTimes(1);
    expect(onIdleDeadlineApproaching.mock.calls[0][0].msSinceLastInput).toBeGreaterThanOrEqual(240_000);
  });

  it('fires with time to spare before Bedrock would kill the stream', async () => {
    const { client, onIdleDeadlineApproaching } = makeClient();
    await client.connect(baseOptions());

    jest.advanceTimersByTime(BEDROCK_IDLE_DEADLINE_MS);
    expect(onIdleDeadlineApproaching).toHaveBeenCalledTimes(1);
    // Fired strictly before the deadline, not merely by the deadline.
    const { msSinceLastInput } = onIdleDeadlineApproaching.mock.calls[0][0];
    expect(msSinceLastInput).toBeLessThan(BEDROCK_IDLE_DEADLINE_MS);
  });

  it('never fires while the silence keepalive is feeding frames', async () => {
    const { client, onIdleDeadlineApproaching } = makeClient();
    await client.connect(baseOptions());

    // The real keepalive cadence is 250ms; step well past the idle window.
    for (let elapsed = 0; elapsed < 400_000; elapsed += 10_000) {
      client.sendAudioChunk(SILENCE_FRAME, 'audio/pcm;rate=16000');
      jest.advanceTimersByTime(10_000);
    }
    // This is the healthy-session case: the fix must be invisible.
    expect(onIdleDeadlineApproaching).not.toHaveBeenCalled();
  });

  it('does NOT count a REFUSED audio frame as input', async () => {
    // The critical accounting rule. A backpressured frame never reached
    // Bedrock, so Bedrock's idle clock did not move. If the client stamped it
    // anyway, sustained backpressure would look like a healthy session right
    // up until Bedrock killed it — blinding the watchdog in one of the exact
    // situations it exists to catch.
    const { client, onIdleDeadlineApproaching } = makeClient({}, 1);
    await client.connect(baseOptions());

    // Overflow the high-water mark so every subsequent frame is refused.
    let refusedAtLeastOnce = false;
    for (let i = 0; i < 10; i++) {
      if (!client.sendAudioChunk(SILENCE_FRAME, 'audio/pcm;rate=16000')) refusedAtLeastOnce = true;
    }
    expect(refusedAtLeastOnce).toBe(true);

    // Keep offering frames that keep being refused, across the idle window.
    for (let elapsed = 0; elapsed < 250_000; elapsed += 10_000) {
      client.sendAudioChunk(SILENCE_FRAME, 'audio/pcm;rate=16000');
      jest.advanceTimersByTime(10_000);
    }
    expect(onIdleDeadlineApproaching).toHaveBeenCalled();
  });

  it('counts a tool result as interactive content and resets the clock', async () => {
    // Bedrock's own wording is "audio bytes OR interactive content" — a long
    // tool round-trip is what keeps some turns from looking idle.
    const { client, onIdleDeadlineApproaching } = makeClient();
    await client.connect(baseOptions());

    jest.advanceTimersByTime(200_000);
    client.sendToolResult({ callId: 'abc', success: true, output: '{"ok":true}' });
    jest.advanceTimersByTime(200_000 - 5_000);
    expect(onIdleDeadlineApproaching).not.toHaveBeenCalled();
  });

  it('signals ONCE per idle episode, not on every tick', async () => {
    const { client, onIdleDeadlineApproaching } = makeClient();
    await client.connect(baseOptions());

    jest.advanceTimersByTime(300_000);
    expect(onIdleDeadlineApproaching).toHaveBeenCalledTimes(1);
    // Without the one-shot latch this would stack a rotation attempt every
    // 5s tick for as long as the session stayed quiet.
    jest.advanceTimersByTime(300_000);
    expect(onIdleDeadlineApproaching).toHaveBeenCalledTimes(1);
  });

  it('re-arms after fresh input so a second idle episode is caught', async () => {
    // A session can go idle, rotate, converse, and go idle again — unlike the
    // wall-clock rotation, this one must not be fire-once-per-stream.
    const { client, onIdleDeadlineApproaching } = makeClient();
    await client.connect(baseOptions());

    jest.advanceTimersByTime(250_000);
    expect(onIdleDeadlineApproaching).toHaveBeenCalledTimes(1);

    client.sendAudioChunk(SILENCE_FRAME, 'audio/pcm;rate=16000');
    jest.advanceTimersByTime(250_000);
    expect(onIdleDeadlineApproaching).toHaveBeenCalledTimes(2);
  });

  it('stops after close — no callback on a dead stream', async () => {
    const { client, onIdleDeadlineApproaching } = makeClient();
    await client.connect(baseOptions());

    // close() clears the watchdog synchronously, then awaits a drain race
    // against a 1s timeout — which under fake timers only fires when we
    // advance them. Start the close, advance past the drain, then settle.
    const closing = client.close('user_stop');
    jest.advanceTimersByTime(2_000);
    await closing;
    expect(client.getState()).toBe('closed');

    jest.advanceTimersByTime(600_000);
    expect(onIdleDeadlineApproaching).not.toHaveBeenCalled();
  });

  it('is fully disabled when idleRotationAfterMs is 0', async () => {
    const { client, onIdleDeadlineApproaching } = makeClient({
      NOVA_SONIC_IDLE_ROTATION_AFTER_MS: '0',
    });
    await client.connect(baseOptions());

    jest.advanceTimersByTime(600_000);
    expect(onIdleDeadlineApproaching).not.toHaveBeenCalled();
  });

  it('starts the idle clock at connect, not at zero', async () => {
    // The init sequence (sessionStart → promptStart → system block →
    // audioContentStart) is real accepted input. Without stamping it, a
    // freshly-opened stream would read as 240s idle on the first tick.
    const { client, onIdleDeadlineApproaching } = makeClient();
    await client.connect(baseOptions());

    expect(client.getMsSinceLastAcceptedInput()).toBeLessThan(1_000);
    jest.advanceTimersByTime(6_000);
    expect(onIdleDeadlineApproaching).not.toHaveBeenCalled();
  });
});
