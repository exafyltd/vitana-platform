/**
 * VCAOP guardrail errors (runbook Sec. 3).
 *
 * Every guardrail throws loudly. A thrown guardrail error is a HARD stop for the
 * offending operation — it must never be swallowed to make a feature pass
 * (runbook Sec. 0.3, Sec. 11.3). Errors carry a stable `code` for tests/telemetry.
 */

export type GuardrailCode =
  | 'POLICY_DENIED'
  | 'ENV_BOUNDARY'
  | 'CREDENTIAL_STORE'
  | 'PII_LEAK'
  | 'HUMAN_TASK_REQUIRED'
  | 'CAPTCHA_ENCOUNTERED'
  | 'SINGLE_IDENTITY'
  | 'ACCOUNT_MARKET'
  | 'LOYALTY_GUARD'
  | 'COST_CAP_EXCEEDED';

/** Base class for every guardrail violation. */
export class GuardrailError extends Error {
  readonly code: GuardrailCode;
  /** True when the right response is to escalate to a human (Tier-B), not retry. */
  readonly tierB: boolean;

  constructor(code: GuardrailCode, message: string, opts?: { tierB?: boolean }) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.tierB = opts?.tierB ?? false;
    // Keep prototype chain intact under ts/commonjs.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class PolicyDenied extends GuardrailError {
  constructor(message: string) {
    super('POLICY_DENIED', message);
  }
}

export class EnvBoundaryViolation extends GuardrailError {
  constructor(message: string) {
    super('ENV_BOUNDARY', message, { tierB: true });
  }
}

export class CredentialStoreViolation extends GuardrailError {
  constructor(message: string) {
    super('CREDENTIAL_STORE', message);
  }
}

export class PiiLeakError extends GuardrailError {
  constructor(message: string) {
    super('PII_LEAK', message);
  }
}

/**
 * Thrown when a connector step hits a HUMAN_REQUIRED action (Sec. 3 `human-gate`).
 * The connector MUST have emitted a `human_task` before/as this is thrown.
 */
export class HumanTaskRequired extends GuardrailError {
  readonly action: string;
  constructor(action: string, message?: string) {
    super('HUMAN_TASK_REQUIRED', message ?? `Human task required for action: ${action}`);
    this.action = action;
  }
}

/** Thrown when a connector encounters a CAPTCHA (Sec. 3 `no-captcha-solve`). Never solve it. */
export class CaptchaEncountered extends GuardrailError {
  constructor(message = 'CAPTCHA encountered — route to human task, never solve') {
    super('CAPTCHA_ENCOUNTERED', message);
  }
}

export class SingleIdentityViolation extends GuardrailError {
  constructor(message: string) {
    super('SINGLE_IDENTITY', message);
  }
}

export class AccountMarketViolation extends GuardrailError {
  constructor(message: string) {
    super('ACCOUNT_MARKET', message);
  }
}

export class LoyaltyGuardViolation extends GuardrailError {
  constructor(message: string) {
    super('LOYALTY_GUARD', message);
  }
}

/** Cost/resource cap breach (Sec. 0.5). Always Tier-B (escalate, do not raise caps). */
export class CostCapExceeded extends GuardrailError {
  constructor(message: string) {
    super('COST_CAP_EXCEEDED', message, { tierB: true });
  }
}
