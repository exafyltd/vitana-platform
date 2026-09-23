// VTID-04337 (SEC-2) — the partner_organization_members SELECT policy must
// not query partner_organization_members from inside its own USING clause.
// The VTID-03932 version did, and every browser read failed live with
// 42P17 "infinite recursion detected in policy". This pins the replacement
// migration's shape: membership goes through a SECURITY DEFINER helper that
// only answers for the calling user.

import * as fs from 'fs';
import * as path from 'path';

const MIGRATION = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260923120000_vtid_04337_partner_org_members_rls_no_recursion.sql'
);

function policyBody(sql: string, policy: string): string {
  const start = sql.indexOf(`CREATE POLICY ${policy}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf(';', start);
  return sql.slice(start, end);
}

describe('VTID-04337 partner org RLS without recursion', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');

  it('defines is_partner_org_member as SECURITY DEFINER with a pinned search_path', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.is_partner_org_member\(p_org_id uuid\)/);
    expect(sql).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/SET search_path = public/);
  });

  it('the helper only answers for the calling user (no user id parameter)', () => {
    expect(sql).toMatch(/pom\.user_id = public\.current_user_id\(\)/);
    expect(sql).not.toMatch(/is_partner_org_member\(p_org_id uuid,/);
  });

  it('is not executable by PUBLIC/anon, only authenticated and service_role', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.is_partner_org_member\(uuid\) FROM PUBLIC;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.is_partner_org_member\(uuid\) TO authenticated, service_role;/);
  });

  it('the members SELECT policy no longer selects from its own table', () => {
    const body = policyBody(sql, 'partner_organization_members_select');
    expect(body).toMatch(/public\.is_partner_org_member\(partner_organization_id\)/);
    expect(body).not.toMatch(/FROM\s+public\.partner_organization_members/i);
  });

  it('the organizations SELECT policy uses the helper instead of an EXISTS on members', () => {
    const body = policyBody(sql, 'partner_organizations_select');
    expect(body).toMatch(/public\.is_partner_org_member\(id\)/);
    expect(body).not.toMatch(/partner_organization_members/);
    expect(body).toMatch(/status = 'active'/);
    expect(body).toMatch(/owner_user_id = public\.current_user_id\(\)/);
  });
});
