/**
 * VTID-04857: community cost control, slice 1 (approved 2026-10-03).
 *
 * The tenant monthly budget caps community/customer spend only — internal and
 * system_autopilot stay unlimited — and the owner is paged at 80% and at 100%,
 * when member decisions fall back to rules. Jev calls are injected; OASIS
 * emit and the chat page are fakes.
 */
const emitted: any[] = [];
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn(async (e: any) => {
    emitted.push(e);
    return { ok: true };
  }),
}));
const pages: string[] = [];
jest.mock('../src/services/self-healing-snapshot-service', () => ({
  notifyGChat: jest.fn(async (m: string) => {
    pages.push(m);
    return { ok: true, webhook_set: true };
  }),
}));
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => null }));

import { decide } from '../src/services/jev/jev-decision-service';
import { createMemoryJevControl } from '../src/services/jev/jev-tenant-control';
import { crossedBudgetLevels, jevSpendPlane, isJevBudgetedPlane, JEV_BUDGETED_PLANES } from '../src/services/jev/jev-policy';
import { maybeRaiseBudgetAlerts, resetBudgetAlertsForTest } from '../src/services/jev/jev-budget-alerts';
import { resetJevStatsForTest } from '../src/services/jev/jev-telemetry';
import type { JevCallResult } from '../src/services/jev/jev-client';

const ENV = { JEV_DECISIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'k', JEV_COMMUNITY_ENABLED: 'true' } as NodeJS.ProcessEnv;
const staff = { actor_id: 'user-1', active_role: 'staff', tenant_id: 't1' };
const admin = { actor_id: 'a', active_role: 'admin', tenant_id: 't1' };
const COMMUNITY_FLAG = { enabled: true, planes: ['internal', 'system_autopilot', 'member'], monthly_budget_usd: 50 };

// 1M input tokens at the Jev rate (~$0.042) per call.
function okCall(answers: any, input_tokens = 1_000_000): JevCallResult {
  return { ok: true, model: 'jev-1.13.0', answers, usage: { input_tokens, output_tokens: 2 }, latency_ms: 40, attempts: 1 };
}
const ticket = () =>
  okCall({
    category: { type: 'choice', choice: 'billing', probabilities: { billing: 0.95 }, confidence: 0.95 },
    urgency: { type: 'score', score: 1, probabilities: [0.1, 0.8, 0.05, 0.05], confidence: 0.8 },
  });
const moderation = () =>
  okCall({
    category: { type: 'choice', choice: 'spam', probabilities: { spam: 0.9 }, confidence: 0.9 },
    severity: { type: 'score', score: 2, probabilities: [0.05, 0.1, 0.7, 0.1, 0.05], confidence: 0.7 },
  });
const flush = () => new Promise((s) => setImmediate(s));

beforeEach(() => {
  emitted.length = 0;
  pages.length = 0;
  resetJevStatsForTest();
  resetBudgetAlertsForTest();
});

describe('VTID-04857 which spend a tenant budget caps', () => {
  test('member, patient and partner_org are budgeted; internal and system_autopilot never are', () => {
    expect([...JEV_BUDGETED_PLANES].sort()).toEqual(['member', 'partner_org', 'patient']);
    expect(isJevBudgetedPlane('internal')).toBe(false);
    expect(isJevBudgetedPlane('system_autopilot')).toBe(false);
  });

  test('member content counts as member spend whoever runs it', () => {
    expect(jevSpendPlane('internal', 'member_content')).toBe('member');
    expect(jevSpendPlane('system_autopilot', 'member_content')).toBe('member');
    expect(jevSpendPlane('internal', 'business')).toBe('internal');
    expect(jevSpendPlane('system_autopilot', 'telemetry')).toBe('system_autopilot');
    expect(jevSpendPlane('partner_org', 'business')).toBe('partner_org');
  });
});

describe('VTID-04857 decide()', () => {
  test('an exhausted community budget does not stop internal calls', async () => {
    const mem = createMemoryJevControl({ t1: COMMUNITY_FLAG }, { t1: { member: 50, internal: 900 } });
    const call = jest.fn().mockResolvedValue(ticket());
    const r = await decide('support_ticket_triage', { body: 'charged twice' }, staff, { source: 't', call, env: ENV, control: mem.control });
    expect(r).toMatchObject({ ok: true, outcome: 'decided', plane: 'internal' });
    expect(mem.records[0]).toMatchObject({ tenantId: 't1', plane: 'internal' });
  });

  test('internal spend does not use up the community budget', async () => {
    const mem = createMemoryJevControl({ t1: COMMUNITY_FLAG }, { t1: { internal: 900, system_autopilot: 400, member: 10 } });
    const call = jest.fn().mockResolvedValue(moderation());
    const r = await decide('moderation_severity', { content: 'buy now' }, admin, { source: 't', call, env: ENV, control: mem.control });
    expect(r).toMatchObject({ ok: true, outcome: 'decided' });
    expect(mem.records[0]).toMatchObject({ tenantId: 't1', plane: 'member' });
  });

  test('at 100% member decisions fall back to rules with 429 and no Jev call', async () => {
    const mem = createMemoryJevControl({ t1: COMMUNITY_FLAG }, { t1: { member: 50 } });
    const call = jest.fn();
    const r = await decide('moderation_severity', { content: 'buy now' }, admin, { source: 't', call, env: ENV, control: mem.control });
    expect(r).toMatchObject({ ok: false, outcome: 'fallback', reason: 'tenant_budget_exhausted', status: 429 });
    expect(call).not.toHaveBeenCalled();
  });

  test('the call that crosses 80% pages the owner once, with an OASIS event', async () => {
    // $39.98 spent; one ~$0.042 call crosses $40 (80% of $50).
    const mem = createMemoryJevControl({ t1: COMMUNITY_FLAG }, { t1: { member: 39.98 } });
    const call = jest.fn().mockResolvedValue(moderation());
    await decide('moderation_severity', { content: 'buy now' }, admin, { source: 't', call, env: ENV, control: mem.control });
    await flush();
    await flush();
    const alerts = emitted.filter((e) => e.type === 'jev.budget.threshold_crossed');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ vtid: 'VTID-04857', status: 'warning', payload: { tenant_id: 't1', level_pct: 80, budget_usd: 50 } });
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain('80%');
    // The next call stays above 80% and below 100%: no new page.
    await decide('moderation_severity', { content: 'buy now' }, admin, { source: 't', call, env: ENV, control: mem.control });
    await flush();
    await flush();
    expect(pages).toHaveLength(1);
  });

  test('internal calls never page about a budget', async () => {
    const mem = createMemoryJevControl({ t1: COMMUNITY_FLAG }, { t1: { member: 39.98, internal: 39.98 } });
    await decide('support_ticket_triage', { body: 'x' }, staff, { source: 't', call: jest.fn().mockResolvedValue(ticket()), env: ENV, control: mem.control });
    await flush();
    await flush();
    expect(emitted.filter((e) => e.type === 'jev.budget.threshold_crossed')).toEqual([]);
    expect(pages).toEqual([]);
  });
});

describe('VTID-04857 alert levels', () => {
  test('crossings are reported only on the step that crosses', () => {
    expect(crossedBudgetLevels(39, 41, 50)).toEqual([0.8]);
    expect(crossedBudgetLevels(41, 49, 50)).toEqual([]);
    expect(crossedBudgetLevels(49.99, 50, 50)).toEqual([1]);
    expect(crossedBudgetLevels(10, 60, 50)).toEqual([0.8, 1]);
    expect(crossedBudgetLevels(10, 60, null)).toEqual([]);
    expect(crossedBudgetLevels(0, 1, 0)).toEqual([]);
  });

  test('100% is an error-level page saying member decisions fall back to rules', async () => {
    const page = jest.fn(async () => undefined);
    const emit = jest.fn(async () => ({ ok: true }));
    const levels = await maybeRaiseBudgetAlerts(
      { tenantId: 't1', budgetUsd: 10, spentBeforeUsd: 9.99, costUsd: 0.02, now: new Date('2026-10-03T10:00:00Z') },
      { page, emit, alreadyRaised: async () => false },
    );
    expect(levels).toEqual([1]);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', payload: expect.objectContaining({ alert_key: 't1:2026-10-01:100', level_pct: 100 }) }));
    expect((page.mock.calls[0] as any)[0]).toContain('fall back to rules');
  });

  test('an alert another gateway task already raised is not raised again', async () => {
    const page = jest.fn(async () => undefined);
    const emit = jest.fn(async () => ({ ok: true }));
    const levels = await maybeRaiseBudgetAlerts({ tenantId: 't1', budgetUsd: 10, spentBeforeUsd: 7.9, costUsd: 0.2 }, { page, emit, alreadyRaised: async () => true });
    expect(levels).toEqual([]);
    expect(page).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  test('a failing page never throws', async () => {
    const levels = await maybeRaiseBudgetAlerts(
      { tenantId: 't2', budgetUsd: 10, spentBeforeUsd: 7.9, costUsd: 0.2 },
      { page: async () => { throw new Error('down'); }, emit: async () => ({ ok: true }), alreadyRaised: async () => false },
    );
    expect(levels).toEqual([]);
  });
});
