/**
 * L2.1 (VTID-02980): `livekit-canary-config` unit tests.
 *
 * Most of the helper's logic is the env-flag parser + the JSONB allowlist
 * coercion. The DB-read branch is exercised via the mocked Supabase client
 * shared by the rest of the orb suite (`test/__mocks__/setup-tests.ts`).
 * The tests below focus on the pure shape coercion + env override + the
 * graceful-degradation contract (DB read failure → `enabled:false`).
 */

import {
  getLiveKitCanaryConfig,
  invalidateLiveKitCanaryConfigCache,
} from '../../../../src/orb/live/upstream/livekit-canary-config';

const ORIGINAL_ENV = { ...process.env };

function resetEnv(): void {
  delete process.env.ORB_LIVEKIT_CANARY_ENABLED;
}

beforeEach(() => {
  invalidateLiveKitCanaryConfigCache();
  resetEnv();
});

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('L2.1 getLiveKitCanaryConfig — env handling', () => {
  it('ORB_LIVEKIT_CANARY_ENABLED unset → enabled=false', async () => {
    const cfg = await getLiveKitCanaryConfig(process.env, true);
    expect(cfg.enabled).toBe(false);
  });

  it('ORB_LIVEKIT_CANARY_ENABLED=true → enabled=true', async () => {
    process.env.ORB_LIVEKIT_CANARY_ENABLED = 'true';
    const cfg = await getLiveKitCanaryConfig(process.env, true);
    expect(cfg.enabled).toBe(true);
  });

  it('ORB_LIVEKIT_CANARY_ENABLED=1 / yes / TRUE / Yes / TRUE  → enabled=true', async () => {
    for (const v of ['1', 'yes', 'TRUE', 'Yes', '  TRUE  ']) {
      process.env.ORB_LIVEKIT_CANARY_ENABLED = v;
      invalidateLiveKitCanaryConfigCache();
      const cfg = await getLiveKitCanaryConfig(process.env, true);
      expect(cfg.enabled).toBe(true);
    }
  });

  it('ORB_LIVEKIT_CANARY_ENABLED=false / 0 / off / "" → enabled=false', async () => {
    for (const v of ['false', '0', 'off', '']) {
      process.env.ORB_LIVEKIT_CANARY_ENABLED = v;
      invalidateLiveKitCanaryConfigCache();
      const cfg = await getLiveKitCanaryConfig(process.env, true);
      expect(cfg.enabled).toBe(false);
    }
  });

  it('returns empty allowlists by default (no system_config rows / mocked Supabase)', async () => {
    const cfg = await getLiveKitCanaryConfig(process.env, true);
    expect(cfg.allowedTenants).toEqual([]);
    expect(cfg.allowedUsers).toEqual([]);
  });

  it('NEVER throws — even with garbage env values', async () => {
    // @ts-expect-error — testing runtime tolerance
    process.env.ORB_LIVEKIT_CANARY_ENABLED = 42 as unknown as string;
    await expect(getLiveKitCanaryConfig(process.env, true)).resolves.toBeTruthy();
  });
});
