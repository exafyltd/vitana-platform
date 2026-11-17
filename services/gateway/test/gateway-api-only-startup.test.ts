/**
 * GATEWAY_API_ONLY startup guard — the isolated preview gateway must serve the
 * HTTP API while starting ZERO background work.
 *
 * Three layers:
 *  1. Predicate: only the exact string 'true' enables the mode (fail-safe; a
 *     typo or unset value keeps full production startup).
 *  2. Structure: in src/index.ts the guard is the first statement of the
 *     app.listen callback after the HTTP log lines, so every background
 *     startup token inside that callback sits after it, and app.listen stays.
 *  3. Behaviour: the real index.ts boots on a free port with the flag on.
 *     /alive answers 200 and no timers are created after the guard fires.
 *     A control boot without the flag must create timers, so the probe is
 *     known to detect background work.
 */
import fs from 'fs';
import path from 'path';
import http from 'http';
import { isGatewayApiOnlyMode, GATEWAY_API_ONLY_ENV } from '../src/startup/api-only-mode';

describe('isGatewayApiOnlyMode predicate', () => {
  it('is on only for the exact string true', () => {
    expect(isGatewayApiOnlyMode({ [GATEWAY_API_ONLY_ENV]: 'true' } as any)).toBe(true);
  });
  it.each([undefined, '', 'TRUE', 'True', '1', 'yes', 'false', ' true'])(
    'stays off for %p (fail-safe: production startup is never switched off by accident)',
    (value) => {
      expect(isGatewayApiOnlyMode({ [GATEWAY_API_ONLY_ENV]: value } as any)).toBe(false);
    },
  );
});

describe('src/index.ts guard placement', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  const callbackStart = src.indexOf('const server = app.listen(PORT, async () => {');
  const guardAt = src.indexOf('if (isGatewayApiOnlyMode(process.env)) {');

  // Every token that starts a background process, scheduler, voice socket,
  // shutdown drain or cache warmer. Inside the listen callback each must sit
  // AFTER the guard. The list is an audit of the callback, not a flag list.
  const BACKGROUND_TOKENS = [
    'setInterval(', 'setTimeout(',
    'startKiroRunTimers(', 'initializeAutopilotController(', 'initializeEventLoop(',
    'initializeOperatorPlanner(', 'registerAllAutomationHandlers(', 'startPmLoop(',
    'startRemindersDispatchLoop(', 'startMemoryEmbeddingBackfillLoop(',
    'startAudiobookReminderLoop(', 'startEmailFallbackLoop(', 'startOutboundHttpWorker(',
    'startAuthBridgeReconcileLoop(', 'startCalendarRemindersLoop(', 'startRewardSweepLoop(',
    'startRewardReservationSweep(', 'startCalendarMaintenanceLoop(', 'startGoogleSyncLoop(',
    'startConnectedAppsLoop(', 'startLifecycleNotificationWorker(', 'startScheduler(',
    'startMorningBriefScheduler(', 'startProductAnalyticsRollupScheduler(',
    'startBackstopClusterScheduler(', 'startSlowSessionScheduler(', 'startRoutineRunner(',
    'startOpenerOutcomesScheduler(', 'startRootCauseScheduler(', 'initializeAutonomousEngine(',
    'startReconciler(', 'startPlanSparringReconciler(', 'startIdleSessionCloser(',
    'startIntentEmbeddingWorker(', 'startOAuthTokenRefresher(', 'startAdminAwarenessWorker(',
    'startShopifySyncWorker(', 'startAwinSyncWorker(', 'startAwinConversionWorker(',
    'startBackgroundExecutor(', 'startWatchers(', 'startObserver(',
    'warmPersonalityCache(', 'warmPolicyResolverCache(', 'warmConflictPairCache(',
    'bootstrapEmbeddedAgents(', 'startNewsFetcher(', 'initializeOrbWebSocket(',
    'installGracefulShutdown(', 'generateChimePcm(',
  ];

  it('app.listen callback and guard exist, guard is in the callback', () => {
    expect(callbackStart).toBeGreaterThan(0);
    expect(guardAt).toBeGreaterThan(callbackStart);
  });

  it('no background token appears in the callback before the guard', () => {
    const before = src.slice(callbackStart, guardAt);
    for (const token of BACKGROUND_TOKENS) {
      expect({ token, found: before.includes(token) }).toEqual({ token, found: false });
    }
  });

  it('the guard returns from the callback (skips everything after it)', () => {
    const block = src.slice(guardAt, guardAt + 400);
    expect(block).toMatch(/return;\s*\n\s*\}/);
  });

  it('HTTP listener is still created by app.listen and not gated by the flag', () => {
    expect(src.match(/app\.listen\(PORT/g)?.length).toBeGreaterThanOrEqual(1);
    const listenLine = src.slice(callbackStart - 60, callbackStart);
    expect(listenLine).not.toMatch(/isGatewayApiOnlyMode/);
  });
});

// --- Behavioural boot ------------------------------------------------------

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function getJson(port: number, p: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p, timeout: 5000 }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, body }));
      })
      .on('error', reject);
  });
}

async function bootGateway(env: Record<string, string | undefined>, doneLog: RegExp) {
  const saved: Record<string, string | undefined> = {};
  const port = await getFreePort();
  const overrides = { ...env, PORT: String(port), NODE_ENV: 'development' };
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  const intervals: unknown[] = [];
  const timeouts: unknown[] = [];
  const origSetInterval = global.setInterval;
  const origSetTimeout = global.setTimeout;
  const logs: string[] = [];
  const origLog = console.log;
  let reached = false;
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    logs.push(line);
    if (doneLog.test(line)) reached = true;
  };
  let indexModule: any;
  const netCalls: string[] = [];
  const https = require('https');
  const origHttpReq = http.request;
  const origHttpsReq = https.request;
  const origFetch = (globalThis as any).fetch;
  const note = (kind: string) => (...a: any[]) => {
    const target = typeof a[0] === 'string' ? a[0] : a[0]?.hostname || a[0]?.host || a[0]?.url || '?';
    netCalls.push(`${kind}:${String(target).slice(0, 80)}`);
  };
  (http as any).request = (...a: any[]) => { note('http')(...a); return (origHttpReq as any)(...a); };
  (https as any).request = (...a: any[]) => { note('https')(...a); return (origHttpsReq as any)(...a); };
  if (origFetch) (globalThis as any).fetch = (...a: any[]) => { note('fetch')(...a); return origFetch(...a); };
  try {
    jest.isolateModules(() => {
      indexModule = require('../src/index');
    });
    // The listen callback runs on a later tick; count timers only from here on.
    const countingSetInterval = ((...a: any[]) => {
      intervals.push(a);
      return (origSetInterval as any)(...a);
    }) as any;
    const countingSetTimeout = ((...a: any[]) => {
      timeouts.push(a);
      return (origSetTimeout as any)(...a);
    }) as any;
    global.setInterval = countingSetInterval;
    global.setTimeout = countingSetTimeout;
    const deadline = Date.now() + 20000;
    while (!reached && Date.now() < deadline) {
      await new Promise((r) => origSetTimeout(r, 25));
    }
    const settle = 300;
    await new Promise((r) => origSetTimeout(r, settle));
    return { reached, intervals, timeouts, logs, port, netCalls, app: indexModule?.default };
  } finally {
    (http as any).request = origHttpReq;
    (https as any).request = origHttpsReq;
    if (origFetch) (globalThis as any).fetch = origFetch;
    global.setInterval = origSetInterval;
    global.setTimeout = origSetTimeout;
    console.log = origLog;
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe('behavioural boot of src/index.ts', () => {
  jest.setTimeout(60000);

  it('GATEWAY_API_ONLY=true: API answers /alive and zero timers are created after the guard', async () => {
    const r = await bootGateway(
      { GATEWAY_API_ONLY: 'true' },
      /GATEWAY_API_ONLY=true: HTTP API only/,
    );
    expect(r.reached).toBe(true);
    const alive = await getJson(r.port, '/alive');
    expect(alive.status).toBe(200);
    expect(alive.body).toContain('"status":"ok"');
    expect({ intervals: r.intervals.length, timeouts: r.timeouts.length }).toEqual({
      intervals: 0,
      timeouts: 0,
    });
  });

  it('GATEWAY_API_ONLY=true: no outbound HTTP(S)/fetch from import or boot (AI, email, sync, GCP/AWS auth)', async () => {
    const r = await bootGateway({ GATEWAY_API_ONLY: 'true' }, /GATEWAY_API_ONLY=true: HTTP API only/);
    expect(r.reached).toBe(true);
    // Our own /alive probe is made after the capture window closes, so any entry here is a boot-time call.
    expect(r.netCalls).toEqual([]);
  });

  it('control: without the flag the same boot creates background timers (probe is sensitive)', async () => {
    const r = await bootGateway({ GATEWAY_API_ONLY: undefined }, /Gateway server running on port/);
    expect(r.reached).toBe(true);
    expect(r.intervals.length + r.timeouts.length).toBeGreaterThan(0);
    expect(r.netCalls.length).toBeGreaterThan(0);
  });
});
