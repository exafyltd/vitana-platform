/**
 * VCAOP guardrails (runbook Sec. 3) — the control layer every feature must route
 * through. Build FIRST; CI fails (`test:guardrails`) if any guardrail test fails.
 * A guardrail is never weakened to make a feature pass (Sec. 0.3, Sec. 11.3).
 */
export * from './errors';
export * from './policy-engine';
export * from './env-boundary';
export * from './no-credential-store';
export * from './no-pii-leak';
export * from './human-gate';
export * from './no-captcha-solve';
export * from './single-identity';
export * from './no-account-market';
export * from './loyalty-guard';
export * from './cost-guard';
