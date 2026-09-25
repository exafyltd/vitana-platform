/** VTID-04500 (Community Autopilot CA-2): lineup decision is server-side. */
import { decideLineup, roleScopesVisibleFrom } from '../src/services/community-autopilot/lineup-role';

const base = { requested: null, effectiveRole: null, exafyAdmin: false, systemRolePermitted: null };

describe('decideLineup', () => {
  test('community and patient map to the member\'s own lineup', () => {
    expect(decideLineup({ ...base, requested: 'community' }).lineup).toBe('community');
    expect(decideLineup({ ...base, requested: 'patient' }).lineup).toBe('community');
  });

  test('no hint uses the effective role, default community', () => {
    expect(decideLineup({ ...base }).lineup).toBe('community');
    expect(decideLineup({ ...base, effectiveRole: 'developer', systemRolePermitted: true }).lineup).toBe('developer');
  });

  test('switching role switches the lineup (same user, two roles)', () => {
    const asCommunity = decideLineup({ ...base, effectiveRole: 'community' });
    const asDeveloper = decideLineup({ ...base, effectiveRole: 'developer', systemRolePermitted: true });
    expect(asCommunity.lineup).toBe('community');
    expect(asDeveloper.lineup).toBe('developer');
  });

  test('a system role needs a grant or exafy admin; otherwise it narrows', () => {
    for (const r of ['developer', 'admin', 'infra']) {
      expect(decideLineup({ ...base, requested: r, systemRolePermitted: false })).toMatchObject({ lineup: 'community', narrowed: true });
      expect(decideLineup({ ...base, requested: r, systemRolePermitted: true }).lineup).toBe('developer');
      expect(decideLineup({ ...base, requested: r, exafyAdmin: true }).lineup).toBe('developer');
    }
  });

  test('roles without a lineup get none; unknown values never widen', () => {
    for (const r of ['professional', 'staff', 'backoffice']) {
      expect(decideLineup({ ...base, requested: r }).lineup).toBe('none');
    }
    expect(decideLineup({ ...base, requested: 'root' })).toMatchObject({ lineup: 'community', narrowed: true });
  });

  test('a developer never sees personal health suggestions: system lineup only', () => {
    // The developer lineup filters user_id IS NULL AND source_type <> community
    // (queryRecommendationsByRole); this pins that developer never maps to community.
    expect(decideLineup({ ...base, requested: 'developer', exafyAdmin: true }).lineup).not.toBe('community');
  });
});

describe('roleScopesVisibleFrom', () => {
  test('community and patient read community-scoped rows; system roles read developer rows', () => {
    expect(roleScopesVisibleFrom('community')).toEqual(['any', 'community']);
    expect(roleScopesVisibleFrom('patient')).toEqual(['any', 'community']);
    expect(roleScopesVisibleFrom(null)).toEqual(['any', 'community']);
    expect(roleScopesVisibleFrom('developer')).toEqual(['any', 'developer']);
  });
});
