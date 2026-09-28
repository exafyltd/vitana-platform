/**
 * VTID-04665 — Service Health Phase 4: per-router /health routes report
 * whether their dependency answers, not just that the route exists.
 */

import { readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let tableErrors: Record<string, { code?: string; message: string } | null> = {};
let tableStatus: Record<string, number> = {};
let tableCalls: string[] = [];
jest.mock('../src/lib/supabase', () => ({
  getSupabase: () => ({
    from: (t: string) => {
      tableCalls.push(t);
      const b: any = {
        select: (_c: string, opts?: { head?: boolean }) => {
          // VTID-04698: never head:true — supabase-js hides a missing table's
          // 404 on a HEAD (status 204, error null).
          expect(opts?.head).toBeUndefined();
          return b;
        },
        // limit(0): the probe reads no rows
        limit: (n: number) => {
          expect(n).toBe(0);
          return b;
        },
        abortSignal: () =>
          Promise.resolve({ error: tableErrors[t] ?? null, status: tableStatus[t] ?? (tableErrors[t] ? 404 : 200) }),
      };
      return b;
    },
  }),
}));

import {
  probeDependencies,
  withDependencyHealth,
  resetDependencyProbeForTests,
} from '../src/services/dependency-probe';
import { classifyHealthResponse } from '../src/services/service-health-probe';

const realFetch = global.fetch;
let rpcPaths: string[] = [];
let schemaFetches = 0;

beforeEach(() => {
  resetDependencyProbeForTests();
  tableErrors = {};
  tableStatus = {};
  tableCalls = [];
  schemaFetches = 0;
  rpcPaths = ['/rpc/exists_fn'];
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE = 'svc';
  (global as any).fetch = jest.fn(async (url: string, init: RequestInit) => {
    schemaFetches++;
    expect(url).toBe('https://example.supabase.co/rest/v1/');
    expect((init.headers as Record<string, string>).Accept).toBe('application/openapi+json');
    return { ok: true, status: 200, json: async () => ({ paths: Object.fromEntries(rpcPaths.map((p) => [p, {}])) }) };
  });
});
afterAll(() => {
  (global as any).fetch = realFetch;
});

describe('probeDependencies', () => {
  it('a reachable table is ok; a missing one is down with table_missing', async () => {
    tableErrors.gone = { code: 'PGRST205', message: "Could not find the table 'public.gone' in the schema cache" };
    const h = await probeDependencies([{ table: 'here' }, { table: 'gone' }]);
    expect(h.status).toBe('down');
    expect(h.dependencies).toEqual([
      expect.objectContaining({ kind: 'table', name: 'here', ok: true }),
      expect.objectContaining({ kind: 'table', name: 'gone', ok: false, error: 'table_missing' }),
    ]);
  });

  it('VTID-04698: a 404 with no error body is a missing table, never healthy', async () => {
    // What supabase-js answers when PostgREST's 404 carries no readable body.
    tableStatus.gone = 404;
    const h = await probeDependencies([{ table: 'gone' }]);
    expect(h.status).toBe('down');
    expect(h.dependencies).toEqual([expect.objectContaining({ kind: 'table', name: 'gone', ok: false, error: 'table_missing' })]);
  });

  it('an RPC is checked by presence in the schema listing, never called', async () => {
    const h = await probeDependencies([{ rpc: 'exists_fn' }, { rpc: 'preference_set' }]);
    expect(h.status).toBe('down');
    expect(h.dependencies[1]).toMatchObject({ name: 'preference_set', ok: false, error: 'function_missing' });
    expect(tableCalls).toEqual([]);
  });

  it('the schema listing is fetched once and cached', async () => {
    await probeDependencies([{ rpc: 'a' }]);
    await probeDependencies([{ rpc: 'b' }]);
    expect(schemaFetches).toBe(1);
  });

  it('a file dependency must exist and be non-empty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dep-'));
    writeFileSync(join(dir, 'a.js'), 'x');
    writeFileSync(join(dir, 'empty.js'), '');
    const h = await probeDependencies([{ file: join(dir, 'a.js') }, { file: join(dir, 'empty.js') }, { file: join(dir, 'nope.js') }]);
    expect(h.dependencies.map((d) => d.ok)).toEqual([true, false, false]);
  });

  it('results are cached per dependency', async () => {
    await probeDependencies([{ table: 't' }]);
    await probeDependencies([{ table: 't' }]);
    expect(tableCalls).toEqual(['t']);
  });
});

describe('withDependencyHealth', () => {
  it('keeps the body and its own status when every dependency answers', async () => {
    const body = await withDependencyHealth([{ table: 't' }], { ok: true, service: 'x', status: 'healthy' });
    expect(body).toMatchObject({ ok: true, service: 'x', status: 'healthy' });
    expect(classifyHealthResponse(200, body).healthy).toBe(true);
  });

  it('turns a route with a missing dependency red for the panel', async () => {
    const body = await withDependencyHealth([{ rpc: 'overload_detect' }], { ok: true, status: 'healthy' });
    expect(body).toMatchObject({ ok: false, status: 'down' });
    expect(classifyHealthResponse(200, body)).toEqual({ status: 'down', healthy: false });
  });
});

describe('the previously static routes now declare a dependency', () => {
  const ROUTES: Array<[string, RegExp]> = [
    ['execute.ts', /withDependencyHealth\(\[\{ table: 'vtid_ledger' \}\]/],
    ['operator.ts', /withDependencyHealth\(\[\{ table: 'vtid_ledger' \}, \{ table: 'oasis_events' \}\]/],
    ['telemetry.ts', /withDependencyHealth\(\[\{ table: 'oasis_events' \}\]/],
    ['events.ts', /withDependencyHealth\(\[\{ table: 'oasis_events' \}\]/],
    ['command-hub.ts', /withDependencyHealth\(\[\{ file: path\.join\(__dirname, '\.\.\/frontend\/command-hub\/app\.js'\) \}/],
    ['voice-lab.ts', /withDependencyHealth\(\[\{ table: 'voice_architecture_reports' \}\]/],
    ['conversation.ts', /withDependencyHealth\(\[\{ table: 'conversation_messages' \}\]/],
    ['autopilot-prompts.ts', /withDependencyHealth\(\[\{ table: 'autopilot_prompts' \}\]/],
    ['health-capacity.ts', /withDependencyHealth\(\[\{ table: 'capacity_rules' \}/],
    ['scheduler.ts', /withDependencyHealth\(\[\{ table: 'daily_recompute_runs' \}\]/],
    ['scheduled-notifications.ts', /withDependencyHealth\(\[\{ table: 'user_notifications' \}\]/],
    ['voice-feedback.ts', /withDependencyHealth\(\[\{ table: 'user_feedback_reports' \}\]/],
    ['user-preferences.ts', /withDependencyHealth\(\[\{ table: 'user_preferences' \}, \{ rpc: 'preference_set' \}/],
    ['taste-alignment.ts', /withDependencyHealth\(\[\{ rpc: 'taste_profile_get' \}/],
    ['overload-detection.ts', /withDependencyHealth\(\[\{ rpc: 'overload_detect' \}/],
    ['risk-mitigation.ts', /withDependencyHealth\(\[\{ table: 'risk_mitigations' \}\]/],
    ['opportunity-surfacing.ts', /withDependencyHealth\(\[\{ table: 'contextual_opportunities' \}\]/],
    ['vtid-terminalize.ts', /withDependencyHealth\(\[\{ table: 'vtid_ledger' \}\]/],
  ];
  it.each(ROUTES)('%s', (file, re) => {
    expect(readFileSync(join(__dirname, '../src/routes', file), 'utf8')).toMatch(re);
  });
});
