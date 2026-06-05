/**
 * BaseConnector (CONN-BASE-0001, runbook Sec. 4.4).
 *
 * Enforces the guardrails on EVERY method BEFORE the adapter's own logic runs, so a
 * concrete adapter cannot bypass them:
 *  - env-boundary  : refuses to act outside dev/staging
 *  - policy-engine : default-deny; action must be allowed for the provider
 *  - human-gate    : human-required registration / steps emit a human_task and halt
 *  - CAPTCHA        : onCaptcha() always throws CaptchaEncountered (-> human task)
 *
 * Concrete adapters implement the `do*` hooks only; they never see an ungated call.
 */
import {
  Connector,
  ConnectorMode,
  BusinessIdentity,
  JobContext,
  OperateAction,
  RegisterResult,
  VerifyResult,
  OperateResult,
  HealthResult,
  ProviderAccount,
} from './connector';
import { PolicyEngine, ProviderAction } from '../guardrails/policy-engine';
import { assertDevEnvironment } from '../guardrails/env-boundary';
import { enforceHumanGate, HumanRequiredAction } from '../guardrails/human-gate';
import { CaptchaAwareConnectorBase } from '../guardrails/no-captcha-solve';

const OPERATE_ACTION_BY_MODE: Record<ConnectorMode, ProviderAction> = {
  api: 'operate_api',
  oauth: 'operate_oauth',
  scim: 'operate_manual',
  browser: 'operate_browser',
  manual: 'operate_manual',
};

export abstract class BaseConnector extends CaptchaAwareConnectorBase implements Connector {
  constructor(protected readonly policyEngine: PolicyEngine) {
    super();
  }

  abstract mode(): ConnectorMode;

  // ---- Adapter hooks (implemented by concrete connectors) --------------------
  protected abstract doRegister(identity: BusinessIdentity, ctx: JobContext): Promise<RegisterResult>;
  protected abstract doVerify(ctx: JobContext): Promise<VerifyResult>;
  protected abstract doOperate(action: OperateAction, ctx: JobContext): Promise<OperateResult>;
  protected abstract doHealthCheck(account: ProviderAccount): Promise<HealthResult>;

  // ---- Gate helpers available to adapters ------------------------------------
  /** Route a HUMAN_REQUIRED step to a human task and halt (Sec. 3 human-gate). */
  protected requireHuman(action: HumanRequiredAction, ctx: JobContext, payload?: Record<string, unknown>): never {
    enforceHumanGate(action, ctx.emitHumanTask, { payload, assignee: undefined });
    // enforceHumanGate throws for a gated action; this is unreachable.
    throw new Error('unreachable');
  }

  // ---- Gated public surface --------------------------------------------------
  async register(identity: BusinessIdentity, ctx: JobContext): Promise<RegisterResult> {
    assertDevEnvironment(ctx.env);
    this.policyEngine.assertActionAllowed(ctx.providerId, 'register');
    const policy = this.policyEngine.getPolicy(ctx.providerId);
    if (policy.registration_method === 'human_required') {
      // Major-provider registration is human-gated by default (Sec. 10).
      this.requireHuman(policy.kyb_required ? 'KYB' : 'IRREVERSIBLE_SUBMIT', ctx, { providerId: ctx.providerId });
    }
    return this.doRegister(identity, ctx);
  }

  async verify(ctx: JobContext): Promise<VerifyResult> {
    assertDevEnvironment(ctx.env);
    this.policyEngine.assertActionAllowed(ctx.providerId, 'verify');
    return this.doVerify(ctx);
  }

  async operate(action: OperateAction, ctx: JobContext): Promise<OperateResult> {
    assertDevEnvironment(ctx.env);
    this.policyEngine.assertActionAllowed(ctx.providerId, OPERATE_ACTION_BY_MODE[this.mode()]);
    return this.doOperate(action, ctx);
  }

  async healthCheck(account: ProviderAccount): Promise<HealthResult> {
    // Health checks are read-only; still bounded by the env boundary.
    assertDevEnvironment();
    return this.doHealthCheck(account);
  }
}
