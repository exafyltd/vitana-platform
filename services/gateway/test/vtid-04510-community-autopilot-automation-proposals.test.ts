/**
 * VTID-04510 (Community Autopilot CA-8): automations propose, they do not act;
 * the automation supervisor; run history behind admin auth.
 */
process.env.NODE_ENV = 'test';

const mockExcluded = jest.fn(async () => new Set<string>());
jest.mock('../src/lib/excluded-test-service-accounts', () => ({
  fetchExcludedTestServiceAccountIds: () => mockExcluded(),
}));

const mockShareToSocial = jest.fn(async () => ({ shared: ['x'], notify_instead: false }));
jest.mock('../src/services/social-connect-service', () => ({
  shareMilestoneToSocial: (...a: unknown[]) => (mockShareToSocial as any)(...a),
}));
jest.mock('../src/services/milestone-service', () => ({
  MILESTONES: { first_week: { name: 'First week', celebration: 'x', icon: '*' } },
}));

import fs from 'fs';
import path from 'path';
import {
  buildProposalRow,
  checkProposal,
  proposeToMember,
  tallyOutcomes,
  PROPOSING_AUTOMATIONS,
  REMAINING_SILENT_ACTORS,
  type AutomationProposal,
} from '../src/services/community-autopilot/automation-proposals';
import { summarizeSupervisor, clampWindowDays } from '../src/services/community-autopilot/automation-supervisor';
import { createShadowRecorder, createShadowSupabase } from '../src/services/automation-shadow';
import { getHandler } from '../src/services/automation-executor';
import { registerSharingGrowthHandlers } from '../src/services/automation-handlers/sharing-growth';
import { registerOnboardingGrowthHandlers } from '../src/services/automation-handlers/onboarding-growth';
import type { AutomationContext } from '../src/types/automations';

const U = 'aaaa1111-1111-4111-8111-111111111111';
const R = 'bbbb2222-2222-4222-8222-222222222222';
const NOW = new Date('2026-09-24T12:00:00Z');

/** Fake Supabase: reads resolve to a per-table dataset, inserts are recorded. */
function fakeSb(data: Record<string, any[]> = {}) {
  const inserts: Array<{ table: string; row: any }> = [];
  const upserts: string[] = [];
  const rpcs: string[] = [];
  const sb: any = {
    inserts, upserts, rpcs,
    rpc(name: string) { rpcs.push(name); return Promise.resolve({ data: null, error: null }); },
    from(table: string) {
      const result = { data: data[table] ?? [], error: null };
      const chain: any = {};
      for (const m of ['select', 'eq', 'neq', 'in', 'gte', 'lte', 'like', 'ilike', 'order', 'limit', 'not', 'is', 'contains']) chain[m] = () => chain;
      chain.insert = (row: any) => { inserts.push({ table, row }); return Object.assign(Promise.resolve({ data: null, error: null }), chain); };
      chain.upsert = () => { upserts.push(table); return Promise.resolve({ data: null, error: null }); };
      chain.update = () => { upserts.push(table); return chain; };
      chain.maybeSingle = () => Promise.resolve({ data: (data[table] ?? [])[0] ?? null, error: null });
      chain.single = chain.maybeSingle;
      chain.then = (res: any, rej: any) => Promise.resolve(result).then(res, rej);
      return chain;
    },
  };
  return sb;
}

function ctxFor(sb: any, metadata: Record<string, unknown> = {}, automationId = 'AP-0410') {
  const notify = jest.fn();
  const ctx: AutomationContext = {
    tenantId: 't-1', targetRoles: 'all', supabase: sb,
    run: {
      id: 'run-9', tenant_id: 't-1', automation_id: automationId, trigger_type: 'event', target_roles: 'all',
      status: 'running', users_affected: 0, actions_taken: 0, metadata, started_at: NOW.toISOString(),
    },
    log: jest.fn(), notify, emitEvent: jest.fn(async () => {}), queryTargetUsers: jest.fn(async () => []),
  };
  return { ctx, notify };
}

const proposal = (over: Partial<AutomationProposal> = {}): AutomationProposal => ({
  userId: U, template: 'group_interest', params: { interest: 'Yoga' }, domain: 'community',
  action: { kind: 'open_screen', params: { route: '/community/groups' } }, fingerprint: 'group_interest:yoga', ...over,
});

beforeAll(() => {
  registerSharingGrowthHandlers();
  registerOnboardingGrowthHandlers();
});

beforeEach(() => {
  mockExcluded.mockResolvedValue(new Set());
  mockShareToSocial.mockClear();
});

describe('checkProposal (guards)', () => {
  const base = { excluded: new Set<string>(), recent: [] as any[], now: NOW };
  it('accepts a fresh, valid proposal', () => expect(checkProposal({ ...base, proposal: proposal() })).toBeNull());
  it('never proposes to, or about, a test/service account', () => {
    expect(checkProposal({ ...base, excluded: new Set([U]), proposal: proposal() })).toBe('excluded_account');
    expect(checkProposal({
      ...base, excluded: new Set([R]),
      proposal: proposal({ action: { kind: 'open_screen', params: { route: `/profile/${R}`, target_user_id: R } } }),
    })).toBe('excluded_account');
  });
  it('rejects an unknown action kind', () => {
    expect(checkProposal({ ...base, proposal: proposal({ action: { kind: 'create_group', params: {} } as any }) })).toBe('invalid_action');
  });
  it('respects the 3-open cap; expired open rows do not count', () => {
    const open = (i: number, expires: string | null) => ({ status: 'new', fingerprint: `f${i}`, expires_at: expires, created_at: NOW.toISOString() });
    expect(checkProposal({ ...base, recent: [open(1, null), open(2, null), open(3, null)], proposal: proposal() })).toBe('queue_full');
    expect(checkProposal({ ...base, recent: [open(1, null), open(2, null), open(3, '2026-09-20T00:00:00Z')], proposal: proposal() })).toBeNull();
  });
  it('does not repeat the same fingerprint within 14 days, whatever its outcome', () => {
    const rejected = { status: 'rejected', fingerprint: 'group_interest:yoga', expires_at: null, created_at: '2026-09-20T00:00:00Z' };
    expect(checkProposal({ ...base, recent: [rejected], proposal: proposal() })).toBe('duplicate');
    const old = { ...rejected, created_at: '2026-09-01T00:00:00Z' };
    expect(checkProposal({ ...base, recent: [old], proposal: proposal() })).toBeNull();
  });
});

describe('proposeToMember', () => {
  it('writes one row: typed action, member language, provenance, expiry', async () => {
    const sb = fakeSb();
    const out = await proposeToMember({ supabase: sb, automationId: 'AP-0201', runId: 'r1' }, proposal(), {
      now: () => NOW, locale: async () => 'de', translate: (k, l, p) => `${l}:${k}:${p?.interest ?? ''}`,
    });
    expect(out).toBe('proposed');
    expect(sb.inserts).toHaveLength(1);
    expect(sb.inserts[0].row).toMatchObject({
      user_id: U, status: 'new', source_type: 'community', source_ref: 'auto_group_interest',
      title: 'de:autopilot.auto.group_interest.title:Yoga',
      action: { kind: 'open_screen', params: { route: '/community/groups' } },
      provenance: { source: 'automation', automation_id: 'AP-0201', run_id: 'r1', template: 'group_interest' },
      expires_at: '2026-09-27T12:00:00.000Z',
    });
  });

  it('an excluded member gets nothing written', async () => {
    mockExcluded.mockResolvedValue(new Set([U]));
    const sb = fakeSb();
    expect(await proposeToMember({ supabase: sb, automationId: 'AP-0201', runId: 'r1' }, proposal())).toBe('excluded_account');
    expect(sb.inserts).toHaveLength(0);
  });

  it('in shadow mode the write is recorded and skipped', async () => {
    const real = fakeSb();
    const rec = createShadowRecorder();
    const out = await proposeToMember({ supabase: createShadowSupabase(real, rec), automationId: 'AP-0201', runId: 'r1' }, proposal(), {
      locale: async () => 'en', translate: (k) => k,
    });
    expect(out).toBe('proposed');
    expect(real.inserts).toHaveLength(0);
    expect(rec.writes).toEqual([{ table: 'autopilot_recommendations', op: 'insert' }]);
  });

  it('tallies outcomes', () => {
    expect(tallyOutcomes(['proposed', 'proposed', 'duplicate'])).toMatchObject({ proposed: 2, duplicate: 1, queue_full: 0 });
  });

  it('builds the row with a clamped impact', () => {
    const row = buildProposalRow(proposal({ impact: 42 }), { automationId: 'A', runId: 'r' }, { title: 't', summary: 's' }, NOW);
    expect(row.impact_score).toBe(10);
  });
});

describe('AP-0410 viral loop: proposes, never connects or RSVPs for the member', () => {
  it('writes no relationship edge and no event participant; proposes connect + RSVP; still thanks the inviter', async () => {
    const sb = fakeSb();
    const { ctx, notify } = ctxFor(sb, { referred_id: U, referrer_id: R, target_type: 'event', target_id: 'ev-1' });
    const result = await getHandler('runViralLoopOnboarding')!(ctx);

    expect(sb.upserts).not.toContain('relationship_edges');
    expect(sb.upserts).not.toContain('global_event_participants');
    expect(sb.inserts.map((i: any) => i.table)).toEqual(['autopilot_recommendations', 'autopilot_recommendations']);
    const [connect, rsvp] = sb.inserts.map((i: any) => i.row);
    expect(connect).toMatchObject({ user_id: U, source_ref: 'auto_connect_referrer', action: { kind: 'open_screen', params: { route: `/profile/${R}` } } });
    expect(rsvp).toMatchObject({ user_id: U, source_ref: 'auto_event_rsvp_referral', action: { kind: 'rsvp_event', params: { event_id: 'ev-1' } } });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toBe(R);
    expect(result.actionsTaken).toBe(3);
  });
});

describe('AP-1306 milestone: never posts for the member', () => {
  it('does not call the social share, sends no notification, proposes a post draft', async () => {
    const sb = fakeSb();
    const { ctx, notify } = ctxFor(sb, { user_id: U, milestone: 'first_week' }, 'AP-1306');
    const result = await getHandler('runAutoShareToSocial')!(ctx);

    expect(mockShareToSocial).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(sb.inserts).toHaveLength(1);
    expect(sb.inserts[0].row).toMatchObject({
      source_ref: 'auto_share_milestone', fingerprint: 'share_milestone:first_week',
      action: { kind: 'post_to_feed', params: {} },
    });
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });

  it('the handler source no longer reaches the social share service', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'automation-handlers', 'onboarding-growth.ts'), 'utf8');
    const body = src.slice(src.indexOf('async function runAutoShareToSocial'), src.indexOf('// ── Register all handlers'));
    expect(body).not.toMatch(/shareMilestoneToSocial|social-connect-service/);
    expect(body).not.toMatch(/ctx\.notify\(/);
  });
});

describe('the converted group handlers no longer create groups', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'automation-handlers', 'community-groups.ts'), 'utf8');
  for (const fn of ['runAutoCreateGroupFromInterestCluster', 'runGroupCreationFromMatchCluster']) {
    it(`${fn} calls neither insertGroup nor insertGroupMembers nor notify`, () => {
      const start = src.indexOf(`async function ${fn}`);
      const body = src.slice(start, src.indexOf('\n}\n', start));
      expect(body).toContain('proposeToMember');
      expect(body).not.toMatch(/insertGroup|ctx\.notify\(/);
    });
  }
});

describe('supervisor', () => {
  it('clamps the window', () => {
    expect(clampWindowDays(undefined)).toBe(7);
    expect(clampWindowDays('3')).toBe(3);
    expect(clampWindowDays('400')).toBe(30);
    expect(clampWindowDays('-1')).toBe(7);
  });

  it('folds runs and proposals per automation and marks proposing vs silent', () => {
    const s = summarizeSupervisor({
      registry: [{ id: 'AP-0201', name: 'Group Suggestion', status: 'IMPLEMENTED' }, { id: 'AP-0103', name: 'Intro', status: 'IMPLEMENTED' }],
      runs: [
        { automation_id: 'AP-0201', status: 'completed', users_affected: 5, actions_taken: 5 },
        { automation_id: 'AP-0201', status: 'failed' },
        { automation_id: 'AP-0103', status: 'completed', users_affected: 2, actions_taken: 2 },
      ],
      proposals: [
        { status: 'new', provenance: { automation_id: 'AP-0201' } },
        { status: 'activated', provenance: { automation_id: 'AP-0201' } },
        { status: 'rejected', provenance: { automation_id: 'AP-0201' } },
        { status: 'new', provenance: null },
      ],
    });
    const g = s.automations.find((a) => a.automation_id === 'AP-0201')!;
    expect(g).toMatchObject({ name: 'Group Suggestion', mode: 'proposes', runs: { completed: 1, failed: 1 }, users_affected: 5, proposals: { new: 1, activated: 1, rejected: 1 } });
    expect(s.automations.find((a) => a.automation_id === 'AP-0103')!.mode).toBe('acts_silently');
    expect(s.totals).toEqual({ runs: 3, proposals: { new: 1, activated: 1, rejected: 1 } });
    for (const id of [...PROPOSING_AUTOMATIONS, ...REMAINING_SILENT_ACTORS]) {
      expect(s.automations.some((a) => a.automation_id === id)).toBe(true);
    }
  });
});

describe('catalog', () => {
  const dir = path.join(__dirname, '..', 'src', 'i18n', 'locales');
  const templates = ['group_interest', 'group_interest_join', 'group_circle', 'connect_referrer', 'event_rsvp_referral', 'share_milestone'];
  for (const loc of ['de', 'en', 'es', 'fr', 'pl', 'pt', 'ru', 'sr', 'tr', 'zh']) {
    it(`${loc} carries every proposal title and summary`, () => {
      const d = JSON.parse(fs.readFileSync(path.join(dir, `${loc}.json`), 'utf8'));
      for (const t of templates) {
        expect(d[`autopilot.auto.${t}.title`]).toBeTruthy();
        expect(d[`autopilot.auto.${t}.summary`]).toBeTruthy();
      }
    });
  }
});

describe('routes', () => {
  const express = require('express');
  const request = require('supertest');

  function mount(dataset: Record<string, any[]> = {}) {
    jest.resetModules();
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE = 'svc';
    process.env.GATEWAY_INTERNAL_TOKEN = 'tok';
    jest.doMock('@supabase/supabase-js', () => ({ createClient: () => fakeSb(dataset) }));
    jest.doMock('../src/middleware/auth-supabase-jwt', () => ({
      requireAuth: (req: any, res: any, next: any) => {
        const h = req.get('Authorization');
        if (!h) return res.status(401).json({ ok: false, error: 'missing bearer token' });
        req.identity = { user_id: U, exafy_admin: h === 'Bearer admin' };
        return next();
      },
      optionalAuth: (_req: any, _res: any, next: any) => next(),
    }));
    const router = require('../src/routes/automations').default;
    const app = express();
    app.use(express.json());
    app.use('/api/v1/automations', router);
    return app;
  }

  it('run history is no longer public', async () => {
    const app = mount();
    expect((await request(app).get('/api/v1/automations/runs?tenant_id=t')).status).toBe(401);
    expect((await request(app).get('/api/v1/automations/runs/active?tenant_id=t')).status).toBe(401);
    expect((await request(app).get('/api/v1/automations/runs').set('Authorization', 'Bearer member')).status).toBe(403);
  });

  it('supervisor: 401 anonymous, 403 member, 200 for the scheduler token and for an admin', async () => {
    const app = mount({
      automation_runs: [{ automation_id: 'AP-0201', status: 'completed', users_affected: 1, actions_taken: 1 }],
      autopilot_recommendations: [{ status: 'new', provenance: { automation_id: 'AP-0201' }, source_ref: 'auto_group_interest' }],
    });
    expect((await request(app).get('/api/v1/automations/supervisor')).status).toBe(401);
    expect((await request(app).get('/api/v1/automations/supervisor').set('Authorization', 'Bearer member')).status).toBe(403);
    const byToken = await request(app).get('/api/v1/automations/supervisor?days=3').set('X-Gateway-Internal', 'tok');
    expect(byToken.status).toBe(200);
    expect(byToken.body).toMatchObject({ ok: true, window_days: 3, totals: { runs: 1, proposals: { new: 1 } } });
    expect(['live', 'shadow']).toContain(byToken.body.delivery_mode);
    const byAdmin = await request(app).get('/api/v1/automations/supervisor').set('Authorization', 'Bearer admin');
    expect(byAdmin.status).toBe(200);
  });
});
