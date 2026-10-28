/**
 * ApiConnector (CONN-API-0002, runbook Sec. 4.4).
 *
 * Native-API adapter for post-registration operations. Talks to providers through
 * a swappable `ApiClient` interface so the specific vendor SDK (SP-API, eBay,
 * Walmart, CJ, …) is pluggable and so CI/dev run against MOCKS only — never live
 * calls (Sec. 0.5/0.8). Vendor SDK/auth verification is pending (DECISIONS VER-002,
 * BLOCKERS BLK-002); this ships the mock stubs to the interface.
 *
 * All guardrails are enforced by BaseConnector before any `do*` hook runs.
 */
import { BaseConnector } from './base-connector';
import {
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
import { PolicyEngine } from '../guardrails/policy-engine';

/** The vendor boundary. A real impl wraps SP-API/eBay/etc.; the mock impl is for tests/dev. */
export interface ApiClient {
  /** Provider id this client serves (e.g. 'amazon', 'ebay'). */
  providerId: string;
  operate(action: OperateAction, ctx: JobContext): Promise<OperateResult>;
  healthCheck(account: ProviderAccount): Promise<HealthResult>;
  /** Optional post-registration verification (e.g. confirm API credentials work). */
  verify?(ctx: JobContext): Promise<VerifyResult>;
}

export class ApiConnector extends BaseConnector {
  constructor(policyEngine: PolicyEngine, private readonly client: ApiClient) {
    super(policyEngine);
  }

  mode(): ConnectorMode {
    return 'api';
  }

  /**
   * API providers do not self-register — registration is human-gated (BaseConnector
   * routes human_required registration to a human_task before this runs). If policy
   * somehow permits an automated path, we still surface a human submit task for the
   * irreversible account-creation step rather than fabricating one.
   */
  protected async doRegister(_identity: BusinessIdentity, ctx: JobContext): Promise<RegisterResult> {
    this.requireHuman('IRREVERSIBLE_SUBMIT', ctx, { providerId: ctx.providerId, reason: 'api account registration' });
  }

  protected async doVerify(ctx: JobContext): Promise<VerifyResult> {
    if (this.client.verify) return this.client.verify(ctx);
    return { verified: true, details: { via: 'api', providerId: ctx.providerId } };
  }

  protected async doOperate(action: OperateAction, ctx: JobContext): Promise<OperateResult> {
    return this.client.operate(action, ctx);
  }

  protected async doHealthCheck(account: ProviderAccount): Promise<HealthResult> {
    return this.client.healthCheck(account);
  }
}

/**
 * Mock API client — a sandbox stub standing in for a real vendor SDK. Echoes the
 * action so a round-trip can be asserted; reports healthy. Used for tests/dev and
 * as the placeholder for SP-API/eBay/Walmart/CJ until real clients are wired
 * (BLK-002).
 */
export class MockApiClient implements ApiClient {
  constructor(public readonly providerId: string) {}

  async operate(action: OperateAction, ctx: JobContext): Promise<OperateResult> {
    return {
      ok: true,
      data: { provider: this.providerId, action: action.kind, echoed: action.payload ?? null, accountId: ctx.accountId ?? null },
    };
  }

  async healthCheck(account: ProviderAccount): Promise<HealthResult> {
    return { status: 'healthy', details: { provider: this.providerId, accountId: account.id } };
  }
}

/** Provider stubs (post-registration) for the API-class providers (mocks for now). */
export const API_PROVIDER_STUBS = ['amazon', 'ebay', 'walmart', 'cj'] as const;
export type ApiProviderStub = (typeof API_PROVIDER_STUBS)[number];

/** Build a mock ApiConnector for a given provider stub. */
export function mockApiConnector(policyEngine: PolicyEngine, providerId: string): ApiConnector {
  return new ApiConnector(policyEngine, new MockApiClient(providerId));
}
