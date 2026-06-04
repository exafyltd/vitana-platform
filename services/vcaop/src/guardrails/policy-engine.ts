/**
 * Per-provider policy engine (runbook Sec. 3, Sec. 4.3).
 *
 * Gates every provider action. DEFAULT DENY: an unknown provider, or an unknown
 * action, is denied until an explicit policy row exists.
 */
import { PolicyDenied } from './errors';

export type AutomationAllowed =
  | 'api_only'
  | 'oauth_only'
  | 'browser_with_human_submit'
  | 'manual_only'
  | 'denied';

export type RegistrationMethod = 'human_required' | 'api' | 'oauth';
export type CaptchaPolicy = 'human_only';

export interface ProviderPolicy {
  automation_allowed: AutomationAllowed;
  registration_method: RegistrationMethod;
  captcha_policy: CaptchaPolicy;
  kyb_required: boolean;
  multi_account_allowed: boolean;
  /** null = unknown/unset; cashback gated off until explicitly true. */
  affiliate_cashback_allowed: boolean | null;
  /** Source ToS URL + date reviewed (Sec. 4.3). */
  notes: string;
}

/**
 * Action verbs a connector may attempt. Mapped to the automation level they need.
 * Anything not in this map is unknown => denied.
 */
export type ProviderAction =
  | 'register'
  | 'verify'
  | 'operate_api'
  | 'operate_oauth'
  | 'operate_browser'
  | 'operate_manual'
  | 'cashback';

/** Minimum automation level each action requires, expressed as the allowed set. */
const ACTION_REQUIREMENTS: Record<ProviderAction, AutomationAllowed[]> = {
  // Registration of major providers is human-gated by default; only allowed when
  // the policy explicitly permits an automated path.
  register: ['api_only', 'oauth_only'],
  verify: ['api_only', 'oauth_only', 'browser_with_human_submit', 'manual_only'],
  operate_api: ['api_only'],
  operate_oauth: ['oauth_only', 'api_only'],
  operate_browser: ['browser_with_human_submit'],
  operate_manual: ['manual_only', 'browser_with_human_submit', 'api_only', 'oauth_only'],
  cashback: ['api_only', 'oauth_only', 'browser_with_human_submit', 'manual_only'],
};

/** The fail-closed default applied to any provider with no registered policy. */
export const DENY_ALL_POLICY: ProviderPolicy = Object.freeze({
  automation_allowed: 'denied',
  registration_method: 'human_required',
  captcha_policy: 'human_only',
  kyb_required: true,
  multi_account_allowed: false,
  affiliate_cashback_allowed: null,
  notes: 'default-deny (no policy row)',
});

export class PolicyEngine {
  private readonly policies = new Map<string, ProviderPolicy>();

  /** Register/replace a provider policy. */
  setPolicy(providerId: string, policy: ProviderPolicy): void {
    this.policies.set(providerId, policy);
  }

  hasPolicy(providerId: string): boolean {
    return this.policies.has(providerId);
  }

  /** Returns the explicit policy or the fail-closed DENY_ALL default. */
  getPolicy(providerId: string): ProviderPolicy {
    return this.policies.get(providerId) ?? DENY_ALL_POLICY;
  }

  /**
   * Throws PolicyDenied unless the provider has an explicit policy that permits
   * the action. Default-deny on unknown provider or unknown action.
   */
  assertActionAllowed(providerId: string, action: ProviderAction): void {
    if (!this.policies.has(providerId)) {
      throw new PolicyDenied(`Provider "${providerId}" has no policy — default deny`);
    }
    const policy = this.policies.get(providerId)!;

    const requirement = ACTION_REQUIREMENTS[action as ProviderAction];
    if (!requirement) {
      throw new PolicyDenied(`Unknown action "${action}" for provider "${providerId}" — default deny`);
    }

    if (policy.automation_allowed === 'denied') {
      throw new PolicyDenied(`Provider "${providerId}" automation is denied by policy`);
    }

    if (action === 'cashback' && policy.affiliate_cashback_allowed !== true) {
      throw new PolicyDenied(
        `Cashback not allowed for "${providerId}" (affiliate_cashback_allowed=${policy.affiliate_cashback_allowed})`,
      );
    }

    if (!requirement.includes(policy.automation_allowed)) {
      throw new PolicyDenied(
        `Action "${action}" needs one of [${requirement.join(', ')}]; ` +
          `provider "${providerId}" is "${policy.automation_allowed}"`,
      );
    }
  }
}
