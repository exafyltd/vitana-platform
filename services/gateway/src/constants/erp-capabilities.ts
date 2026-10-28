/**
 * VTID-03834 — ERP capability catalog and per-role defaults for the Vitanaland
 * BackOffice. Source of truth: docs/backoffice/GOLDEN-WORKFLOWS.md §3
 * (design gate, VTID-03831). The Vitana ROLE opens the /backoffice door
 * (VTID-03832); a CAPABILITY gates what a person may do inside. Explicit
 * grants live in `erp_capability_grants` (one row per user × tenant ×
 * capability, written only through /api/v1/backoffice/access/*).
 */
import type { VitanaRole } from './vitana-roles';

export const ERP_CAPABILITIES = [
  'crm.view', 'crm.manage',
  'sales.view', 'sales.draft', 'sales.commit',
  'finance.view', 'finance.approve', 'finance.pay', 'finance.reconcile',
  'accounting.view', 'accounting.post', 'accounting.configure', 'accounting.close',
  'reports.view',
  'audit.view',
  'approvals.policy',
  'ops.view', 'ops.manage', 'ops.commit',
  'hr.view', 'hr.manage', 'hr.approve',
  'payroll.view', 'payroll.approve',
  'marketing.view', 'marketing.manage',
  'legal.view', 'legal.manage', 'legal.sign',
  'erp.admin',
] as const;

export type ErpCapability = (typeof ERP_CAPABILITIES)[number];

export function isErpCapability(value: unknown): value is ErpCapability {
  return typeof value === 'string' && (ERP_CAPABILITIES as readonly string[]).includes(value);
}

/** Capabilities that make someone an APPROVER of a High-risk command (§3.1). */
export const APPROVE_LEVEL_CAPABILITIES: readonly ErpCapability[] = [
  'finance.pay', 'finance.approve', 'accounting.close', 'payroll.approve', 'hr.approve',
];

/**
 * Personal-data domains: NEVER part of any role's defaults (§3.3 rule 3, UAE PDPL).
 * They can only ever be explicit grants.
 */
export const EXPLICIT_ONLY_DOMAINS = ['hr', 'payroll'] as const;

export function isExplicitOnly(capability: ErpCapability): boolean {
  return (EXPLICIT_ONLY_DOMAINS as readonly string[]).includes(capability.split('.')[0]);
}

const ALL_VIEW = ERP_CAPABILITIES.filter((c) => c.endsWith('.view') && !isExplicitOnly(c));

/**
 * Default grants per Vitana role (§3.2). The table is deliberately closed:
 * a role not listed here has no defaults, and `hr.*` / `payroll.*` are never
 * defaults for anyone. Exafy super-admins are handled by the caller
 * (everything), not here.
 */
export const ROLE_DEFAULT_CAPABILITIES: Readonly<Partial<Record<VitanaRole, readonly ErpCapability[]>>> = {
  // opens the door; the tenant admin grants the person's actual function
  backoffice: [],
  admin: [
    ...ALL_VIEW,
    'crm.manage',
    'sales.draft', 'sales.commit',
    'finance.approve', 'finance.reconcile',
    'accounting.post', 'accounting.configure',
    'approvals.policy',
    'erp.admin',
    // NOT finance.pay / accounting.close / hr.* / payroll.* — explicit grants only
  ],
  // platform roles: troubleshooting reads only, never post a tenant's books
  developer: [...ALL_VIEW],
  infra: [...ALL_VIEW],
};
