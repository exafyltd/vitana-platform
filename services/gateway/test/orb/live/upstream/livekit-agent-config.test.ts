/**
 * L2.2a (VTID-02982): `livekit-agent-config` unit tests.
 *
 * The helper reads:
 *   - env  `ORB_LIVEKIT_AGENT_ENABLED`
 *   - sys  `voice.livekit_agent_enabled`
 *
 * Default in production is `{enabled: false}` — the L2.2a safety pin. These
 * tests focus on the env parser + graceful-degradation contract.
 */

import {
  getLiveKitAgentReadiness,
  invalidateLiveKitAgentConfigCache,
} from '../../../../src/orb/live/upstream/livekit-agent-config';

const ORIGINAL_ENV = { ...process.env };

function resetEnv(): void {
  delete process.env.ORB_LIVEKIT_AGENT_ENABLED;
}

beforeEach(() => {
  invalidateLiveKitAgentConfigCache();
  resetEnv();
});

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('L2.2a getLiveKitAgentReadiness — env handling', () => {
  it('ORB_LIVEKIT_AGENT_ENABLED unset → enabled=false (the safety default)', async () => {
    const cfg = await getLiveKitAgentReadiness(process.env, true);
    expect(cfg.enabled).toBe(false);
  });

  it('ORB_LIVEKIT_AGENT_ENABLED=true → enabled=true', async () => {
    process.env.ORB_LIVEKIT_AGENT_ENABLED = 'true';
    const cfg = await getLiveKitAgentReadiness(process.env, true);
    expect(cfg.enabled).toBe(true);
  });

  it('truthy variants (1 / yes / TRUE / Yes / whitespace) → enabled=true', async () => {
    for (const v of ['1', 'yes', 'TRUE', 'Yes', '  TRUE  ']) {
      process.env.ORB_LIVEKIT_AGENT_ENABLED = v;
      invalidateLiveKitAgentConfigCache();
      const cfg = await getLiveKitAgentReadiness(process.env, true);
      expect(cfg.enabled).toBe(true);
    }
  });

  it('falsy variants (false / 0 / off / "") → enabled=false', async () => {
    for (const v of ['false', '0', 'off', '']) {
      process.env.ORB_LIVEKIT_AGENT_ENABLED = v;
      invalidateLiveKitAgentConfigCache();
      const cfg = await getLiveKitAgentReadiness(process.env, true);
      expect(cfg.enabled).toBe(false);
    }
  });

  it('NEVER throws — even with garbage env values', async () => {
    // @ts-expect-error — testing runtime tolerance
    process.env.ORB_LIVEKIT_AGENT_ENABLED = 42 as unknown as string;
    await expect(getLiveKitAgentReadiness(process.env, true)).resolves.toBeTruthy();
  });
});
