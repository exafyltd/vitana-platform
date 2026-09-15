/**
 * VTID-03832 — the shared role constant that replaced five hand-copied lists.
 */
import { VITANA_ROLES, VALID_ROLES, SUPER_ADMIN_ONLY_ROLES, ROLE_RANK, isVitanaRole } from '../src/constants/vitana-roles';
import { VALID_ROLES as NAVIGATOR_ROLES } from '../src/routes/admin-navigator';
import * as fs from 'fs';
import * as path from 'path';

describe('VTID-03832 vitana-roles constant', () => {
  test('carries all eight roles in ladder order (backoffice between staff and admin)', () => {
    expect([...VITANA_ROLES]).toEqual([
      'community', 'patient', 'professional', 'staff', 'backoffice', 'admin', 'developer', 'infra',
    ]);
    expect(ROLE_RANK.staff).toBe(4);
    expect(ROLE_RANK.backoffice).toBe(5);
    expect(ROLE_RANK.admin).toBe(6);
    expect(ROLE_RANK.developer).toBe(7);
    expect(ROLE_RANK.infra).toBe(8);
  });

  test('backoffice is tenant-admin-grantable: NOT in the super-admin-only list', () => {
    expect(SUPER_ADMIN_ONLY_ROLES).toEqual(['developer', 'infra']);
    expect(SUPER_ADMIN_ONLY_ROLES).not.toContain('backoffice');
  });

  test('VALID_ROLES is a mutable mirror and admin-navigator re-exports the same set', () => {
    expect(VALID_ROLES).toEqual([...VITANA_ROLES]);
    expect([...NAVIGATOR_ROLES]).toEqual([...VITANA_ROLES]);
  });

  test('isVitanaRole guards', () => {
    expect(isVitanaRole('backoffice')).toBe(true);
    expect(isVitanaRole('reseller')).toBe(false);
    expect(isVitanaRole(null)).toBe(false);
  });

  test('no route file still carries its own hard-coded 7-role list', () => {
    const routes = path.join(__dirname, '..', 'src', 'routes');
    const offenders: string[] = [];
    for (const f of fs.readdirSync(routes)) {
      if (!f.endsWith('.ts')) continue;
      const src = fs.readFileSync(path.join(routes, f), 'utf8');
      if (/\[\s*'(community|patient)',\s*'(community|patient)',\s*'professional',\s*'staff',\s*'admin',\s*'developer',\s*'infra'\s*\]/.test(src)) {
        offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the DB migrations name the same eight roles as the constant', () => {
    const mig = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'supabase', 'migrations', '20260913000002_vtid_03832_role_functions.sql'),
      'utf8',
    );
    const arrays = mig.match(/ARRAY\[([^\]]+)\]/g) || [];
    const eightRoleArrays = arrays.filter((a) => a.includes("'backoffice'"));
    expect(eightRoleArrays.length).toBeGreaterThanOrEqual(2); // get_my_permitted_roles + me_set_active_role
    for (const a of eightRoleArrays) {
      const names = Array.from(a.matchAll(/'([a-z]+)'/g)).map((m) => m[1]);
      expect(names).toEqual([...VITANA_ROLES]);
    }
    expect(mig).toMatch(/WHEN 'backoffice' THEN 5/);
    expect(mig).toMatch(/WHEN 'admin' THEN 6/);
  });
});
