/**
 * In-process invariant probe (SELF-HEALING / HEALTHCHECK plans).
 *
 * Returns a categorized ProbeResult the orchestrator can act on. Each check is
 * tagged with the failure category that selects its remediation tier. Safety
 * invariants are tagged `guardrail` (never auto-healed). This complements the
 * CI `npm run health` jest run with an in-process probe the orchestrator can call
 * on a schedule.
 */
import { ProbeResult, FailedCheck, FailureCategory } from './orchestrator';
import { assertDevEnvironment } from '../guardrails/env-boundary';
import { PolicyEngine } from '../guardrails/policy-engine';
import { redact, REDACTION } from '../guardrails/no-pii-leak';
import { totp } from '../vault/totp';
import { computeKpis } from '../observability/kpi';
import { Attribution } from '../rewards/attribution';
import { InMemoryRepository } from '../api/repository';
import { InMemoryOasisSink } from '../api/oasis-sink';

interface Check {
  name: string;
  category: FailureCategory;
  run: () => Promise<boolean> | boolean;
}

const CHECKS: Check[] = [
  {
    name: 'guardrail.env_boundary_fail_closed',
    category: 'guardrail',
    run: () => {
      try {
        assertDevEnvironment({}); // unset env must throw (fail-closed)
        return false;
      } catch {
        return true;
      }
    },
  },
  {
    name: 'guardrail.policy_default_deny',
    category: 'guardrail',
    run: () => {
      try {
        new PolicyEngine().assertActionAllowed('unknown', 'operate_api');
        return false;
      } catch {
        return true;
      }
    },
  },
  {
    name: 'guardrail.pii_redaction',
    category: 'guardrail',
    run: () => (redact({ email: 'a@b.com' }) as { email: string }).email === REDACTION,
  },
  {
    name: 'vault.totp_rfc_vector',
    category: 'service',
    run: () => totp(Buffer.from('12345678901234567890', 'ascii'), 59, { digits: 8, algorithm: 'sha1' }) === '94287082',
  },
  {
    name: 'money.attribution_confirm_reverse',
    category: 'service',
    run: async () => {
      const repo = new InMemoryRepository();
      const attr = new Attribution(repo, new InMemoryOasisSink());
      const { commissionId } = await attr.ingestPending({ subId: 's', userId: 'u', affiliateProgramId: 'p', merchant: 'm', orderRef: 'o', grossCommission: 10, userShare: 0.5 });
      await attr.confirm(commissionId, 'pb');
      if ((await attr.walletBalance('u')) !== 5) return false;
      await attr.reverse(commissionId);
      return (await attr.walletBalance('u')) === 0;
    },
  },
  {
    name: 'kpi.compute',
    category: 'config',
    run: () => computeKpis({ events: [] }).totalEvents === 0,
  },
];

/** Run all invariant checks; healthy when none fail. */
export async function invariantProbe(): Promise<ProbeResult> {
  const failed: FailedCheck[] = [];
  for (const c of CHECKS) {
    let ok = false;
    try {
      ok = await c.run();
    } catch (e) {
      ok = false;
    }
    if (!ok) failed.push({ name: c.name, category: c.category, detail: 'invariant failed' });
  }
  return { ok: failed.length === 0, failed };
}

export const HEALTH_CHECK_NAMES = CHECKS.map((c) => c.name);
