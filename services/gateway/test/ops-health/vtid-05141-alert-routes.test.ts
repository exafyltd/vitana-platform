/**
 * VTID-05141 (P2) — every ALERT workflow check has one gateway ops health route.
 *
 * 1. The three new routes in routes/ops-health-checks.ts reproduce the logic
 *    and thresholds of ALERT-WELCOME-GREETING-HEALTH.yml,
 *    ALERT-ORB-BOOTSTRAP-LATENCY.yml and ALERT-NEWDAY-BRIEFING-LOOP.yml.
 * 2. Step A: ALERT-OASIS-LEDGER-INTEGRITY, ALERT-ORB-SESSION-STATE-HEALTH and
 *    ALERT-PUSH-DISPATCH-HEALTH are thin GETs of their production route.
 * 3. Step B: ALERT-WELCOME-GREETING-HEALTH, ALERT-ORB-BOOTSTRAP-LATENCY and
 *    ALERT-NEWDAY-BRIEFING-LOOP are thin GETs too, once the routes were live
 *    in production. Each check step is executed here with a stub `curl` to
 *    prove a non-JSON, 404, 5xx or non-ok answer fails the job.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import express from 'express';
import request from 'supertest';
import * as yaml from 'js-yaml';

let rpcResults: Record<string, { data: unknown; error: { message: string } | null }> = {};
let eventRows: Record<string, unknown[]> = {};
let eventError: { message: string } | null = null;
let queries: Array<Record<string, unknown>> = [];

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: () => ({
    rpc: (name: string) => Promise.resolve(rpcResults[name] ?? { data: null, error: { message: 'no mock' } }),
    from: (table: string) => {
      const q: Record<string, unknown> = { table, eq: {} as Record<string, unknown>, in: {} as Record<string, unknown> };
      queries.push(q);
      const b: any = {
        select: (c: string) => ((q.select = c), b),
        eq: (c: string, v: unknown) => (((q.eq as Record<string, unknown>)[c] = v), b),
        in: (c: string, v: unknown) => (((q.in as Record<string, unknown>)[c] = v), b),
        gte: (c: string, v: string) => ((q.gte = [c, v]), b),
        order: (c: string, o: unknown) => ((q.order = [c, o]), b),
        limit: (n: number) => {
          q.limit = n;
          const eq = q.eq as Record<string, unknown>;
          const key = String(eq['metadata->>stage'] ?? eq.topic);
          return Promise.resolve({ data: eventError ? null : eventRows[key] ?? [], error: eventError });
        },
      };
      return b;
    },
  }),
}));

import {
  opsHealthChecksRouter,
  resetOpsHealthCacheForTests,
  evalWelcomeGreeting,
  evalOrbBootstrapLatency,
  evalNewdayBriefingLoop,
  ORB_BOOTSTRAP_P50_MS,
  ORB_BOOTSTRAP_MAX_MS,
  ORB_BOOTSTRAP_WINDOW_MIN,
  ORB_BOOTSTRAP_LIMIT,
  NEWDAY_LOOKBACK_MIN,
  NEWDAY_QUERY_LIMIT,
} from '../../src/routes/ops-health-checks';
import { SERVICE_HEALTH_REGISTRY, SERVICE_HEALTH_GROUPS } from '../../src/constants/service-health-registry';

const WF_DIR = path.resolve(__dirname, '../../../../.github/workflows');
const wf = (name: string) => fs.readFileSync(path.join(WF_DIR, name), 'utf8');

function app() {
  const a = express();
  a.use('/api/v1/ops/health', opsHealthChecksRouter);
  return a;
}

const lat = (...ms: number[]) => ms.map((latency_ms) => ({ metadata: { latency_ms } }));

beforeEach(() => {
  resetOpsHealthCacheForTests();
  rpcResults = {};
  eventRows = {};
  eventError = null;
  queries = [];
});

// Step B moved the thresholds out of the workflows into the route, so the
// values the workflows used before VTID-05141 are pinned here instead.
describe('thresholds are the values the workflows used before VTID-05141', () => {
  it('ORB bootstrap: P50 6000 ms, max 12000 ms, 90 min window, limit 1000', () => {
    expect(ORB_BOOTSTRAP_P50_MS).toBe(6000);
    expect(ORB_BOOTSTRAP_MAX_MS).toBe(12000);
    expect(ORB_BOOTSTRAP_WINDOW_MIN).toBe(90);
    expect(ORB_BOOTSTRAP_LIMIT).toBe(1000);
  });
  it('new-day briefing: 60 min lookback, limit 50 per query', () => {
    expect(NEWDAY_LOOKBACK_MIN).toBe(60);
    expect(NEWDAY_QUERY_LIMIT).toBe(50);
  });
});

describe('/welcome-greeting (ci_welcome_greeting_health)', () => {
  it('evaluator: same two failure modes as the workflow', () => {
    expect(evalWelcomeGreeting({ signups_24h: 4, greeted_senders_24h: 1, unflagged_24h: 0 }).status).toBe('ok');
    expect(evalWelcomeGreeting({ signups_24h: 0, greeted_senders_24h: 0, unflagged_24h: 0 }).status).toBe('ok');
    expect(evalWelcomeGreeting({ signups_24h: 3, greeted_senders_24h: 0, unflagged_24h: 0 })).toMatchObject({
      status: 'down',
      reason: 'signups_without_greetings',
    });
    expect(evalWelcomeGreeting({ signups_24h: 3, greeted_senders_24h: 1, unflagged_24h: 2 })).toMatchObject({
      status: 'degraded',
      reason: 'unflagged_recent_users',
    });
    expect(evalWelcomeGreeting({ signups_24h: null, greeted_senders_24h: 1, unflagged_24h: 0 }).reason).toBe('unparseable_health_output');
    expect(evalWelcomeGreeting({ signups_24h: -1, greeted_senders_24h: 1, unflagged_24h: 0 }).status).toBe('down');
  });

  it('route: healthy, degraded and down', async () => {
    rpcResults.ci_welcome_greeting_health = { data: { signups_24h: 5, greeted_senders_24h: 1, unflagged_24h: 0 }, error: null };
    let r = await request(app()).get('/api/v1/ops/health/welcome-greeting');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'ok', signups_24h: 5 });

    resetOpsHealthCacheForTests();
    rpcResults.ci_welcome_greeting_health = { data: { signups_24h: 5, greeted_senders_24h: 1, unflagged_24h: 1 }, error: null };
    r = await request(app()).get('/api/v1/ops/health/welcome-greeting');
    expect(r.body.status).toBe('degraded');

    resetOpsHealthCacheForTests();
    rpcResults.ci_welcome_greeting_health = { data: null, error: { message: 'function does not exist' } };
    r = await request(app()).get('/api/v1/ops/health/welcome-greeting');
    expect(r.body).toMatchObject({ status: 'down', reason: 'check_failed' });
    expect(r.body.detail).toContain('ci_welcome_greeting_health');
  });
});

describe('/orb-bootstrap-latency (orb.live.context.bootstrap)', () => {
  it('evaluator: idle window is ok; p50 over 6 s or more than one build over 12 s is degraded', () => {
    expect(evalOrbBootstrapLatency([])).toMatchObject({ status: 'ok', idle: true });
    expect(evalOrbBootstrapLatency([{ metadata: { latency_ms: 'x' } }, { metadata: null }])).toMatchObject({ idle: true });
    expect(evalOrbBootstrapLatency(lat(1800, 2000, 2200)).status).toBe('ok');
    // a single slow build is a cold start, not the stampede signature
    expect(evalOrbBootstrapLatency(lat(1800, 2000, 13000)).status).toBe('ok');
    expect(evalOrbBootstrapLatency(lat(2000, 2000, 2000, 13000, 14000))).toMatchObject({ status: 'degraded', reason: 'repeated_builds_over_max', over_max: 2 });
    expect(evalOrbBootstrapLatency(lat(7000, 7000, 7000))).toMatchObject({ status: 'degraded', reason: 'p50_over_threshold', p50_ms: 7000 });
    // exactly at the limits is still healthy (the workflow uses strict >)
    expect(evalOrbBootstrapLatency(lat(6000, 6000, 6000, 12000, 12000)).status).toBe('ok');
  });

  it('route: queries the workflow\'s window and limit; healthy, degraded and down', async () => {
    eventRows['orb.live.context.bootstrap'] = lat(1500, 2000, 2500);
    let r = await request(app()).get('/api/v1/ops/health/orb-bootstrap-latency');
    expect(r.body).toMatchObject({ status: 'ok', n: 3, p50_ms: 2000 });
    expect(queries[0]).toMatchObject({
      table: 'oasis_events',
      select: 'created_at,metadata',
      eq: { topic: 'orb.live.context.bootstrap' },
      order: ['created_at', { ascending: false }],
      limit: 1000,
    });
    const since = Date.parse((queries[0].gte as string[])[1]);
    expect(Math.abs(Date.now() - since - 90 * 60_000)).toBeLessThan(10_000);

    resetOpsHealthCacheForTests();
    eventRows['orb.live.context.bootstrap'] = lat(9000, 9000, 9000);
    r = await request(app()).get('/api/v1/ops/health/orb-bootstrap-latency');
    expect(r.body.status).toBe('degraded');

    resetOpsHealthCacheForTests();
    eventError = { message: 'permission denied' };
    r = await request(app()).get('/api/v1/ops/health/orb-bootstrap-latency');
    expect(r.body).toMatchObject({ status: 'down', reason: 'check_failed' });
  });
});

describe('/newday-briefing-loop (two orb.live.diag queries)', () => {
  it('evaluator: either signal alone is a failure', () => {
    expect(evalNewdayBriefingLoop([], []).status).toBe('ok');
    expect(evalNewdayBriefingLoop([{ metadata: { result: 'error' } }, { metadata: { result: 'threw' } }], [])).toMatchObject({
      status: 'degraded',
      reason: 'stamp_briefing_date_write_failures',
      stamp_write_failures_by_result: { error: 1, threw: 1 },
    });
    expect(evalNewdayBriefingLoop([], [{ metadata: { session_id: 's1' } }])).toMatchObject({
      status: 'degraded',
      reason: 'reconnect_bucket_briefing_regression',
      session_ids: ['s1'],
    });
  });

  it('route: runs both workflow queries; healthy, degraded and down', async () => {
    let r = await request(app()).get('/api/v1/ops/health/newday-briefing-loop');
    expect(r.body).toMatchObject({ status: 'ok', stamp_write_failures: 0, reconnect_bucket_briefings: 0 });
    expect(queries).toHaveLength(2);
    expect(queries[0]).toMatchObject({
      table: 'oasis_events',
      select: 'id,created_at,metadata',
      eq: { topic: 'orb.live.diag', 'metadata->>stage': 'stamp_briefing_date_write' },
      in: { 'metadata->>result': ['error', 'threw'] },
      limit: 50,
    });
    expect(queries[1]).toMatchObject({
      eq: { topic: 'orb.live.diag', 'metadata->>stage': 'greeting_sent', 'metadata->>bucket': 'reconnect' },
      in: { 'metadata->>wake_opener': ['newday_overview', 'safe_fast_newday_overview'] },
      limit: 50,
    });
    const since = Date.parse((queries[0].gte as string[])[1]);
    expect(Math.abs(Date.now() - since - 60 * 60_000)).toBeLessThan(10_000);

    resetOpsHealthCacheForTests();
    eventRows.greeting_sent = [{ metadata: { session_id: 'abc' } }];
    r = await request(app()).get('/api/v1/ops/health/newday-briefing-loop');
    expect(r.body).toMatchObject({ status: 'degraded', reconnect_bucket_briefings: 1 });

    resetOpsHealthCacheForTests();
    eventError = { message: 'boom' };
    r = await request(app()).get('/api/v1/ops/health/newday-briefing-loop');
    expect(r.body).toMatchObject({ status: 'down', reason: 'check_failed' });
  });
});

describe('the three routes are on the Service Health panel', () => {
  it.each([
    ['/api/v1/ops/health/welcome-greeting', "'/welcome-greeting'"],
    ['/api/v1/ops/health/orb-bootstrap-latency', "'/orb-bootstrap-latency'"],
    ['/api/v1/ops/health/newday-briefing-loop', "'/newday-briefing-loop'"],
  ])('%s is registered in an existing group and declared public', (url, decl) => {
    const e = SERVICE_HEALTH_REGISTRY.find((x) => x.url === url);
    expect(e).toBeDefined();
    expect(SERVICE_HEALTH_GROUPS).toContain(e!.group);
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/routes/ops-health-checks.ts'), 'utf8');
    expect(src).toContain(`router.get(${decl}, (_req: Request, res: Response) => { // public-route`);
  });
});

// ── Step A + Step B workflows ───────────────────────────────────────────────

const STEP_A: Array<[string, string]> = [
  ['ALERT-OASIS-LEDGER-INTEGRITY', 'vtid-ledger'],
  ['ALERT-ORB-SESSION-STATE-HEALTH', 'orb-session-ledger'],
  ['ALERT-PUSH-DISPATCH-HEALTH', 'push-dispatch'],
];
const STEP_B: Array<[string, string]> = [
  ['ALERT-WELCOME-GREETING-HEALTH', 'welcome-greeting'],
  ['ALERT-ORB-BOOTSTRAP-LATENCY', 'orb-bootstrap-latency'],
  ['ALERT-NEWDAY-BRIEFING-LOOP', 'newday-briefing-loop'],
];
const ALL_STEPS = [...STEP_A, ...STEP_B];

function checkStep(name: string): { run: string; env: Record<string, string> } {
  const doc = yaml.load(wf(`${name}.yml`)) as any;
  const job = Object.values(doc.jobs)[0] as any;
  return job.steps[0];
}

/** Runs the workflow's check step with a stub curl that answers `body` with `code`. */
function runCheck(name: string, code: string, body: string): { status: number; out: string; url: string } {
  const step = checkStep(name);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtid05141-'));
  fs.writeFileSync(path.join(dir, 'body'), body);
  const curl = path.join(dir, 'curl');
  fs.writeFileSync(
    curl,
    [
      '#!/usr/bin/env bash',
      'out=""; for ((i=1;i<=$#;i++)); do if [ "${!i}" = "-o" ]; then j=$((i+1)); out="${!j}"; fi; done',
      `echo "\${@: -1}" > "${dir}/url"`,
      `cp "${dir}/body" "$out"`,
      `printf '%s' "${code}"`,
      code === '000' ? 'exit 7' : 'exit 0',
    ].join('\n'),
  );
  fs.chmodSync(curl, 0o755);
  const r = spawnSync('bash', ['-c', step.run], {
    cwd: dir,
    env: { ...process.env, ...step.env, PATH: `${dir}:${process.env.PATH}` },
    encoding: 'utf8',
  });
  const url = fs.existsSync(path.join(dir, 'url')) ? fs.readFileSync(path.join(dir, 'url'), 'utf8').trim() : '';
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}`, url };
}

describe('Steps A and B: six ALERT workflows are thin GETs of their production route', () => {
  it.each(ALL_STEPS)('%s GETs /api/v1/ops/health/%s on production with no Supabase call', (name, route) => {
    const s = wf(`${name}.yml`);
    expect(checkStep(name).env.HEALTH_URL).toBe(`https://gateway.vitanaland.com/api/v1/ops/health/${route}`);
    expect(s).not.toMatch(/supabase\.co|\/rest\/v1\/|SUPABASE_URL|SUPABASE_SERVICE_ROLE/);
    expect(s).toMatch(/- name: Check out the report script\n\s+if: failure\(\)/);
    expect(s).toMatch(/- name: Report failure to self-healing\n\s+if: failure\(\)/);
    expect(s).toContain(`bash scripts/ci/report-to-self-healing.sh "${name.toLowerCase()}" "alert-workflow://${name}"`);
    const doc = yaml.load(s) as any;
    expect(doc.on.schedule[0].cron).toBeTruthy();
    expect('workflow_dispatch' in doc.on).toBe(true);
  });

  it.each(ALL_STEPS)('%s passes only on JSON status ok', (name, route) => {
    const ok = runCheck(name, '200', JSON.stringify({ status: 'ok', checked_at: 'x' }));
    expect(ok.status).toBe(0);
    expect(ok.url).toBe(`https://gateway.vitanaland.com/api/v1/ops/health/${route}`);

    for (const status of ['degraded', 'down']) {
      const r = runCheck(name, '200', JSON.stringify({ status, reason: 'r' }));
      expect(r.status).toBe(1);
      expect(r.out).toContain('::error::');
    }
    expect(runCheck(name, '200', JSON.stringify({ ok: true })).status).toBe(1); // no status field
    expect(runCheck(name, '200', '<!DOCTYPE html><html>Cannot GET</html>').status).toBe(1);
    expect(runCheck(name, '200', '"ok"').status).toBe(1); // JSON but not an object
    expect(runCheck(name, '404', '<html>Not Found</html>').status).toBe(1);
    expect(runCheck(name, '503', JSON.stringify({ status: 'ok' })).status).toBe(1);
    expect(runCheck(name, '000', '').status).toBe(1);
  });
});
