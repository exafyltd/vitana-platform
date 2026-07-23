/**
 * DEV-COMHU-0514 / BOOTSTRAP-NOVA-SONIC-VOICE: Nova Sonic Test Bench —
 * automated-suite runner tests. The offline tier must be green on a clean
 * environment; the live probe must SKIP (never open a paid stream) unless
 * explicitly requested AND the runtime is ready.
 */

import {
  runNovaSonicTestSuite,
  listNovaTestRuns,
} from '../../../src/services/voice-lab/nova-sonic-test-runner';

describe('runNovaSonicTestSuite', () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('offline tier passes on a clean environment; live probe skips by default', async () => {
    delete process.env.NOVA_SONIC_ENABLED;
    delete process.env.ORB_LIVE_PROVIDER;
    const summary = await runNovaSonicTestSuite();

    expect(summary.provider).toBe('nova_sonic');
    expect(summary.model).toBe('amazon.nova-2-sonic-v1:0');
    expect(summary.region).toBe('eu-north-1');
    expect(summary.failed).toBe(0);

    const byKey = Object.fromEntries(summary.checks.map((c) => [c.key, c]));
    for (const key of [
      'config_readiness',
      'pinned_model_region',
      'selector_canary_allowlisted',
      'selector_non_allowlisted',
      'selector_language_fallback',
      'selector_emergency_rollback',
      'protocol_roundtrip',
      'voice_mapping',
    ]) {
      expect(byKey[key]?.status).toBe('pass');
    }
    expect(byKey.live_connect_probe?.status).toBe('skip');
    expect(byKey.live_connect_probe?.detail).toMatch(/not requested/);
    expect(byKey.vertex_baseline_probe?.status).toBe('skip');
    expect(byKey.vertex_baseline_probe?.detail).toMatch(/not requested/);
    expect(byKey.latency_comparison?.status).toBe('skip');
    expect(byKey.latency_comparison?.detail).toMatch(/not requested/);
  });

  it('live probe requested but Nova disabled → typed SKIP, no stream opened', async () => {
    delete process.env.NOVA_SONIC_ENABLED;
    const summary = await runNovaSonicTestSuite({ live: true });
    const probe = summary.checks.find((c) => c.key === 'live_connect_probe');
    expect(probe?.status).toBe('skip');
    expect(probe?.detail).toMatch(/not ready/);
    // No paid Google stream without Nova metrics to compare against.
    const baseline = summary.checks.find((c) => c.key === 'vertex_baseline_probe');
    expect(baseline?.status).toBe('skip');
    expect(baseline?.detail).toMatch(/baseline comparison unnecessary/);
    const comparison = summary.checks.find((c) => c.key === 'latency_comparison');
    expect(comparison?.status).toBe('skip');
    expect(summary.live_probe_requested).toBe(true);
  });

  it('config issues surface as a failed readiness check', async () => {
    process.env.NOVA_SONIC_REGION = 'us-east-1';
    const summary = await runNovaSonicTestSuite();
    const readiness = summary.checks.find((c) => c.key === 'config_readiness');
    expect(readiness?.status).toBe('fail');
    expect(readiness?.detail).toContain('nova_region_invalid');
  });

  it('records recent runs (ring buffer)', async () => {
    await runNovaSonicTestSuite();
    const runs = listNovaTestRuns();
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0].checks.length).toBeGreaterThan(0);
  });
});
