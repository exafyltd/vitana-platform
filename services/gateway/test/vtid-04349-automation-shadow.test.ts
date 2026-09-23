/**
 * VTID-04349: shadow delivery mode for the community automation engine, the
 * auth gate on its trigger routes, and the staging-only pins.
 */
import * as fs from 'fs';
import * as path from 'path';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE = 'svc';

const mockNotifyUserAsync = jest.fn();
jest.mock('../src/services/notification-service', () => ({
  notifyUserAsync: (...a: unknown[]) => mockNotifyUserAsync(...a),
}));
jest.mock('../src/services/system-controls-service', () => ({
  isAutopilotExecutionArmed: async () => true,
}));
const mockUpdateRun = jest.fn(async () => ({ error: null }));
jest.mock('../src/services/automation-executor-repository', () => ({
  insertAutomationRun: async () => ({ error: null }),
  updateAutomationRun: (...a: unknown[]) => (mockUpdateRun as any)(...a),
  fetchAutopilotPromptMaxPerDay: async () => ({ data: null }),
  fetchUsersByRole: async () => ({ data: [], error: null }),
  fetchAutomationRunHistory: async () => ({ data: [] }),
  fetchActiveAutomationRuns: async () => ({ data: [] }),
}));
const mockDefs: Record<string, any> = {
  'AP-TEST-SAFE': { id: 'AP-TEST-SAFE', status: 'LIVE', handler: 'testShadowSafe', targetRoles: 'all' },
  'AP-TEST-UNSAFE': { id: 'AP-TEST-UNSAFE', status: 'LIVE', handler: 'runMorningBriefing', targetRoles: 'all' },
};
jest.mock('../src/services/automation-registry', () => ({
  getAutomation: (id: string) => mockDefs[id],
  getHeartbeatAutomations: () => [],
  getEventAutomations: () => [],
  automationTargetsRole: () => true,
}));

// A real-looking Supabase client: every call is observable.
const realCalls: string[] = [];
function realBuilder(table: string): any {
  const b: any = {};
  for (const m of ['select', 'eq', 'in', 'limit', 'order', 'single', 'maybeSingle', 'gte']) {
    b[m] = () => { realCalls.push(`${table}.${m}`); return b; };
  }
  for (const m of ['insert', 'update', 'upsert', 'delete']) {
    b[m] = () => { realCalls.push(`${table}.${m}`); return b; };
  }
  b.then = (r: (v: unknown) => unknown) => r({ data: [{ id: 'row-1' }], error: null });
  return b;
}
const fakeClient: any = {
  from: (t: string) => realBuilder(t),
  rpc: (n: string) => { realCalls.push(`rpc.${n}`); return realBuilder(`rpc:${n}`); },
};
jest.mock('@supabase/supabase-js', () => ({ createClient: () => fakeClient }));

import {
  resolveAutomationDeliveryMode,
  createShadowRecorder,
  createShadowSupabase,
  SHADOW_UNSAFE_HANDLERS,
} from '../src/services/automation-shadow';
import { executeAutomation, registerHandler } from '../src/services/automation-executor';

const ROOT = path.resolve(__dirname, '../../..');

beforeAll(() => {
  (global as any).fetch = jest.fn(async () => ({ ok: true, json: async () => ({}) }));
});
beforeEach(() => {
  realCalls.length = 0;
  mockNotifyUserAsync.mockClear();
  mockUpdateRun.mockClear();
  delete process.env.AUTOMATIONS_DELIVERY_MODE;
});

describe('resolveAutomationDeliveryMode', () => {
  it('keeps production behaviour when unset or live', () => {
    expect(resolveAutomationDeliveryMode({})).toBe('live');
    expect(resolveAutomationDeliveryMode({ AUTOMATIONS_DELIVERY_MODE: '' })).toBe('live');
    expect(resolveAutomationDeliveryMode({ AUTOMATIONS_DELIVERY_MODE: 'live' })).toBe('live');
  });
  it('treats shadow, and any other explicit value (typo), as shadow', () => {
    expect(resolveAutomationDeliveryMode({ AUTOMATIONS_DELIVERY_MODE: 'shadow' })).toBe('shadow');
    expect(resolveAutomationDeliveryMode({ AUTOMATIONS_DELIVERY_MODE: 'shaddow' })).toBe('shadow');
    expect(resolveAutomationDeliveryMode({ AUTOMATIONS_DELIVERY_MODE: 'LIVE' })).toBe('shadow');
  });
});

describe('createShadowSupabase', () => {
  it('passes reads through and records writes and RPCs without performing them', async () => {
    const rec = createShadowRecorder();
    const sb = createShadowSupabase(fakeClient, rec);
    const read = await sb.from('app_users').select('user_id').eq('tenant_id', 't');
    expect(read.data).toEqual([{ id: 'row-1' }]);
    const ins = await sb.from('global_community_groups').insert({ a: 1 }).select('id').single();
    expect(ins).toMatchObject({ data: null, error: null });
    await sb.from('x').update({}).eq('id', 1);
    await sb.from('x').upsert({});
    await sb.from('x').delete().eq('id', 1);
    await sb.rpc('credit_wallet', { a: 1 });
    expect(realCalls).toEqual(['app_users.select', 'app_users.eq']);
    expect(rec.writes).toEqual([
      { table: 'global_community_groups', op: 'insert' },
      { table: 'x', op: 'update' },
      { table: 'x', op: 'upsert' },
      { table: 'x', op: 'delete' },
    ]);
    expect(rec.rpcs).toEqual(['credit_wallet']);
  });
});

describe('executeAutomation in shadow mode', () => {
  beforeAll(() => {
    registerHandler('testShadowSafe', async (ctx) => {
      await ctx.supabase.from('app_users').select('user_id');
      await ctx.supabase.from('global_community_groups').insert({ name: 'g' });
      await ctx.supabase.rpc('increment_wallet_balance', {});
      ctx.notify('11111111-aaaa', 'group_created', { title: 'T', body: 'B' });
      return { usersAffected: 1, actionsTaken: 1 };
    });
    registerHandler('runMorningBriefing', async () => { throw new Error('must not run in shadow'); });
  });

  it('records notifications, writes and RPCs and performs none of them', async () => {
    process.env.AUTOMATIONS_DELIVERY_MODE = 'shadow';
    const r = await executeAutomation('AP-TEST-SAFE', 'tenant-1', 'manual');
    expect(r.ok).toBe(true);
    await new Promise((res) => setImmediate(res));
    expect(mockNotifyUserAsync).not.toHaveBeenCalled();
    expect(realCalls).toEqual(['app_users.select']);
    const meta = (mockUpdateRun.mock.calls.at(-1) as any[])[2].metadata;
    expect(meta.delivery_mode).toBe('shadow');
    expect(meta.shadow).toMatchObject({
      suppressed_writes: { 'insert:global_community_groups': 1 },
      suppressed_rpcs: ['increment_wallet_balance'],
      suppressed_notifications: 1,
      suppressed_notification_types: { group_created: 1 },
    });
  });

  it('never runs a handler that delivers outside ctx', async () => {
    process.env.AUTOMATIONS_DELIVERY_MODE = 'shadow';
    const r = await executeAutomation('AP-TEST-UNSAFE', 'tenant-1', 'manual');
    expect(r).toEqual({ ok: true, skipped: true, error: 'SHADOW_UNSAFE_HANDLER' });
    expect(mockUpdateRun).not.toHaveBeenCalled();
  });

  it('live mode (unset) still notifies and writes as before', async () => {
    const r = await executeAutomation('AP-TEST-SAFE', 'tenant-1', 'manual');
    expect(r.ok).toBe(true);
    expect(realCalls).toContain('global_community_groups.insert');
    expect(realCalls).toContain('rpc.increment_wallet_balance');
  });
});

describe('SHADOW_UNSAFE_HANDLERS drift guard', () => {
  it('lists exactly the handlers that reach an HTTP call or a lazily imported service', () => {
    const dir = path.join(ROOT, 'services/gateway/src/services/automation-handlers');
    const computed = new Set<string>();
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.ts') || f.endsWith('-repository.ts')) continue;
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      const funcs: Record<string, string> = {};
      for (const part of src.split(/\n(?=(?:export )?(?:async )?function )/)) {
        const m = part.match(/^(?:export )?(?:async )?function (\w+)/);
        if (m) funcs[m[1]] = part;
      }
      const unsafe = new Set(Object.keys(funcs).filter((n) => /await import\(|\bfetch\(/.test(funcs[n])));
      let changed = true;
      while (changed) {
        changed = false;
        for (const [n, body] of Object.entries(funcs)) {
          if (unsafe.has(n)) continue;
          if ([...unsafe].some((u) => new RegExp(`\\b${u}\\(`).test(body))) { unsafe.add(n); changed = true; }
        }
      }
      for (const m of src.matchAll(/registerHandler\('(\w+)',\s*(\w+)\)/g)) {
        if (unsafe.has(m[2])) computed.add(m[1]);
      }
    }
    expect([...computed].sort()).toEqual([...SHADOW_UNSAFE_HANDLERS].sort());
  });

  it('repositories only use the client they are given', () => {
    const dir = path.join(ROOT, 'services/gateway/src/services/automation-handlers');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('-repository.ts'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      expect({ f, bypass: /await import\(|\bfetch\(|getSupabase\(|createClient\(|notifyUser/.test(src) }).toEqual({ f, bypass: false });
    }
  });
});

describe('trigger routes and pins', () => {
  const routes = fs.readFileSync(path.join(ROOT, 'services/gateway/src/routes/automations.ts'), 'utf8');
  it('gates execute / heartbeat / dispatch / cron', () => {
    for (const r of ["'/execute/:id'", "'/heartbeat'", "'/dispatch'", "'/cron/:id'"]) {
      expect(routes).toContain(`router.post(${r}, requireInternalOrAdmin, async`);
    }
  });

  const stage = fs.readFileSync(path.join(ROOT, '.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml'), 'utf8');
  const prod = fs.readFileSync(path.join(ROOT, '.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml'), 'utf8');
  it('pins shadow mode, the heartbeat and the Maxina tenant on staging only', () => {
    expect(stage).toContain('{name:"AUTOMATIONS_DELIVERY_MODE", value:"shadow"}');
    expect(stage).toContain('{name:"AUTOPILOT_HEARTBEAT_ENABLED", value:"true"}');
    expect(stage).toContain('{name:"DEFAULT_TENANT_ID", value:"2e7528b8-472a-4356-88da-0280d4639cce"}');
    expect(stage).toMatch(/"AUTOMATIONS_DELIVERY_MODE","AUTOPILOT_HEARTBEAT_ENABLED","DEFAULT_TENANT_ID"\) \| not/);
    expect(prod).not.toContain('AUTOMATIONS_DELIVERY_MODE');
    expect(prod).not.toContain('AUTOPILOT_HEARTBEAT_ENABLED');
  });

  it('EventBridge automation jobs carry the internal token and default to staging', () => {
    const sh = fs.readFileSync(path.join(ROOT, 'scripts/aws/setup-eventbridge-cron-migration.sh'), 'utf8');
    const apJobs = sh.split('\n').filter((l) => l.includes('/api/v1/automations/cron/AP-'));
    expect(apJobs.length).toBe(19);
    for (const l of apJobs) expect(l).toContain('\\"auth\\":\\"gateway_internal\\",\\"gateway_url\\":\\"$AUTOMATIONS_GATEWAY_URL\\"');
    expect(sh).toContain('AUTOMATIONS_GATEWAY_URL="${AUTOMATIONS_GATEWAY_URL:-https://preview-aws-gateway.vitanaland.com}"');
  });
});
