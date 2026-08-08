/**
 * DEV-COMHU-0514 / BOOTSTRAP-NOVA-SONIC-VOICE: Nova Sonic Test Bench —
 * automated-suite runner tests. The offline tier must be green on a clean
 * environment; the live probe must SKIP (never open a paid stream) unless
 * explicitly requested AND the runtime is ready.
 */

import {
  runNovaSonicTestSuite,
  listNovaTestRuns,
  probeLiveClient,
} from '../../../src/services/voice-lab/nova-sonic-test-runner';

/**
 * Minimal fake UpstreamLiveClient — lets the second-turn probe paths be
 * driven deterministically without opening a real (paid) Bedrock stream.
 * Handlers are captured so the test can fire turn_complete / error / close
 * in whatever order the scenario needs.
 */
function makeFakeClient(opts: { secondSendReturns?: boolean } = {}) {
  const handlers: Record<string, (e: any) => void> = {};
  let sendTextCalls = 0;
  const client = {
    connect: jest.fn(async () => { /* opened by the test's connect fn */ }),
    sendAudioChunk: () => true,
    sendTextTurn: (_text: string) => {
      sendTextCalls++;
      // First call is the probe's own "Say OK."; the second is the
      // follow-up turn whose submission the scenario controls.
      if (sendTextCalls >= 2 && opts.secondSendReturns === false) return false;
      return true;
    },
    sendEndOfTurn: () => true,
    sendToolResult: () => true,
    onAudioOutput: (h: any) => { handlers.audio = h; },
    onTranscript: (h: any) => { handlers.transcript = h; },
    onToolCall: (h: any) => { handlers.tool = h; },
    onTurnComplete: (h: any) => { handlers.turnComplete = h; },
    onInterrupted: (h: any) => { handlers.interrupted = h; },
    onError: (h: any) => { handlers.error = h; },
    onClose: (h: any) => { handlers.close = h; },
    close: jest.fn(async () => { /* idempotent */ }),
    getState: () => 'open' as const,
  };
  return { client: client as any, handlers, sendTextCalls: () => sendTextCalls };
}

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

/**
 * The probe exists to catch broken/slow SECOND turns. If a requested second
 * turn never completes, it must FAIL — reporting a pass with
 * second_turn_ms=-1 would mask exactly the failure it was built to detect.
 */
describe('probeLiveClient — second-turn completion is required, never a silent pass', () => {
  const noopClassify = (e: unknown) => `failed: ${String(e)}`;
  /** Let the probe get past `await connect()` so its first turn is in flight. */
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

  it('both turns complete → pass, with the second turn timed separately', async () => {
    const { client, handlers } = makeFakeClient();
    const probe = probeLiveClient(
      client,
      async () => { /* connected */ },
      'test_probe',
      noopClassify,
      'follow-up question',
    );
    await flush();
    handlers.audio?.({});         // turn 1 output
    handlers.turnComplete?.({});  // turn 1 done → probe submits turn 2
    handlers.audio?.({});         // turn 2 output
    handlers.turnComplete?.({});  // turn 2 done
    const result = await probe;
    expect(result.ok).toBe(true);
    expect(result.metrics!.second_turn_ms).toBeGreaterThanOrEqual(0);
  });

  it('stream closes after turn 1 → FAIL, not a pass with second_turn_ms=-1', async () => {
    const { client, handlers } = makeFakeClient();
    const probe = probeLiveClient(
      client,
      async () => { /* connected */ },
      'test_probe',
      noopClassify,
      'follow-up question',
    );
    await flush();
    handlers.audio?.({});             // first turn produced output
    handlers.turnComplete?.({});      // turn 1 done → probe submits turn 2
    handlers.close?.({ reason: 'upstream_gone' }); // dies before turn 2 completes
    const result = await probe;
    expect(result.ok).toBe(false);
    expect(result.failDetail).toMatch(/second turn did not complete/);
    expect(result.failDetail).toMatch(/upstream_gone/);
  });

  it('stream errors after turn 1 → FAIL with the error code surfaced', async () => {
    const { client, handlers } = makeFakeClient();
    const probe = probeLiveClient(
      client,
      async () => { /* connected */ },
      'test_probe',
      noopClassify,
      'follow-up question',
    );
    await flush();
    handlers.audio?.({});
    handlers.turnComplete?.({});
    handlers.error?.({ code: 'nova_validation' });
    const result = await probe;
    expect(result.ok).toBe(false);
    expect(result.failDetail).toMatch(/second turn did not complete/);
    expect(result.failDetail).toMatch(/nova_validation/);
  });

  it('sendTextTurn refuses the second turn (stream not open) → FAIL, return value not ignored', async () => {
    const { client, handlers } = makeFakeClient({ secondSendReturns: false });
    const probe = probeLiveClient(
      client,
      async () => { /* connected */ },
      'test_probe',
      noopClassify,
      'follow-up question',
    );
    await flush();
    handlers.audio?.({});
    handlers.turnComplete?.({}); // probe tries to submit turn 2; send returns false
    const result = await probe;
    expect(result.ok).toBe(false);
    expect(result.failDetail).toMatch(/second turn did not complete/);
    expect(result.failDetail).toMatch(/not open when the second turn was submitted/);
  });

  it('no second turn requested → single-turn behavior unchanged (still passes)', async () => {
    const { client, handlers } = makeFakeClient();
    const probe = probeLiveClient(
      client,
      async () => { /* connected */ },
      'test_probe',
      noopClassify,
    );
    await flush();
    handlers.audio?.({});
    handlers.turnComplete?.({});
    const result = await probe;
    expect(result.ok).toBe(true);
    expect(result.metrics?.second_turn_ms).toBe(-1);
  });
});
