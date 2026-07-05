/**
 * BOOTSTRAP-NAV-ROLE — role is a first-class catalog scope (parallel to platform).
 * The list filter + create both run the user-supplied role through normalizeRole,
 * which must default unknown/missing input to 'community' (today's only catalog)
 * and accept exactly the app's role-surfaces.
 */
import { normalizeRole, VALID_ROLES } from '../src/routes/admin-navigator';

describe('nav_catalog role scoping', () => {
  test('every known role normalizes to itself', () => {
    for (const r of VALID_ROLES) expect(normalizeRole(r)).toBe(r);
  });

  test('the role set matches getRoleNavigation cases (+ developer/infra)', () => {
    expect([...VALID_ROLES].sort()).toEqual(
      ['admin', 'community', 'developer', 'infra', 'patient', 'professional', 'staff'],
    );
  });

  test('missing / unknown / wrong-type input falls back to community', () => {
    expect(normalizeRole(undefined)).toBe('community');
    expect(normalizeRole(null)).toBe('community');
    expect(normalizeRole('')).toBe('community');
    expect(normalizeRole('superuser')).toBe('community'); // not a real role
    expect(normalizeRole('Community')).toBe('community');  // case-sensitive → fallback
    expect(normalizeRole(42)).toBe('community');
    expect(normalizeRole(['patient'])).toBe('community');  // array (req.query edge) → fallback
  });
});
