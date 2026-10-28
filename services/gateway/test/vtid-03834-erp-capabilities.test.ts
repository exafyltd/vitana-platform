/**
 * VTID-03834 — ERP capability catalog + pure access policy (no I/O).
 */
import { ERP_CAPABILITIES, ROLE_DEFAULT_CAPABILITIES, APPROVE_LEVEL_CAPABILITIES, isErpCapability, isExplicitOnly } from '../src/constants/erp-capabilities';
import { VITANA_ROLES } from '../src/constants/vitana-roles';
import { defaultCapabilitiesFor, effectiveCapabilities, canManageErpAccess, validateGrant, hasCapability } from '../src/services/backoffice/erp-access';
import * as fs from 'fs';
import * as path from 'path';

describe('VTID-03834 capability catalog', () => {
  test('is the design-gate catalog (GOLDEN-WORKFLOWS §3.1): 30 capabilities, <domain>.<level>, unique', () => {
    expect(ERP_CAPABILITIES).toHaveLength(30);
    expect(new Set(ERP_CAPABILITIES).size).toBe(30);
    for (const c of ERP_CAPABILITIES) expect(c).toMatch(/^[a-z]+\.[a-z_]+$/);
    // every capability named in the design gate document exists in the catalog
    // The design-gate document lands with VTID-03831 (PR #3282); until that merges this branch does not carry it.
    const docPath = path.join(__dirname, '..', '..', '..', 'docs', 'backoffice', 'GOLDEN-WORKFLOWS.md');
    if (!fs.existsSync(docPath)) return;
    const doc = fs.readFileSync(docPath, 'utf8').split('### 3.2')[0].split('### 3.1')[1] || '';
    const cited = Array.from(doc.matchAll(/`([a-z]+\.[a-z_]+)`/g)).map((m) => m[1]).filter((c) => !c.includes('*'));
    for (const c of new Set(cited)) expect(ERP_CAPABILITIES as readonly string[]).toContain(c);
  });

  test('hr.* and payroll.* are explicit-only and appear in NO role defaults', () => {
    expect(isExplicitOnly('hr.view')).toBe(true);
    expect(isExplicitOnly('payroll.approve')).toBe(true);
    expect(isExplicitOnly('finance.pay')).toBe(false);
    for (const role of VITANA_ROLES) {
      for (const c of ROLE_DEFAULT_CAPABILITIES[role] ?? []) expect(isExplicitOnly(c)).toBe(false);
    }
  });

  test('role defaults match §3.2: admin lacks finance.pay/accounting.close; developer/infra view-only; backoffice/staff none', () => {
    const admin = defaultCapabilitiesFor('admin', false);
    expect(admin).toEqual(expect.arrayContaining(['crm.manage', 'sales.commit', 'finance.approve', 'finance.reconcile', 'accounting.post', 'accounting.configure', 'approvals.policy', 'erp.admin', 'reports.view', 'audit.view']));
    expect(admin).not.toContain('finance.pay');
    expect(admin).not.toContain('accounting.close');
    expect(admin).not.toContain('hr.view');
    expect(admin).not.toContain('payroll.view');
    for (const r of ['developer', 'infra'] as const) {
      const d = defaultCapabilitiesFor(r, false);
      expect(d.length).toBeGreaterThan(0);
      for (const c of d) expect(c.endsWith('.view')).toBe(true);
      expect(d).not.toContain('hr.view');
    }
    expect(defaultCapabilitiesFor('backoffice', false)).toEqual([]);
    expect(defaultCapabilitiesFor('staff', false)).toEqual([]);
    expect(defaultCapabilitiesFor('community', false)).toEqual([]);
    expect(defaultCapabilitiesFor('nonsense', false)).toEqual([]);
    expect(defaultCapabilitiesFor(null, true)).toEqual([...ERP_CAPABILITIES]);
  });

  test('effective = defaults ∪ explicit, unknown explicit strings dropped, catalog order kept', () => {
    const a = effectiveCapabilities('backoffice', false, ['sales.draft', 'crm.view', 'bogus.thing', 'sales.draft']);
    expect(a.capabilities).toEqual(['crm.view', 'sales.draft']);
    expect(a.explicit).toEqual(['sales.draft', 'crm.view']);
    expect(hasCapability(a, 'sales.draft')).toBe(true);
    expect(hasCapability(a, 'sales.commit')).toBe(false);
    const b = effectiveCapabilities('admin', false, ['finance.pay']);
    expect(hasCapability(b, 'finance.pay')).toBe(true);
    expect(hasCapability(b, 'accounting.close')).toBe(false);
  });

  test('who manages access: exafy, tenant admin (erp.admin default), or an explicit erp.admin grant', () => {
    expect(canManageErpAccess(effectiveCapabilities('admin', false, []))).toBe(true);
    expect(canManageErpAccess(effectiveCapabilities('backoffice', false, []))).toBe(false);
    expect(canManageErpAccess(effectiveCapabilities('backoffice', false, ['erp.admin']))).toBe(true);
    expect(canManageErpAccess(effectiveCapabilities('developer', false, []))).toBe(false);
    expect(canManageErpAccess(effectiveCapabilities(null, true, []))).toBe(true);
  });

  test('validateGrant: catalog check, and hr/payroll only by tenant admin or exafy', () => {
    expect(validateGrant('nope', { is_exafy_admin: false, active_role: 'admin' })).toEqual({ ok: false, error: 'INVALID_CAPABILITY' });
    expect(validateGrant('sales.draft', { is_exafy_admin: false, active_role: 'backoffice' })).toEqual({ ok: true, explicit_only: false });
    expect(validateGrant('hr.view', { is_exafy_admin: false, active_role: 'backoffice' })).toMatchObject({ ok: false, error: 'EXPLICIT_ONLY_NEEDS_ADMIN' });
    expect(validateGrant('hr.view', { is_exafy_admin: false, active_role: 'admin' })).toEqual({ ok: true, explicit_only: true });
    expect(validateGrant('payroll.approve', { is_exafy_admin: true, active_role: null })).toEqual({ ok: true, explicit_only: true });
  });

  test('approver-level set is exactly the §3.1 list', () => {
    expect([...APPROVE_LEVEL_CAPABILITIES].sort()).toEqual(['accounting.close', 'finance.approve', 'finance.pay', 'hr.approve', 'payroll.approve']);
    expect(isErpCapability('erp.admin')).toBe(true);
  });

  test('the migration names the same table the route writes and keeps writes to the service role', () => {
    const mig = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'supabase', 'migrations', '20260913010000_vtid_03834_erp_capability_grants.sql'), 'utf8');
    expect(mig).toMatch(/CREATE TABLE IF NOT EXISTS public\.erp_capability_grants/);
    expect(mig).toMatch(/UNIQUE \(user_id, tenant_id, capability\)/);
    expect(mig).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(mig).not.toMatch(/FOR (INSERT|UPDATE|DELETE) TO authenticated/);
    const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'backoffice-access.ts'), 'utf8');
    expect(route).toMatch(/const TABLE = 'erp_capability_grants'/);
  });
});
