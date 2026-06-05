import { BaseConnector } from '../../src/connectors/base-connector';
import { ConnectorMode, JobContext, OperateAction, BusinessIdentity, ProviderAccount } from '../../src/connectors/Connector';
import { PolicyEngine, ProviderPolicy } from '../../src/guardrails/policy-engine';
import { PolicyDenied, HumanTaskRequired, EnvBoundaryViolation, CaptchaEncountered } from '../../src/guardrails/errors';
import { HumanTask } from '../../src/guardrails/human-gate';

// A concrete connector whose hooks record that they ran, so we can prove the gates
// fire BEFORE adapter logic.
class TestConnector extends BaseConnector {
  ran: string[] = [];
  captchaOnOperate = false;
  constructor(pe: PolicyEngine, private _mode: ConnectorMode = 'api') {
    super(pe);
  }
  mode(): ConnectorMode {
    return this._mode;
  }
  protected async doRegister(_i: BusinessIdentity, _c: JobContext) {
    this.ran.push('doRegister');
    return { status: 'submitted' as const };
  }
  protected async doVerify(_c: JobContext) {
    this.ran.push('doVerify');
    return { verified: true };
  }
  protected async doOperate(_a: OperateAction, _c: JobContext) {
    if (this.captchaOnOperate) this.onCaptcha('operate');
    this.ran.push('doOperate');
    return { ok: true };
  }
  protected async doHealthCheck(_a: ProviderAccount) {
    this.ran.push('doHealthCheck');
    return { status: 'healthy' as const };
  }
}

const policy = (over: Partial<ProviderPolicy>): ProviderPolicy => ({
  automation_allowed: 'api_only',
  registration_method: 'api',
  captcha_policy: 'human_only',
  kyb_required: false,
  multi_account_allowed: false,
  affiliate_cashback_allowed: null,
  notes: 't',
  ...over,
});

function ctx(over: Partial<JobContext> = {}): { ctx: JobContext; tasks: HumanTask[] } {
  const tasks: HumanTask[] = [];
  return {
    tasks,
    ctx: { providerId: 'p', tenantId: 'platform', env: { VCAOP_ENV: 'dev' }, emitHumanTask: (t) => tasks.push(t), ...over },
  };
}

describe('CONN-BASE-0001 — gates are not bypassable', () => {
  test('env boundary: refuses outside dev/staging before adapter runs', async () => {
    const pe = new PolicyEngine();
    pe.setPolicy('p', policy({}));
    const c = new TestConnector(pe);
    const { ctx: c1 } = ctx({ env: {} }); // unset env => prod
    await expect(c.operate({ kind: 'x' }, c1)).rejects.toBeInstanceOf(EnvBoundaryViolation);
    expect(c.ran).not.toContain('doOperate');
  });

  test('policy default-deny: unknown provider blocked before adapter runs', async () => {
    const c = new TestConnector(new PolicyEngine());
    const { ctx: c1 } = ctx();
    await expect(c.operate({ kind: 'x' }, c1)).rejects.toBeInstanceOf(PolicyDenied);
    expect(c.ran).toHaveLength(0);
  });

  test('operate mode mismatch is policy-denied (browser op on api_only)', async () => {
    const pe = new PolicyEngine();
    pe.setPolicy('p', policy({ automation_allowed: 'api_only' }));
    const c = new TestConnector(pe, 'browser');
    const { ctx: c1 } = ctx();
    await expect(c.operate({ kind: 'x' }, c1)).rejects.toBeInstanceOf(PolicyDenied);
  });

  test('human-required registration emits a human_task and halts', async () => {
    const pe = new PolicyEngine();
    pe.setPolicy('p', policy({ registration_method: 'human_required', kyb_required: true }));
    const c = new TestConnector(pe);
    const { ctx: c1, tasks } = ctx();
    await expect(c.register({ tenantId: 'platform', legalName: 'X', entityType: 'ltd' }, c1)).rejects.toBeInstanceOf(HumanTaskRequired);
    expect(tasks.map((t) => t.type)).toContain('KYB');
    expect(c.ran).not.toContain('doRegister');
  });

  test('allowed api operate runs the adapter hook', async () => {
    const pe = new PolicyEngine();
    pe.setPolicy('p', policy({ automation_allowed: 'api_only' }));
    const c = new TestConnector(pe, 'api');
    const { ctx: c1 } = ctx();
    const r = await c.operate({ kind: 'list' }, c1);
    expect(r.ok).toBe(true);
    expect(c.ran).toContain('doOperate');
  });

  test('CAPTCHA encountered in adapter throws CaptchaEncountered (never solved)', async () => {
    const pe = new PolicyEngine();
    pe.setPolicy('p', policy({ automation_allowed: 'api_only' }));
    const c = new TestConnector(pe, 'api');
    c.captchaOnOperate = true;
    const { ctx: c1 } = ctx();
    await expect(c.operate({ kind: 'x' }, c1)).rejects.toBeInstanceOf(CaptchaEncountered);
  });

  test('healthCheck is bounded by env but not policy-gated', async () => {
    const c = new TestConnector(new PolicyEngine());
    const acct: ProviderAccount = { id: 'a', tenantId: 'platform', providerId: 'p', status: 'active' };
    process.env.VCAOP_ENV = 'dev';
    const r = await c.healthCheck(acct);
    expect(r.status).toBe('healthy');
    delete process.env.VCAOP_ENV;
  });
});
