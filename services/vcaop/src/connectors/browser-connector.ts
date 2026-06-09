/**
 * BrowserConnector (CONN-BROWSER-0004, runbook Sec. 4.4).
 *
 * Browser-automation fallback (Skyvern primary / Stagehand cached flows) over a
 * swappable `BrowserDriver`. Guarantees:
 *  - isolated profile per (provider, account) — no shared browser state
 *  - every artifact (screenshot text/DOM dump) is scrubbed via no-pii-leak and
 *    asserted PII-free before it leaves the connector (Sec. 9)
 *  - any CAPTCHA -> CaptchaEncountered -> human task (never solved, Sec. 0.3 #3)
 *  - any irreversible submit -> human gate (Sec. 3)
 *  - live runs are disabled unless explicitly allowed (mock/fixture-only in CI, Sec. 0.5)
 *
 * Vendor (Skyvern/Stagehand) availability/auth is unverified here — mock-to-interface
 * per Sec. 0.8 (see DECISIONS/BLOCKERS). Guardrails enforced by BaseConnector first.
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
import { scrubBrowserArtifact } from '../guardrails/no-pii-leak';

export interface BrowserArtifact {
  kind: string; // 'screenshot' | 'dom' | 'log'
  content: unknown; // may contain PII pre-scrub
}

export interface BrowserFlowResult {
  ok: boolean;
  data?: Record<string, unknown>;
  artifacts?: BrowserArtifact[];
  captcha?: boolean;
  irreversible?: boolean;
}

export interface BrowserDriver {
  providerId: string;
  /** True for a real driver hitting live sites; mock/fixture drivers are false. */
  isLive?: boolean;
  runFlow(flow: string, profileId: string, ctx: JobContext): Promise<BrowserFlowResult>;
}

export interface BrowserConnectorOptions {
  /** Allow a live driver. Default false -> live disabled (CI/dev mock-only). */
  allowLive?: boolean;
}

export class BrowserConnector extends BaseConnector {
  private readonly allowLive: boolean;

  constructor(policyEngine: PolicyEngine, private readonly driver: BrowserDriver, opts: BrowserConnectorOptions = {}) {
    super(policyEngine);
    this.allowLive = opts.allowLive ?? false;
  }

  mode(): ConnectorMode {
    return 'browser';
  }

  /** Isolated browser profile per (provider, account) — never shared. */
  private profileFor(ctx: JobContext): string {
    return `vcaop/${ctx.providerId}/${ctx.accountId ?? 'no-account'}`;
  }

  private assertLiveAllowed(): void {
    if (this.driver.isLive && !this.allowLive) {
      throw new Error('live browser automation is disabled (mock/fixture only in CI/dev) — Sec. 0.5');
    }
  }

  /** Run a flow, enforce CAPTCHA/irreversible gates, scrub artifacts before returning. */
  private async runScrubbed(flow: string, ctx: JobContext): Promise<{ result: BrowserFlowResult; artifacts: BrowserArtifact[] }> {
    this.assertLiveAllowed();
    const result = await this.driver.runFlow(flow, this.profileFor(ctx), ctx);
    if (result.captcha) this.onCaptcha(`${flow}`); // throws CaptchaEncountered -> human task
    if (result.irreversible) this.requireHuman('IRREVERSIBLE_SUBMIT', ctx, { providerId: ctx.providerId, flow });
    const artifacts = (result.artifacts ?? []).map((a) => ({ kind: a.kind, content: scrubBrowserArtifact(a.content) }));
    return { result, artifacts };
  }

  protected async doRegister(_identity: BusinessIdentity, ctx: JobContext): Promise<RegisterResult> {
    // Browser registration is an irreversible submit -> always human-gated.
    this.requireHuman('IRREVERSIBLE_SUBMIT', ctx, { providerId: ctx.providerId, reason: 'browser registration submit' });
  }

  protected async doVerify(ctx: JobContext): Promise<VerifyResult> {
    const { result, artifacts } = await this.runScrubbed('verify', ctx);
    return { verified: result.ok, details: { artifacts } };
  }

  protected async doOperate(action: OperateAction, ctx: JobContext): Promise<OperateResult> {
    const { result, artifacts } = await this.runScrubbed(action.kind, ctx);
    return { ok: result.ok, data: { ...(result.data ?? {}), artifacts } };
  }

  protected async doHealthCheck(account: ProviderAccount): Promise<HealthResult> {
    return { status: 'unknown', details: { providerId: account.providerId, note: 'browser health is best-effort' } };
  }
}

/** Mock browser driver — fixture-based, never live. Configurable per test. */
export class MockBrowserDriver implements BrowserDriver {
  isLive = false;
  nextCaptcha = false;
  nextIrreversible = false;
  /** Artifacts to return (may contain PII to prove scrubbing). */
  artifacts: BrowserArtifact[] = [];
  seenProfiles: string[] = [];
  constructor(public readonly providerId: string) {}

  async runFlow(flow: string, profileId: string, _ctx: JobContext): Promise<BrowserFlowResult> {
    this.seenProfiles.push(profileId);
    return {
      ok: true,
      data: { flow, profileId },
      artifacts: this.artifacts,
      captcha: this.nextCaptcha,
      irreversible: this.nextIrreversible,
    };
  }
}
