/**
 * VTID-04473: who may use Jev (internal roles only, community off) and PII policy.
 */
import { resolveJevAccess, roleMayUseDecision, JEV_INTERNAL_ROLES } from '../src/services/jev/jev-access';
import { applyPiiPolicy, redactText, scanPii } from '../src/services/jev/jev-pii';
import { listJevDecisions } from '../src/services/jev/jev-decisions';
import { assertValidQuestions } from '../src/services/jev/jev-types';

describe('VTID-04473 jev access gate', () => {
  test.each(['professional', 'staff', 'backoffice', 'admin', 'developer', 'infra'])('%s is allowed on the internal plane', (role) => {
    expect(resolveJevAccess({ actor_id: 'u', active_role: role }, {})).toEqual({ allowed: true, plane: 'internal', role });
  });

  test.each(['community', 'patient'])('%s is refused while community is off (owner decision)', (role) => {
    expect(resolveJevAccess({ actor_id: 'u', active_role: role }, {})).toMatchObject({ allowed: false, plane: 'community', reason: 'community_not_enabled' });
  });

  test('community opens only on the exact flag value', () => {
    expect(resolveJevAccess({ actor_id: 'u', active_role: 'community' }, { JEV_COMMUNITY_ENABLED: 'TRUE' }).allowed).toBe(false);
    expect(resolveJevAccess({ actor_id: 'u', active_role: 'community' }, { JEV_COMMUNITY_ENABLED: 'true' })).toMatchObject({ allowed: true, plane: 'community' });
  });

  test('exafy_admin and system are internal; no role and unknown roles are refused', () => {
    expect(resolveJevAccess({ actor_id: 'u', exafy_admin: true, active_role: 'community' }, {})).toMatchObject({ allowed: true, role: 'exafy_admin' });
    expect(resolveJevAccess({ actor_id: 'svc', system: true }, {})).toMatchObject({ allowed: true, role: 'system' });
    expect(resolveJevAccess({ actor_id: 'u' }, {})).toMatchObject({ allowed: false, reason: 'no_role' });
    expect(resolveJevAccess({ actor_id: 'u', active_role: 'guest' }, {})).toMatchObject({ allowed: false, reason: 'role_not_permitted' });
  });

  test('per-decision roles; exafy_admin may use all', () => {
    expect(roleMayUseDecision('developer', ['backoffice'])).toBe(false);
    expect(roleMayUseDecision('backoffice', ['backoffice'])).toBe(true);
    expect(roleMayUseDecision('exafy_admin', [])).toBe(true);
  });

  test('registry: every decision is valid, internal-only, and its primary question exists', () => {
    const decisions = listJevDecisions();
    expect(decisions.length).toBeGreaterThanOrEqual(10);
    for (const d of decisions) {
      expect(() => assertValidQuestions(d.questions)).not.toThrow();
      expect(d.questions[d.primary]).toBeDefined();
      expect(d.threshold).toBeGreaterThan(0);
      expect(d.threshold).toBeLessThanOrEqual(1);
      for (const r of d.roles) expect(JEV_INTERNAL_ROLES as readonly string[]).toContain(r);
    }
  });
});

describe('VTID-04473 jev PII policy', () => {
  test('redacts emails, phones and IBANs', () => {
    const r = redactText('Mail anna@example.com, call +49 170 1234567, IBAN DE89 3704 0044 0532 0130 00.');
    expect(r.text).toBe('Mail [email], call [phone], IBAN [iban].');
    expect(r.redactions).toBe(3);
  });

  test('leaves dates, versions and ids alone', () => {
    const t = 'Released 2026-09-25, version 1.13.0, VTID-04473, order 12345.';
    expect(scanPii(t)).toEqual([]);
    expect(redactText(t).text).toBe(t);
  });

  test('walks nested state; forbid refuses instead of sending', () => {
    const state = { a: { b: ['x@y.io', 'fine'] } };
    expect(applyPiiPolicy(state, 'redact')).toEqual({ ok: true, value: { a: { b: ['[email]', 'fine'] } }, redactions: 1 });
    expect(applyPiiPolicy(state, 'forbid')).toEqual({ ok: false, kinds: ['email'] });
    expect(applyPiiPolicy({ a: 'clean' }, 'forbid')).toMatchObject({ ok: true });
  });
});

describe('VTID-04473 jev PII edge cases', () => {
  test('ISO timestamps are not phones; short digit runs are not phones', () => {
    expect(scanPii('At 2026-09-25 10:15 the job ran; ticket 1234-567.')).toEqual([]);
    expect(scanPii('Tel: (030) 1234 5678')).toEqual(['phone']);
  });
});
