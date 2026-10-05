/**
 * VTID-04872: community cost control, slice 2 (approved 2026-10-03).
 *
 * Class B community decisions are counted per member per UTC day (300), in
 * shadow by default; safety decisions are never limited; Class C is off on
 * the member plane. Jev calls are injected; OASIS emit is a fake.
 */
const emitted: any[] = [];
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn(async (e: any) => {
    emitted.push(e);
    return { ok: true };
  }),
}));
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => null }));

import { decide } from '../src/services/jev/jev-decision-service';
import { createMemoryJevControl } from '../src/services/jev/jev-tenant-control';
import { getJevDecision, listJevDecisions } from '../src/services/jev/jev-decisions';
import {
  checkMemberQuota,
  createMemoryMemberQuotaStore,
  isQuotaLimited,
  memberDailyQuota,
  memberQuotaMode,
  JEV_MEMBER_DAILY_QUOTA_DEFAULT,
} from '../src/services/jev/jev-member-quota';
import { resetJevStatsForTest } from '../src/services/jev/jev-telemetry';
import type { JevCallResult } from '../src/services/jev/jev-client';

const ENV = { JEV_DECISIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'k', JEV_COMMUNITY_ENABLED: 'true' } as NodeJS.ProcessEnv;
const MEMBER = '11111111-2222-4333-8444-555555555555';
const admin = { actor_id: 'a', active_role: 'admin', tenant_id: 't1' };
const COMMUNITY_FLAG = { enabled: true, planes: ['internal', 'system_autopilot', 'member'], monthly_budget_usd: 50 };

const moderation = (): JevCallResult => ({
  ok: true,
  model: 'jev-1.13.0',
  answers: {
    category: { type: 'choice', choice: 'spam', probabilities: { spam: 0.9 }, confidence: 0.9 },
    severity: { type: 'score', score: 2, probabilities: [0.05, 0.1, 0.7, 0.1, 0.05], confidence: 0.7 },
  },
  usage: { input_tokens: 1000, output_tokens: 2 },
  latency_ms: 40,
  attempts: 1,
});
const flush = () => new Promise((s) => setImmediate(s));

beforeEach(() => {
  emitted.length = 0;
  resetJevStatsForTest();
});

describe('VTID-04872 settings', () => {
  test('mode: off and enforce are exact; unset or anything else is shadow (counts, never refuses)', () => {
    expect(memberQuotaMode({} as any)).toBe('shadow');
    expect(memberQuotaMode({ JEV_MEMBER_QUOTA_MODE: 'enforce' } as any)).toBe('enforce');
    expect(memberQuotaMode({ JEV_MEMBER_QUOTA_MODE: 'off' } as any)).toBe('off');
    expect(memberQuotaMode({ JEV_MEMBER_QUOTA_MODE: 'Enforce' } as any)).toBe('shadow');
  });

  test('limit: 300 by default, a positive integer override, anything else 300', () => {
    expect(JEV_MEMBER_DAILY_QUOTA_DEFAULT).toBe(300);
    expect(memberDailyQuota({} as any)).toBe(300);
    expect(memberDailyQuota({ JEV_MEMBER_DAILY_QUOTA: '50' } as any)).toBe(50);
    expect(memberDailyQuota({ JEV_MEMBER_DAILY_QUOTA: '0' } as any)).toBe(300);
    expect(memberDailyQuota({ JEV_MEMBER_DAILY_QUOTA: 'x' } as any)).toBe(300);
  });

  test('only member-spend Class B (or unclassified) non-safety calls are limited', () => {
    expect(isQuotaLimited({ community_class: 'B' }, 'member')).toBe(true);
    expect(isQuotaLimited({}, 'member')).toBe(true);
    expect(isQuotaLimited({ community_class: 'A' }, 'member')).toBe(false);
    expect(isQuotaLimited({ community_class: 'B', safety: true }, 'member')).toBe(false);
    expect(isQuotaLimited({ community_class: 'B' }, 'internal')).toBe(false);
    expect(isQuotaLimited({}, 'system_autopilot')).toBe(false);
  });

  test('moderation is a safety decision; every member-content decision is classified', () => {
    expect(getJevDecision('moderation_severity')).toMatchObject({ community_class: 'B', safety: true });
    for (const d of listJevDecisions().filter((x) => x.data === 'member_content')) {
      expect(['A', 'B', 'C']).toContain(d.community_class);
    }
  });
});

describe('VTID-04872 checkMemberQuota', () => {
  const run = (count: number, env: Record<string, string> = {}) => {
    const { store } = createMemoryMemberQuotaStore({ [`t1:${MEMBER}`]: count });
    const emit = jest.fn(async () => ({ ok: true }));
    return { p: checkMemberQuota({ decision: 'd', tenantId: 't1', memberId: MEMBER, store, env: env as any, emit }), emit };
  };

  test('within the limit: allowed and counted', async () => {
    const { p } = run(10);
    expect(await p).toEqual({ allowed: true, counted: 11 });
  });

  test('shadow over the limit: allowed, one would_refuse event on the first call over, none after', async () => {
    const first = run(300);
    expect(await first.p).toMatchObject({ allowed: true, counted: 301, would_refuse: true });
    await flush();
    expect(first.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'jev.member_quota.would_refuse', status: 'warning', payload: expect.not.objectContaining({ member_id: expect.anything() }) }));
    const later = run(305);
    expect(await later.p).toMatchObject({ allowed: true, would_refuse: true });
    await flush();
    expect(later.emit).not.toHaveBeenCalled();
  });

  test('enforce over the limit: refused', async () => {
    const { p } = run(300, { JEV_MEMBER_QUOTA_MODE: 'enforce' });
    expect(await p).toEqual({ allowed: false, reason: 'member_daily_quota_exhausted', counted: 301 });
  });

  test('an unreadable counter: shadow lets it through, enforce fails closed', async () => {
    const broken = { bump: async () => null };
    expect(await checkMemberQuota({ decision: 'd', tenantId: 't1', memberId: MEMBER, store: broken, env: {} as any })).toEqual({ allowed: true, counted: null });
    expect(await checkMemberQuota({ decision: 'd', tenantId: 't1', memberId: MEMBER, store: broken, env: { JEV_MEMBER_QUOTA_MODE: 'enforce' } as any })).toMatchObject({
      allowed: false,
      reason: 'member_quota_check_failed',
    });
  });

  test('a member id that is not a user uuid is never counted', async () => {
    const { store, counts } = createMemoryMemberQuotaStore();
    expect(await checkMemberQuota({ decision: 'd', tenantId: 't1', memberId: 'community-autopilot', store, env: {} as any })).toEqual({ allowed: true, counted: null });
    expect(counts).toEqual({});
  });

  test('off: nothing counted', async () => {
    const { store, counts } = createMemoryMemberQuotaStore();
    expect(await checkMemberQuota({ decision: 'd', tenantId: 't1', memberId: MEMBER, store, env: { JEV_MEMBER_QUOTA_MODE: 'off' } as any })).toEqual({ allowed: true, counted: null });
    expect(counts).toEqual({});
  });
});

describe('VTID-04872 decide()', () => {
  test('a safety decision is never counted, even over the limit in enforce', async () => {
    const mem = createMemoryJevControl({ t1: COMMUNITY_FLAG });
    const q = createMemoryMemberQuotaStore({ [`t1:${MEMBER}`]: 999 });
    const r = await decide('moderation_severity', { content: 'buy now' }, admin, {
      source: 't',
      call: jest.fn().mockResolvedValue(moderation()),
      env: { ...ENV, JEV_MEMBER_QUOTA_MODE: 'enforce' },
      control: mem.control,
      member_id: MEMBER,
      quota: q.store,
    });
    expect(r).toMatchObject({ ok: true, outcome: 'decided' });
    expect(q.counts[`t1:${MEMBER}`]).toBe(999);
  });

  test('a Class B member decision over the limit falls back to rules with 429 in enforce, and is decided in shadow', async () => {
    // A Class B, non-safety variant of a member-content decision.
    const def = getJevDecision('moderation_severity')! as any;
    const saved = def.safety;
    def.safety = false;
    try {
      const mem = createMemoryJevControl({ t1: COMMUNITY_FLAG });
      const call = jest.fn().mockResolvedValue(moderation());
      const enforce = createMemoryMemberQuotaStore({ [`t1:${MEMBER}`]: 300 });
      const r1 = await decide('moderation_severity', { content: 'x' }, admin, { source: 't', call, env: { ...ENV, JEV_MEMBER_QUOTA_MODE: 'enforce' }, control: mem.control, member_id: MEMBER, quota: enforce.store });
      expect(r1).toMatchObject({ ok: false, outcome: 'fallback', reason: 'member_daily_quota_exhausted', status: 429 });
      expect(call).not.toHaveBeenCalled();
      const shadow = createMemoryMemberQuotaStore({ [`t1:${MEMBER}`]: 300 });
      const r2 = await decide('moderation_severity', { content: 'x' }, admin, { source: 't', call, env: ENV, control: mem.control, member_id: MEMBER, quota: shadow.store });
      expect(r2).toMatchObject({ ok: true, outcome: 'decided' });
      await flush();
      expect(emitted.filter((e) => e.type === 'jev.member_quota.would_refuse')).toHaveLength(1);
    } finally {
      def.safety = saved;
    }
  });

  test('Class C is refused on the member plane before any token is spent', async () => {
    const def = getJevDecision('moderation_severity')! as any;
    const saved = def.community_class;
    def.community_class = 'C';
    try {
      const call = jest.fn();
      const r = await decide('moderation_severity', { content: 'x' }, admin, { source: 't', call, env: ENV, control: createMemoryJevControl({ t1: COMMUNITY_FLAG }).control });
      expect(r).toMatchObject({ ok: false, outcome: 'denied', reason: 'community_class_c_off' });
      expect(call).not.toHaveBeenCalled();
    } finally {
      def.community_class = saved;
    }
  });

  test('internal decisions are never counted', async () => {
    const q = createMemoryMemberQuotaStore();
    const r = await decide('ops_error_triage', { message: 'ECONNRESET' }, { actor_id: 'self-healing', system: true }, {
      source: 't',
      call: jest.fn().mockResolvedValue({
        ok: true,
        model: 'jev-1.13.0',
        answers: { cause: { type: 'choice', choice: 'transient', probabilities: { transient: 0.9 }, confidence: 0.9 }, needs_human: { type: 'noul', noul: 0.1 } },
        usage: { input_tokens: 10, output_tokens: 2 },
        latency_ms: 4,
        attempts: 1,
      }),
      env: ENV,
      control: createMemoryJevControl().control,
      member_id: MEMBER,
      quota: q.store,
    });
    expect(r.ok).toBe(true);
    expect(q.counts).toEqual({});
  });
});
