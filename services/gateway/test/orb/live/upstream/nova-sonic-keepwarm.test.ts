/**
 * BOOTSTRAP-NOVA-SONIC-VOICE (latency): keep-warm loop tests — the pooled
 * Bedrock HTTP/2 session must be re-warmed on the configured interval,
 * never pile up pings, and stop cleanly.
 */

import {
  isNovaKeepWarmRunning,
  startNovaSonicKeepWarm,
  stopNovaSonicKeepWarm,
} from '../../../../src/orb/live/upstream/nova-sonic-keepwarm';
import { getNovaSonicConfig } from '../../../../src/orb/live/upstream/nova-sonic-config';

const cfg = (keepWarmMs: string) =>
  getNovaSonicConfig({
    NOVA_SONIC_ENABLED: 'true',
    NOVA_SONIC_KEEPWARM_MS: keepWarmMs,
  } as NodeJS.ProcessEnv);

describe('startNovaSonicKeepWarm', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    stopNovaSonicKeepWarm();
    jest.useRealTimers();
  });

  it('keepWarmMs=0 disables the loop', () => {
    expect(startNovaSonicKeepWarm(cfg('0'), { warm: jest.fn(), log: jest.fn() })).toBe(false);
    expect(isNovaKeepWarmRunning()).toBe(false);
  });

  it('pings on the interval, re-arms, and logs typed outcomes only', async () => {
    const warm = jest.fn().mockResolvedValue(42);
    const log = jest.fn();
    expect(startNovaSonicKeepWarm(cfg('1000'), { warm, log })).toBe(true);
    expect(isNovaKeepWarmRunning()).toBe(true);
    expect(warm).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1000);
    expect(warm).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('keep-warm ok ms=42'));

    await jest.advanceTimersByTimeAsync(1000);
    expect(warm).toHaveBeenCalledTimes(2);
  });

  it('transport failure logs a retry line and keeps the loop alive', async () => {
    const warm = jest.fn().mockResolvedValue(null);
    const log = jest.fn();
    startNovaSonicKeepWarm(cfg('1000'), { warm, log });
    await jest.advanceTimersByTimeAsync(1000);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('transport failure'));
    await jest.advanceTimersByTimeAsync(1000);
    expect(warm).toHaveBeenCalledTimes(2);
  });

  it('is idempotent while running and stops cleanly', async () => {
    const warm = jest.fn().mockResolvedValue(10);
    startNovaSonicKeepWarm(cfg('1000'), { warm, log: jest.fn() });
    // Second start is a no-op — still one loop.
    expect(startNovaSonicKeepWarm(cfg('1000'), { warm: jest.fn(), log: jest.fn() })).toBe(true);
    await jest.advanceTimersByTimeAsync(1000);
    expect(warm).toHaveBeenCalledTimes(1);

    stopNovaSonicKeepWarm();
    expect(isNovaKeepWarmRunning()).toBe(false);
    await jest.advanceTimersByTimeAsync(5000);
    expect(warm).toHaveBeenCalledTimes(1);
  });
});
