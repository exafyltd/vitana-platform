/**
 * VTID-04325 — default capability grants per role (Orchestrator plan §3.2, §8.2).
 *
 * AC-1 role ceilings: each role's domains match the recorded defaults; an
 *      unknown or missing role has no authority anywhere.
 * AC-2 channel ceilings: voice never commits (escalates to chat/web when the
 *      role could); chat and web can commit.
 * AC-3 high-risk is never allowed directly: maker-checker escalation when the
 *      role reaches commit, deny otherwise; exafy_admin does not bypass.
 * AC-4 commerce authority comes only from org membership; backoffice from the
 *      ERP grant tier when supplied.
 */

import {
  ROLE_DEFAULTS,
  POLICY_DOMAINS,
  ceilingsFor,
  evaluatePolicy,
  effectiveCeiling,
  policyDefaults,
} from '../../../src/services/orchestrator/policy';

const ctx = (platform_role: string | null, channel: any = 'web', orgs: any[] = []) =>
  ({ platform_role, channel, orgs });

describe('AC-1 role ceilings', () => {
  test('community and patient commit their own community and health actions only', () => {
    for (const r of ['community', 'patient']) {
      const c = ceilingsFor(ctx(r));
      expect(c.community).toBe('commit');
      expect(c.health).toBe('commit');
      for (const d of ['professional', 'staff', 'admin', 'backoffice', 'dev', 'ops', 'commerce'] as const) {
        expect(c[d]).toBe('none');
      }
    }
  });

  test('professional and staff draft in their own domain', () => {
    expect(ceilingsFor(ctx('professional')).professional).toBe('draft');
    expect(ceilingsFor(ctx('professional')).health).toBe('read');
    expect(ceilingsFor(ctx('staff')).staff).toBe('draft');
    expect(ceilingsFor(ctx('staff')).health).toBe('none');
  });

  test('admin commits admin, developer commits dev, infra commits ops', () => {
    expect(ceilingsFor(ctx('admin')).admin).toBe('commit');
    expect(ceilingsFor(ctx('admin')).dev).toBe('none');
    expect(ceilingsFor(ctx('developer')).dev).toBe('commit');
    expect(ceilingsFor(ctx('developer')).ops).toBe('read');
    expect(ceilingsFor(ctx('infra')).ops).toBe('commit');
  });

  test('unknown or missing role has no authority', () => {
    for (const r of [null, '', 'superuser']) {
      expect(Object.values(ceilingsFor(ctx(r))).every((t) => t === 'none')).toBe(true);
    }
  });

  test('every role in the table only names known domains', () => {
    for (const map of Object.values(ROLE_DEFAULTS)) {
      for (const d of Object.keys(map)) expect(POLICY_DOMAINS).toContain(d);
    }
  });
});

describe('AC-2 channel ceilings', () => {
  test('voice caps at draft: a commit the role allows escalates to chat/web', () => {
    const d = evaluatePolicy(ctx('community', 'voice'), 'community', 'commit');
    expect(d.decision).toBe('escalate');
    expect(d.effective_ceiling).toBe('draft');
    expect(evaluatePolicy(ctx('community', 'voice'), 'community', 'draft').decision).toBe('allow');
  });

  test('chat and web commit', () => {
    for (const ch of ['chat', 'web']) {
      expect(evaluatePolicy(ctx('community', ch), 'community', 'commit').decision).toBe('allow');
    }
  });

  test('above the role ceiling is a deny on every channel', () => {
    for (const ch of ['voice', 'chat', 'web']) {
      expect(evaluatePolicy(ctx('community', ch), 'admin', 'read').decision).toBe('deny');
    }
  });

  test('an unknown channel is treated as web by the context resolver, read here', () => {
    expect(effectiveCeiling(ctx('community', 'fax' as any), 'community')).toBe('read');
  });
});

describe('AC-3 high-risk', () => {
  test('commit-level role escalates to maker-checker, never allow', () => {
    for (const ch of ['voice', 'chat', 'web']) {
      const d = evaluatePolicy(ctx('admin', ch), 'admin', 'high');
      expect(d.decision).toBe('escalate');
      expect(d.reason).toMatch(/maker-checker/);
    }
  });

  test('below commit, high is denied', () => {
    expect(evaluatePolicy(ctx('staff'), 'staff', 'high').decision).toBe('deny');
  });

  test('exafy_admin is not an input and cannot bypass', () => {
    const d = evaluatePolicy({ ...ctx('community'), exafy_admin: true } as any, 'dev', 'commit');
    expect(d.decision).toBe('deny');
  });
});

describe('AC-4 commerce and backoffice', () => {
  test('commerce comes from org role, not platform role', () => {
    expect(effectiveCeiling(ctx('admin'), 'commerce')).toBe('none');
    expect(effectiveCeiling(ctx('community', 'web', [{ org_role: 'owner' }]), 'commerce')).toBe('commit');
    expect(effectiveCeiling(ctx('community', 'web', [{ org_role: 'member' }]), 'commerce')).toBe('draft');
    expect(effectiveCeiling(ctx('community', 'web', [{ org_role: 'member' }, { org_role: 'admin' }]), 'commerce')).toBe('commit');
    expect(effectiveCeiling(ctx('community', 'voice', [{ org_role: 'owner' }]), 'commerce')).toBe('draft');
  });

  test('backoffice defaults to read and follows the ERP grant tier when given', () => {
    expect(effectiveCeiling(ctx('backoffice'), 'backoffice')).toBe('read');
    expect(effectiveCeiling(ctx('backoffice'), 'backoffice', { backoffice_grant_tier: 'commit' })).toBe('commit');
    expect(effectiveCeiling(ctx('community'), 'backoffice', { backoffice_grant_tier: 'commit' })).toBe('none');
  });

  test('defaults are marked not enforced (shadow)', () => {
    expect(policyDefaults().enforced).toBe(false);
  });
});
