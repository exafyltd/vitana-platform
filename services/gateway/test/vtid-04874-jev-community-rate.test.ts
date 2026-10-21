/**
 * VTID-04874: community cost control, slice 3 (approved 2026-10-03).
 *
 * Member-spend Jev calls take a token from a per-task bucket holding the
 * community share of the account rate limit (~30% of 1,200/min); internal
 * calls never do. Shadow by default. Jev calls are injected; OASIS emit is a fake.
 */
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => null }));

import { decide } from '../src/services/jev/jev-decision-service';
import { createMemoryJevControl } from '../src/services/jev/jev-tenant-control';
import { createMemoryMemberQuotaStore } from '../src/services/jev/jev-member-quota';
import {
  communityRateMode,
  communityRpmPerTask,
  createCommunityRateLimiter,
  TokenBucket,
  JEV_COMMUNITY_RPM_PER_TASK_DEFAULT,
} from '../src/services/jev/jev-community-rate';
import type { JevCallResult } from '../src/services/jev/jev-client';

const ENV = { JEV_DECISIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'k', JEV_COMMUNITY_ENABLED: 'true' } as NodeJS.ProcessEnv;
const admin = { actor_id: 'a', active_role: 'admin', tenant_id: 't1' };
const COMMUNITY_FLAG = { enabled: true, planes: ['internal', 'system_autopilot', 'member'], monthly_budget_usd: 50 };
const ok = (answers: any): JevCallResult => ({ ok: true, model: 'jev-1.13.0', answers, usage: { input_tokens: 10, output_tokens: 2 }, latency_ms: 4, attempts: 1 });
const moderation = () =>
  ok({
    category: { type: 'choice', choice: 'spam', probabilities: { spam: 0.9 }, confidence: 0.9 },
    severity: { type: 'score', score: 2, probabilities: [0.05, 0.1, 0.7, 0.1, 0.05], confidence: 0.7 },
  });
const ops = () =>
  ok({ cause: { type: 'choice', choice: 'transient', probabilities: { transient: 0.9 }, confidence: 0.9 }, needs_human: { type: 'noul', noul: 0.1 } });
const flush = () => new Promise((s) => setImmediate(s));
const never = { admit: () => false };

describe('VTID-04874 settings', () => {
  test('mode: off and enforce exact, anything else shadow', () => {
    expect(communityRateMode({} as any)).toBe('shadow');
    expect(communityRateMode({ JEV_COMMUNITY_RATE_MODE: 'enforce' } as any)).toBe('enforce');
    expect(communityRateMode({ JEV_COMMUNITY_RATE_MODE: 'off' } as any)).toBe('off');
    expect(communityRateMode({ JEV_COMMUNITY_RATE_MODE: 'yes' } as any)).toBe('shadow');
  });

  test('per-task rate: 180 by default (360/min = 30% of 1,200 over 2 tasks), positive integer override', () => {
    expect(JEV_COMMUNITY_RPM_PER_TASK_DEFAULT * 2).toBe(0.3 * 1200);
    expect(communityRpmPerTask({} as any)).toBe(180);
    expect(communityRpmPerTask({ JEV_COMMUNITY_RPM_PER_TASK: '120' } as any)).toBe(120);
    expect(communityRpmPerTask({ JEV_COMMUNITY_RPM_PER_TASK: '-1' } as any)).toBe(180);
  });
});

describe('VTID-04874 TokenBucket', () => {
  test('starts full, empties, refills continuously, never above capacity', () => {
    let t = 0;
    const b = new TokenBucket(60, () => t);
    for (let i = 0; i < 60; i++) expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
    t += 1000; // one token per second at 60/min
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
    t += 10 * 60_000;
    let n = 0;
    while (b.take()) n++;
    expect(n).toBe(60);
  });
});

describe('VTID-04874 limiter', () => {
  test('enforce refuses once the bucket is empty', () => {
    let t = 0;
    const l = createCommunityRateLimiter({ JEV_COMMUNITY_RATE_MODE: 'enforce', JEV_COMMUNITY_RPM_PER_TASK: '2' } as any, { now: () => t });
    expect([l.admit('d'), l.admit('d'), l.admit('d')]).toEqual([true, true, false]);
  });

  test('shadow never refuses and reports at most once per 10 minutes, with the count', async () => {
    let t = 0;
    const emit = jest.fn(async () => ({ ok: true }));
    const l = createCommunityRateLimiter({ JEV_COMMUNITY_RPM_PER_TASK: '1' } as any, { now: () => t, emit });
    expect([l.admit('d'), l.admit('d'), l.admit('d')]).toEqual([true, true, true]);
    await flush();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'jev.community_rate.would_limit', vtid: 'VTID-04874', payload: expect.objectContaining({ would_limit: 1, rpm_per_task: 1 }) }));
    t += 11 * 60_000;
    l.admit('d'); // refilled: admitted without limiting
    l.admit('d');
    await flush();
    expect(emit).toHaveBeenCalledTimes(2);
    expect((emit.mock.calls[1] as any)[0].payload.would_limit).toBe(2);
  });

  test('off admits everything without counting', () => {
    const l = createCommunityRateLimiter({ JEV_COMMUNITY_RATE_MODE: 'off', JEV_COMMUNITY_RPM_PER_TASK: '1' } as any);
    expect([l.admit('d'), l.admit('d'), l.admit('d')]).toEqual([true, true, true]);
  });
});

describe('VTID-04874 decide()', () => {
  test('a member-spend call refused by the rate share falls back to rules with 429 and no Jev call', async () => {
    const call = jest.fn().mockResolvedValue(moderation());
    const r = await decide('moderation_severity', { content: 'x' }, admin, {
      source: 't',
      call,
      env: ENV,
      control: createMemoryJevControl({ t1: COMMUNITY_FLAG }).control,
      quota: createMemoryMemberQuotaStore().store,
      communityRate: never,
    });
    expect(r).toMatchObject({ ok: false, outcome: 'fallback', reason: 'community_rate_limited', status: 429 });
    expect(call).not.toHaveBeenCalled();
  });

  test('internal calls never take a token', async () => {
    const admit = jest.fn(() => false);
    const r = await decide('ops_error_triage', { message: 'ECONNRESET' }, { actor_id: 'self-healing', system: true }, {
      source: 't',
      call: jest.fn().mockResolvedValue(ops()),
      env: ENV,
      control: createMemoryJevControl().control,
      communityRate: { admit },
    });
    expect(r.ok).toBe(true);
    expect(admit).not.toHaveBeenCalled();
  });
});
