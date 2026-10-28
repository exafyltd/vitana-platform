// VTID-03932 — unit tests for services/partner-health/org-access.ts, the
// re-keyed (tenant_id -> partner_organization_id) access-resolution layer
// that lets admin-partner-health.ts's routes serve a partner org's own
// staff/professional members, not just a Vitana tenant admin.

import {
  resolveOrgHealthAccess,
  hasFullPartnerAccess,
  canActOnOrder,
  allVisiblePartnerIds,
  type PartnerHealthAccess,
} from '../../src/services/partner-health/org-access';

const CALLER = 'user-1';
const ORG_A = 'org-a';
const ORG_B = 'org-b';
const PARTNER_A = 'partner-a';
const PARTNER_B = 'partner-b';

let tableHandlers: Record<string, (ctx: { op: string; args: any[] }) => any>;

function makeFakeSupabase() {
  return {
    from(table: string) {
      const handler = tableHandlers[table];
      if (!handler) throw new Error(`Unexpected table in test: ${table}`);
      let op = 'select';
      const chain: any = {};
      for (const m of ['eq', 'in', 'order', 'limit']) {
        chain[m] = (...args: any[]) => chain;
      }
      chain.select = (...args: any[]) => chain;
      chain.then = (resolve: any, reject: any) => Promise.resolve(handler({ op, args: [] })).then(resolve, reject);
      return chain;
    },
  } as any;
}

beforeEach(() => {
  tableHandlers = {};
});

describe('resolveOrgHealthAccess', () => {
  it('returns null when the caller has no partner org membership', async () => {
    tableHandlers.partner_organization_members = () => ({ data: [], error: null });
    const access = await resolveOrgHealthAccess(makeFakeSupabase(), CALLER);
    expect(access).toBeNull();
  });

  it('grants full access for org_admin/staff membership', async () => {
    tableHandlers.partner_organization_members = () => ({
      data: [{ partner_organization_id: ORG_A, role: 'staff' }],
      error: null,
    });
    tableHandlers.partner_registry = () => ({
      data: [{ id: PARTNER_A, partner_organization_id: ORG_A }],
      error: null,
    });
    const access = await resolveOrgHealthAccess(makeFakeSupabase(), CALLER);
    expect(access).toEqual({
      scope: 'org',
      callerId: CALLER,
      fullAccessPartnerIds: [PARTNER_A],
      assignedOnlyPartnerIds: [],
    });
  });

  it('grants assigned-only access for professional membership', async () => {
    tableHandlers.partner_organization_members = () => ({
      data: [{ partner_organization_id: ORG_A, role: 'professional' }],
      error: null,
    });
    tableHandlers.partner_registry = () => ({
      data: [{ id: PARTNER_A, partner_organization_id: ORG_A }],
      error: null,
    });
    const access = await resolveOrgHealthAccess(makeFakeSupabase(), CALLER);
    expect(access).toEqual({
      scope: 'org',
      callerId: CALLER,
      fullAccessPartnerIds: [],
      assignedOnlyPartnerIds: [PARTNER_A],
    });
  });

  it('a full-access org membership takes priority over a professional membership on the same partner', async () => {
    // A user cannot hold two roles for the same org (unique constraint), but
    // could be org_admin for org A and professional for org B where both
    // resolve to the same partner_registry row in a pathological setup —
    // fullAccessPartnerIds must win, never double-list a partner as both.
    tableHandlers.partner_organization_members = () => ({
      data: [
        { partner_organization_id: ORG_A, role: 'staff' },
        { partner_organization_id: ORG_B, role: 'professional' },
      ],
      error: null,
    });
    tableHandlers.partner_registry = () => ({
      data: [
        { id: PARTNER_A, partner_organization_id: ORG_A },
        { id: PARTNER_A, partner_organization_id: ORG_B },
      ],
      error: null,
    });
    const access = await resolveOrgHealthAccess(makeFakeSupabase(), CALLER);
    expect(access).toEqual({
      scope: 'org',
      callerId: CALLER,
      fullAccessPartnerIds: [PARTNER_A],
      assignedOnlyPartnerIds: [],
    });
  });
});

describe('hasFullPartnerAccess / canActOnOrder / allVisiblePartnerIds', () => {
  const admin: PartnerHealthAccess = { scope: 'admin' };
  const orgAccess: PartnerHealthAccess = {
    scope: 'org',
    callerId: CALLER,
    fullAccessPartnerIds: [PARTNER_A],
    assignedOnlyPartnerIds: [PARTNER_B],
  };

  it('admin scope has full access to everything and no partner_id filter', () => {
    expect(hasFullPartnerAccess(admin, PARTNER_A)).toBe(true);
    expect(hasFullPartnerAccess(admin, 'anything')).toBe(true);
    expect(canActOnOrder(admin, { partner_id: 'anything', assigned_professional_user_id: null })).toBe(true);
    expect(allVisiblePartnerIds(admin)).toBeNull();
  });

  it('full-access org partner: any order for that partner is actionable, assignment irrelevant', () => {
    expect(hasFullPartnerAccess(orgAccess, PARTNER_A)).toBe(true);
    expect(canActOnOrder(orgAccess, { partner_id: PARTNER_A, assigned_professional_user_id: null })).toBe(true);
    expect(canActOnOrder(orgAccess, { partner_id: PARTNER_A, assigned_professional_user_id: 'someone-else' })).toBe(true);
  });

  it('assigned-only org partner: only the order assigned to this caller is actionable', () => {
    expect(hasFullPartnerAccess(orgAccess, PARTNER_B)).toBe(false);
    expect(canActOnOrder(orgAccess, { partner_id: PARTNER_B, assigned_professional_user_id: CALLER })).toBe(true);
    expect(canActOnOrder(orgAccess, { partner_id: PARTNER_B, assigned_professional_user_id: 'someone-else' })).toBe(false);
    expect(canActOnOrder(orgAccess, { partner_id: PARTNER_B, assigned_professional_user_id: null })).toBe(false);
  });

  it('a partner outside both lists is never actionable', () => {
    expect(hasFullPartnerAccess(orgAccess, 'unrelated-partner')).toBe(false);
    expect(canActOnOrder(orgAccess, { partner_id: 'unrelated-partner', assigned_professional_user_id: CALLER })).toBe(false);
  });

  it('allVisiblePartnerIds unions both lists for org scope', () => {
    expect(allVisiblePartnerIds(orgAccess)).toEqual([PARTNER_A, PARTNER_B]);
  });
});
