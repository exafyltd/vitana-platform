import { Conductor } from '../../src/agents/conductor';
import { Worker } from '../../src/agents/worker';
import { Validator } from '../../src/agents/validator';
import { Monetization, AffiliateProgramOption } from '../../src/agents/monetization';
import { DEFAULT_MODEL_BY_ROLE } from '../../src/agents/llm-router';
import { PolicyEngine, ProviderPolicy } from '../../src/guardrails/policy-engine';
import { mockApiConnector } from '../../src/connectors/api-connector';
import { ManualConnector } from '../../src/connectors/manual-connector';
import { JobContext } from '../../src/connectors/connector';
import { HumanTask } from '../../src/guardrails/human-gate';

const policy = (o: Partial<ProviderPolicy>): ProviderPolicy => ({
  automation_allowed: 'api_only',
  registration_method: 'human_required',
  captcha_policy: 'human_only',
  kyb_required: true,
  multi_account_allowed: false,
  affiliate_cashback_allowed: null,
  notes: 't',
  ...o,
});

function ctx(providerId: string): { ctx: JobContext; tasks: HumanTask[] } {
  const tasks: HumanTask[] = [];
  return { tasks, ctx: { providerId, tenantId: 'platform', accountId: 'acc1', env: { VCAOP_ENV: 'dev' }, emitHumanTask: (t) => tasks.push(t) } };
}

describe('AGNT-CONDUCT-0001 — Conductor', () => {
  test('plans onboarding honoring policy tier + PLANNER routing', () => {
    const pe = new PolicyEngine();
    pe.setPolicy('amazon', policy({ automation_allowed: 'api_only' }));
    const plan = new Conductor(pe).planJob('amazon', 'onboard');
    expect(plan.connectorTier).toBe('api');
    expect(plan.plannerModel).toBe(DEFAULT_MODEL_BY_ROLE.PLANNER);
    expect(plan.steps.find((s) => s.kind === 'register')!.humanGated).toBe(true);
    expect(plan.steps.some((s) => s.kind === 'kyb' && s.humanGated)).toBe(true);
  });

  test('maps each automation level to the right connector tier', () => {
    const pe = new PolicyEngine();
    pe.setPolicy('a', policy({ automation_allowed: 'oauth_only' }));
    pe.setPolicy('b', policy({ automation_allowed: 'browser_with_human_submit' }));
    pe.setPolicy('c', policy({ automation_allowed: 'manual_only' }));
    expect(new Conductor(pe).planJob('a', 'operate').connectorTier).toBe('oauth');
    expect(new Conductor(pe).planJob('b', 'operate').connectorTier).toBe('browser');
    expect(new Conductor(pe).planJob('c', 'operate').connectorTier).toBe('manual');
  });

  test('refuses to plan a denied provider', () => {
    const pe = new PolicyEngine();
    pe.setPolicy('x', policy({ automation_allowed: 'denied' }));
    expect(() => new Conductor(pe).planJob('x', 'operate')).toThrow(/denied/);
  });
});

describe('AGNT-WORKER-0002 — Worker', () => {
  test('mock onboarding end-to-end: human-gated steps block, others done', async () => {
    const pe = new PolicyEngine();
    pe.setPolicy('amazon', policy({ automation_allowed: 'api_only', registration_method: 'human_required', kyb_required: true }));
    const plan = new Conductor(pe).planJob('amazon', 'onboard');
    const connector = mockApiConnector(pe, 'amazon');
    const { ctx: c } = ctx('amazon');
    const r = await new Worker().executePlan(plan, connector, c, { identity: { tenantId: 'platform', legalName: 'X', entityType: 'ltd' } });
    expect(r.status).toBe('blocked'); // register + kyb are human-gated
    expect(r.steps.find((s) => s.kind === 'register')!.status).toBe('human_required');
    expect(r.workerModel).toBe(DEFAULT_MODEL_BY_ROLE.WORKER);
  });

  test('mock cart route end-to-end via api operate', async () => {
    const pe = new PolicyEngine();
    pe.setPolicy('amazon', policy({ automation_allowed: 'api_only' }));
    const plan = new Conductor(pe).planJob('amazon', 'operate');
    const connector = mockApiConnector(pe, 'amazon');
    const { ctx: c } = ctx('amazon');
    const r = await new Worker().executePlan(plan, connector, c, { operateAction: { kind: 'route_cart', payload: { merchant: 'amazon' } } });
    expect(r.status).toBe('completed');
    expect((r.data.operate as any).ok).toBe(true);
  });

  test('manual connector onboarding blocks on human task', async () => {
    const pe = new PolicyEngine();
    pe.setPolicy('target', policy({ automation_allowed: 'manual_only' }));
    const plan = new Conductor(pe).planJob('target', 'onboard');
    const connector = new ManualConnector(pe);
    const { ctx: c } = ctx('target');
    const r = await new Worker().executePlan(plan, connector, c, { identity: { tenantId: 'platform', legalName: 'X', entityType: 'ltd' } });
    expect(r.status).toBe('blocked');
  });
});

describe('AGNT-VALID-0003 — Validator', () => {
  test('rejects an execution where a human-gated step was auto-completed', () => {
    const v = new Validator();
    const plan = [{ kind: 'register', humanGated: true }, { kind: 'verify' }];
    const bad = v.validateExecution(plan, [{ kind: 'register', status: 'done' }, { kind: 'verify', status: 'done' }]);
    expect(bad.ok).toBe(false);
    const good = v.validateExecution(plan, [{ kind: 'register', status: 'human_required' }, { kind: 'verify', status: 'done' }]);
    expect(good.ok).toBe(true);
    expect(good.validatorModel).toBe(DEFAULT_MODEL_BY_ROLE.VALIDATOR);
  });

  test('refuses to confirm a commission without a verified postback', () => {
    const v = new Validator();
    expect(v.canConfirmCommission({ status: 'pending', postbackRef: null })).toBe(false);
    expect(v.canConfirmCommission({ status: 'pending', postbackRef: 'pb_123' })).toBe(true);
    expect(() => v.assertConfirmable({ status: 'pending' })).toThrow(/postback/);
  });
});

describe('AGNT-MONET-0004 — Monetization', () => {
  const programs: AffiliateProgramOption[] = [
    { id: 'agg1', network: 'skimlinks', merchant: 'shopx', source: 'aggregator', affiliateCashbackAllowed: true, commissionRate: 0.04 },
    { id: 'dir1', network: 'awin', merchant: 'shopx', source: 'direct', affiliateCashbackAllowed: true, commissionRate: 0.06 },
    { id: 'nocb', network: 'amazon_associates', merchant: 'shopx', source: 'direct', affiliateCashbackAllowed: false, commissionRate: 0.10 },
  ];

  test('picks the highest-commission cashback-eligible program (never a cashback=false one)', () => {
    const sel = new Monetization().selectRoute('u1', programs, { amount: 100, cashback: true })!;
    expect(sel.program.id).toBe('dir1'); // 6% beats 4%; nocb (10%) excluded for cashback
    expect(sel.subId).toMatch(/^sub_/);
    expect(sel.projectedReward).toBeCloseTo(100 * 0.06 * 0.5, 4);
  });

  test('never selects affiliate_cashback_allowed=false for cashback even if higher rate', () => {
    const sel = new Monetization().selectRoute('u1', programs, { amount: 100, cashback: true })!;
    expect(sel.program.affiliateCashbackAllowed).toBe(true);
  });

  test('subId is deterministic per (user, program)', () => {
    const m = new Monetization();
    const a = m.selectRoute('u1', programs, { amount: 50, cashback: true })!;
    const b = m.selectRoute('u1', programs, { amount: 999, cashback: true })!;
    expect(a.subId).toBe(b.subId);
  });

  test('returns null when no eligible program', () => {
    const m = new Monetization();
    const onlyNoCb = [programs[2]];
    expect(m.selectRoute('u1', onlyNoCb, { amount: 100, cashback: true })).toBeNull();
  });
});
