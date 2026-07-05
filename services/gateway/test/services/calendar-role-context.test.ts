/**
 * Regression: role_context written to calendar_events MUST satisfy the DB
 * `valid_role_context` CHECK ({community, admin, developer, personal}).
 *
 * The ORB index-improvement-plan tool previously wrote the raw SESSION role
 * (id.role) as role_context. Session roles include super_admin / staff / dev /
 * patient / professional — none of which are valid role_context values — so the
 * calendar INSERT failed with a 400 for those users and the plan silently
 * produced zero events ("I cannot execute"). `toWritableRoleContext` coerces any
 * session role into a constraint-valid context. This test pins that contract.
 */

import { toWritableRoleContext, CalendarRoleContext } from '../../src/types/calendar';

// Mirror of the DB CHECK constraint `valid_role_context`.
const VALID: ReadonlySet<string> = new Set(['community', 'admin', 'developer', 'personal']);

describe('toWritableRoleContext — calendar role_context coercion', () => {
  // Every role the gateway may carry on a session, plus edge cases.
  const SESSION_ROLES = [
    'community', 'admin', 'developer', 'personal',
    'super_admin', 'staff', 'dev', 'DEV', 'infra', 'patient', 'professional',
    'totally_unknown_role', '', null, undefined,
  ];

  it('always returns a value that satisfies the valid_role_context CHECK', () => {
    for (const role of SESSION_ROLES) {
      const ctx = toWritableRoleContext(role as string | null | undefined);
      expect(VALID.has(ctx)).toBe(true);
    }
  });

  it('maps the roles that previously broke the calendar INSERT to a valid context', () => {
    // These are exactly the session roles NOT present in valid_role_context —
    // the ones that used to 400 the insert.
    expect(toWritableRoleContext('super_admin')).toBe('admin');
    expect(toWritableRoleContext('staff')).toBe('admin');
    expect(toWritableRoleContext('dev')).toBe('developer');
    expect(toWritableRoleContext('DEV')).toBe('developer');
    expect(toWritableRoleContext('infra')).toBe('developer');
    expect(toWritableRoleContext('patient')).toBe('community');
    expect(toWritableRoleContext('professional')).toBe('community');
  });

  it('passes through already-valid contexts unchanged', () => {
    expect(toWritableRoleContext('admin')).toBe('admin');
    expect(toWritableRoleContext('developer')).toBe('developer');
    expect(toWritableRoleContext('community')).toBe('community');
  });

  it('defaults unknown / empty / nullish roles to community', () => {
    const fallbacks: Array<string | null | undefined> = ['', 'mystery', null, undefined];
    for (const r of fallbacks) {
      const ctx: CalendarRoleContext = toWritableRoleContext(r);
      expect(ctx).toBe('community');
    }
  });
});
