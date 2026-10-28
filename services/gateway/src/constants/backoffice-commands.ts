/**
 * VTID-03842 — BackOffice typed command registry (gateway side).
 *
 * GENERATED from services/erp-bridge/app/catalog.py (VTID-03840, the bridge's
 * allowlist, itself transcribed from docs/backoffice/GOLDEN-WORKFLOWS.md §4).
 * One row per ERPClaw action; `type` is the typed command a client sends to
 * POST /api/v1/backoffice/commands. Where the design gate gave two actions the
 * same command name, the later one carries the action as a suffix so every
 * type is unique (e.g. `finance.fx.list` / `finance.fx.list.list_exchange_rates`).
 *
 * `test/vtid-03842-commands-vs-bridge-catalog.test.ts` fails if this file and
 * the bridge catalog disagree on action, tier, capabilities or company scope
 * (it skips when the bridge tree is not checked out alongside).
 *
 * Tier semantics (GOLDEN-WORKFLOWS §1.3): read | draft | commit | high.
 * `capabilities` is any-of for the REQUESTER. `approveCapability` is what a
 * High-risk APPROVER must hold — the last capability of the design-gate row,
 * which names the approver.
 */
export type CommandTier = 'read' | 'draft' | 'commit' | 'high';

export interface BackOfficeCommandSpec {
  readonly type: string;
  readonly action: string;
  readonly tier: CommandTier;
  readonly capabilities: readonly string[];
  readonly approveCapability: string | null;
  readonly module: 'foundation' | 'erpclaw-growth';
  readonly domain: string;
  readonly companyScoped: boolean;
  readonly wave: string;
  readonly note?: string;
}

export const BACKOFFICE_COMMANDS: readonly BackOfficeCommandSpec[] = [
  { type: 'erp.health.read', action: 'status', tier: 'read', capabilities: ['erp.admin', 'audit.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-setup', companyScoped: false, wave: '1' },
  { type: 'erp.health.read.check_installation', action: 'check-installation', tier: 'read', capabilities: ['erp.admin', 'audit.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-meta', companyScoped: false, wave: '1' },
  { type: 'erp.health.read.get_schema_version', action: 'get-schema-version', tier: 'read', capabilities: ['erp.admin', 'audit.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-setup', companyScoped: false, wave: '1' },
  { type: 'erp.health.read.list_modules', action: 'list-modules', tier: 'read', capabilities: ['erp.admin', 'audit.view'], approveCapability: null, module: 'foundation', domain: 'module-manager', companyScoped: false, wave: '1' },
  { type: 'erp.health.read.module_status', action: 'module-status', tier: 'read', capabilities: ['erp.admin', 'audit.view'], approveCapability: null, module: 'foundation', domain: 'module-manager', companyScoped: false, wave: '1' },
  { type: 'audit.erp_log.read', action: 'get-audit-log', tier: 'read', capabilities: ['audit.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-setup', companyScoped: false, wave: '1' },
  { type: 'accounting.gl.integrity_check', action: 'check-gl-integrity', tier: 'read', capabilities: ['accounting.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-gl', companyScoped: true, wave: '1' },
  { type: 'crm.lead.list', action: 'list-leads', tier: 'read', capabilities: ['crm.view'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.lead.get', action: 'get-lead', tier: 'read', capabilities: ['crm.view'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.lead_source.list', action: 'list-lead-sources', tier: 'read', capabilities: ['crm.view'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.lead.create', action: 'add-lead', tier: 'draft', capabilities: ['crm.manage'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.lead.update', action: 'update-lead', tier: 'draft', capabilities: ['crm.manage'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.lead_source.create', action: 'add-lead-source', tier: 'draft', capabilities: ['crm.manage'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.lead.convert', action: 'convert-lead-to-opportunity', tier: 'commit', capabilities: ['crm.manage'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.contact.list', action: 'list-crm-contacts', tier: 'read', capabilities: ['crm.view'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.contact.get', action: 'get-crm-contact', tier: 'read', capabilities: ['crm.view'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.company.list', action: 'list-crm-companies', tier: 'read', capabilities: ['crm.view'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.company.get', action: 'get-crm-company', tier: 'read', capabilities: ['crm.view'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.contact.create', action: 'add-crm-contact', tier: 'draft', capabilities: ['crm.manage'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.contact.update', action: 'update-crm-contact', tier: 'draft', capabilities: ['crm.manage'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.company.create', action: 'add-crm-company', tier: 'draft', capabilities: ['crm.manage'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.company.update', action: 'update-crm-company', tier: 'draft', capabilities: ['crm.manage'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.contact.link_company', action: 'link-contact-to-company', tier: 'draft', capabilities: ['crm.manage'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.contact.merge', action: 'merge-crm-contacts', tier: 'commit', capabilities: ['crm.manage'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.contact.remove', action: 'remove-crm-contact', tier: 'commit', capabilities: ['crm.manage'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.contact.promote_to_customer', action: 'promote-contact-to-customer', tier: 'commit', capabilities: ['crm.manage', 'sales.draft'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.opportunity.list', action: 'list-opportunities', tier: 'read', capabilities: ['crm.view'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.opportunity.get', action: 'get-opportunity', tier: 'read', capabilities: ['crm.view'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.pipeline.report', action: 'pipeline-report', tier: 'read', capabilities: ['crm.view'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.opportunity.create', action: 'add-opportunity', tier: 'draft', capabilities: ['crm.manage'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.opportunity.update', action: 'update-opportunity', tier: 'draft', capabilities: ['crm.manage'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.opportunity.set_stage', action: 'set-opportunity-pipeline-stage', tier: 'draft', capabilities: ['crm.manage'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.opportunity.mark_won', action: 'mark-opportunity-won', tier: 'commit', capabilities: ['crm.manage'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.opportunity.mark_lost', action: 'mark-opportunity-lost', tier: 'commit', capabilities: ['crm.manage'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.opportunity.convert_to_quotation', action: 'convert-opportunity-to-quotation', tier: 'draft', capabilities: ['crm.manage', 'sales.draft'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.pipeline.list', action: 'list-crm-pipelines', tier: 'read', capabilities: ['crm.view'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.pipeline_stage.list', action: 'list-crm-pipeline-stages', tier: 'read', capabilities: ['crm.view'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.pipeline.create', action: 'add-crm-pipeline', tier: 'commit', capabilities: ['crm.manage'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1-api' },
  { type: 'crm.pipeline_stage.create', action: 'add-crm-pipeline-stage', tier: 'commit', capabilities: ['crm.manage'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1-api' },
  { type: 'crm.pipeline_stage.update', action: 'update-crm-pipeline-stage', tier: 'commit', capabilities: ['crm.manage'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1-api' },
  { type: 'crm.task.list', action: 'list-crm-tasks', tier: 'read', capabilities: ['crm.view'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.task.get', action: 'get-crm-task', tier: 'read', capabilities: ['crm.view'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.activity.list', action: 'list-activities', tier: 'read', capabilities: ['crm.view'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.task.create', action: 'add-crm-task', tier: 'draft', capabilities: ['crm.manage'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.task.update', action: 'update-crm-task', tier: 'draft', capabilities: ['crm.manage'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.task.complete', action: 'complete-crm-task', tier: 'draft', capabilities: ['crm.manage'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.task.cancel', action: 'cancel-crm-task', tier: 'draft', capabilities: ['crm.manage'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.task.link', action: 'link-task-to-entity', tier: 'draft', capabilities: ['crm.manage'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.task.unlink', action: 'unlink-task-from-entity', tier: 'draft', capabilities: ['crm.manage'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'crm.activity.create', action: 'add-activity', tier: 'draft', capabilities: ['crm.manage'], approveCapability: null, module: 'erpclaw-growth', domain: 'erpclaw-crm', companyScoped: true, wave: '1' },
  { type: 'sales.customer.list', action: 'list-customers', tier: 'read', capabilities: ['sales.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-selling', companyScoped: true, wave: '1' },
  { type: 'sales.customer.get', action: 'get-customer', tier: 'read', capabilities: ['sales.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-selling', companyScoped: true, wave: '1' },
  { type: 'sales.customer.create', action: 'add-customer', tier: 'draft', capabilities: ['sales.draft'], approveCapability: null, module: 'foundation', domain: 'erpclaw-selling', companyScoped: true, wave: '1' },
  { type: 'sales.customer.update', action: 'update-customer', tier: 'draft', capabilities: ['sales.draft'], approveCapability: null, module: 'foundation', domain: 'erpclaw-selling', companyScoped: true, wave: '1' },
  { type: 'sales.customer.check_credit', action: 'check-credit-limit', tier: 'read', capabilities: ['sales.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-selling', companyScoped: true, wave: '1' },
  { type: 'sales.customer.hold_release', action: 'place-customer-on-hold', tier: 'commit', capabilities: ['finance.approve'], approveCapability: null, module: 'foundation', domain: 'erpclaw-selling', companyScoped: true, wave: '1-api' },
  { type: 'sales.quotation.list', action: 'list-quotations', tier: 'read', capabilities: ['sales.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-selling', companyScoped: true, wave: '1' },
  { type: 'sales.quotation.get', action: 'get-quotation', tier: 'read', capabilities: ['sales.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-selling', companyScoped: true, wave: '1' },
  { type: 'sales.quotation.create', action: 'add-quotation', tier: 'draft', capabilities: ['sales.draft'], approveCapability: null, module: 'foundation', domain: 'erpclaw-selling', companyScoped: true, wave: '1' },
  { type: 'sales.quotation.update', action: 'update-quotation', tier: 'draft', capabilities: ['sales.draft'], approveCapability: null, module: 'foundation', domain: 'erpclaw-selling', companyScoped: true, wave: '1' },
  { type: 'sales.quotation.submit', action: 'submit-quotation', tier: 'commit', capabilities: ['sales.commit'], approveCapability: null, module: 'foundation', domain: 'erpclaw-selling', companyScoped: true, wave: '1' },
  { type: 'sales.invoice.list', action: 'list-sales-invoices', tier: 'read', capabilities: ['sales.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-selling', companyScoped: true, wave: '1' },
  { type: 'sales.invoice.get', action: 'get-sales-invoice', tier: 'read', capabilities: ['sales.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-selling', companyScoped: true, wave: '1' },
  { type: 'sales.invoice.create', action: 'create-sales-invoice', tier: 'draft', capabilities: ['sales.draft'], approveCapability: null, module: 'foundation', domain: 'erpclaw-selling', companyScoped: true, wave: '1' },
  { type: 'sales.invoice.update', action: 'update-sales-invoice', tier: 'draft', capabilities: ['sales.draft'], approveCapability: null, module: 'foundation', domain: 'erpclaw-selling', companyScoped: true, wave: '1' },
  { type: 'sales.invoice.submit', action: 'submit-sales-invoice', tier: 'commit', capabilities: ['sales.commit'], approveCapability: null, module: 'foundation', domain: 'erpclaw-selling', companyScoped: true, wave: '1' },
  { type: 'sales.invoice.cancel', action: 'cancel-sales-invoice', tier: 'high', capabilities: ['sales.commit', 'finance.approve'], approveCapability: 'finance.approve', module: 'foundation', domain: 'erpclaw-selling', companyScoped: true, wave: '1' },
  { type: 'sales.credit_note.list', action: 'list-credit-notes', tier: 'read', capabilities: ['sales.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-selling', companyScoped: true, wave: '1' },
  { type: 'sales.credit_note.create', action: 'create-credit-note', tier: 'draft', capabilities: ['sales.draft'], approveCapability: null, module: 'foundation', domain: 'erpclaw-selling', companyScoped: true, wave: '1' },
  { type: 'sales.invoice.overdue', action: 'check-overdue', tier: 'read', capabilities: ['sales.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-reports', companyScoped: true, wave: '1' },
  { type: 'finance.payment.list', action: 'list-payments', tier: 'read', capabilities: ['finance.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-payments', companyScoped: true, wave: '1' },
  { type: 'finance.payment.get', action: 'get-payment', tier: 'read', capabilities: ['finance.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-payments', companyScoped: true, wave: '1' },
  { type: 'finance.outstanding.read', action: 'get-outstanding', tier: 'read', capabilities: ['finance.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-payments', companyScoped: true, wave: '1' },
  { type: 'finance.unallocated.read', action: 'get-unallocated-payments', tier: 'read', capabilities: ['finance.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-payments', companyScoped: true, wave: '1' },
  { type: 'finance.advances.read', action: 'list-open-advances', tier: 'read', capabilities: ['finance.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-payments', companyScoped: true, wave: '1' },
  { type: 'finance.payment.summary', action: 'payment-summary', tier: 'read', capabilities: ['finance.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-reports', companyScoped: true, wave: '1' },
  { type: 'finance.payment.record', action: 'add-payment', tier: 'draft', capabilities: ['finance.approve', 'accounting.post'], approveCapability: null, module: 'foundation', domain: 'erpclaw-payments', companyScoped: true, wave: '1' },
  { type: 'finance.payment.update', action: 'update-payment', tier: 'draft', capabilities: ['finance.approve', 'accounting.post'], approveCapability: null, module: 'foundation', domain: 'erpclaw-payments', companyScoped: true, wave: '1' },
  { type: 'finance.payment.submit', action: 'submit-payment', tier: 'commit', capabilities: ['finance.approve', 'accounting.post', 'finance.pay'], approveCapability: null, module: 'foundation', domain: 'erpclaw-payments', companyScoped: true, wave: '1' },
  { type: 'finance.payment.cancel', action: 'cancel-payment', tier: 'high', capabilities: ['finance.pay'], approveCapability: 'finance.pay', module: 'foundation', domain: 'erpclaw-payments', companyScoped: true, wave: '1' },
  { type: 'finance.payment.delete', action: 'delete-payment', tier: 'commit', capabilities: ['finance.approve'], approveCapability: null, module: 'foundation', domain: 'erpclaw-payments', companyScoped: true, wave: '1-api' },
  { type: 'finance.payment.allocate', action: 'allocate-payment', tier: 'commit', capabilities: ['finance.approve'], approveCapability: null, module: 'foundation', domain: 'erpclaw-payments', companyScoped: true, wave: '1' },
  { type: 'finance.payment.allocate.apply_advance_to_invoice', action: 'apply-advance-to-invoice', tier: 'commit', capabilities: ['finance.approve'], approveCapability: null, module: 'foundation', domain: 'erpclaw-payments', companyScoped: true, wave: '1' },
  { type: 'finance.bank.reconcile', action: 'reconcile-payments', tier: 'commit', capabilities: ['finance.reconcile'], approveCapability: null, module: 'foundation', domain: 'erpclaw-payments', companyScoped: true, wave: '1' },
  { type: 'finance.bank.reconcile.bank_reconciliation', action: 'bank-reconciliation', tier: 'commit', capabilities: ['finance.reconcile'], approveCapability: null, module: 'foundation', domain: 'erpclaw-payments', companyScoped: true, wave: '1' },
  { type: 'finance.invoice.write_off', action: 'write-off-invoice', tier: 'high', capabilities: ['finance.pay'], approveCapability: 'finance.pay', module: 'foundation', domain: 'erpclaw-payments', companyScoped: true, wave: '1-api' },
  { type: 'finance.fx.list', action: 'list-currencies', tier: 'read', capabilities: ['finance.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-setup', companyScoped: false, wave: '1' },
  { type: 'finance.fx.list.list_exchange_rates', action: 'list-exchange-rates', tier: 'read', capabilities: ['finance.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-setup', companyScoped: false, wave: '1' },
  { type: 'finance.fx.get', action: 'get-exchange-rate', tier: 'read', capabilities: ['finance.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-setup', companyScoped: false, wave: '1' },
  { type: 'finance.fx.add_currency', action: 'add-currency', tier: 'commit', capabilities: ['accounting.post'], approveCapability: null, module: 'foundation', domain: 'erpclaw-setup', companyScoped: false, wave: '1-api' },
  { type: 'finance.fx.set_rate', action: 'add-exchange-rate', tier: 'commit', capabilities: ['accounting.post'], approveCapability: null, module: 'foundation', domain: 'erpclaw-setup', companyScoped: false, wave: '1-api' },
  { type: 'finance.fx.fetch', action: 'fetch-exchange-rates', tier: 'commit', capabilities: ['accounting.post'], approveCapability: null, module: 'foundation', domain: 'erpclaw-setup', companyScoped: false, wave: '1-api' },
  { type: 'accounting.journal.list', action: 'list-journal-entries', tier: 'read', capabilities: ['accounting.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-journals', companyScoped: true, wave: '1' },
  { type: 'accounting.journal.get', action: 'get-journal-entry', tier: 'read', capabilities: ['accounting.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-journals', companyScoped: true, wave: '1' },
  { type: 'accounting.journal.create', action: 'add-journal-entry', tier: 'draft', capabilities: ['accounting.post'], approveCapability: null, module: 'foundation', domain: 'erpclaw-journals', companyScoped: true, wave: '1' },
  { type: 'accounting.journal.update', action: 'update-journal-entry', tier: 'draft', capabilities: ['accounting.post'], approveCapability: null, module: 'foundation', domain: 'erpclaw-journals', companyScoped: true, wave: '1' },
  { type: 'accounting.journal.duplicate', action: 'duplicate-journal-entry', tier: 'draft', capabilities: ['accounting.post'], approveCapability: null, module: 'foundation', domain: 'erpclaw-journals', companyScoped: true, wave: '1' },
  { type: 'accounting.journal.amend', action: 'amend-journal-entry', tier: 'draft', capabilities: ['accounting.post'], approveCapability: null, module: 'foundation', domain: 'erpclaw-journals', companyScoped: true, wave: '1' },
  { type: 'accounting.journal.submit', action: 'submit-journal-entry', tier: 'commit', capabilities: ['accounting.post', 'payroll.approve', 'accounting.close'], approveCapability: null, module: 'foundation', domain: 'erpclaw-journals', companyScoped: true, wave: '1' },
  { type: 'accounting.journal.cancel', action: 'cancel-journal-entry', tier: 'high', capabilities: ['accounting.close'], approveCapability: 'accounting.close', module: 'foundation', domain: 'erpclaw-journals', companyScoped: true, wave: '1' },
  { type: 'accounting.journal.delete', action: 'delete-journal-entry', tier: 'commit', capabilities: ['accounting.post'], approveCapability: null, module: 'foundation', domain: 'erpclaw-journals', companyScoped: true, wave: '1-api' },
  { type: 'accounting.coa.list', action: 'list-accounts', tier: 'read', capabilities: ['accounting.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-gl', companyScoped: true, wave: '1' },
  { type: 'accounting.coa.get', action: 'get-account', tier: 'read', capabilities: ['accounting.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-gl', companyScoped: true, wave: '1' },
  { type: 'accounting.account.balance', action: 'get-account-balance', tier: 'read', capabilities: ['accounting.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-gl', companyScoped: true, wave: '1' },
  { type: 'accounting.coa.add_account', action: 'add-account', tier: 'commit', capabilities: ['accounting.configure'], approveCapability: null, module: 'foundation', domain: 'erpclaw-gl', companyScoped: true, wave: '1' },
  { type: 'accounting.coa.update_account', action: 'update-account', tier: 'commit', capabilities: ['accounting.configure'], approveCapability: null, module: 'foundation', domain: 'erpclaw-gl', companyScoped: true, wave: '1' },
  { type: 'accounting.coa.freeze', action: 'freeze-account', tier: 'commit', capabilities: ['accounting.configure'], approveCapability: null, module: 'foundation', domain: 'erpclaw-gl', companyScoped: true, wave: '1-api' },
  { type: 'accounting.coa.unfreeze', action: 'unfreeze-account', tier: 'commit', capabilities: ['accounting.configure'], approveCapability: null, module: 'foundation', domain: 'erpclaw-gl', companyScoped: true, wave: '1-api' },
  { type: 'accounting.coa.load_template', action: 'setup-chart-of-accounts', tier: 'high', capabilities: ['erp.admin', 'accounting.close'], approveCapability: 'accounting.close', module: 'foundation', domain: 'erpclaw-gl', companyScoped: true, wave: '1-api' },
  { type: 'accounting.period.list', action: 'list-fiscal-years', tier: 'read', capabilities: ['accounting.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-gl', companyScoped: true, wave: '1' },
  { type: 'accounting.period.validate', action: 'validate-period-close', tier: 'read', capabilities: ['accounting.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-gl', companyScoped: true, wave: '1' },
  { type: 'accounting.period.create', action: 'add-fiscal-year', tier: 'commit', capabilities: ['accounting.configure'], approveCapability: null, module: 'foundation', domain: 'erpclaw-gl', companyScoped: true, wave: '1' },
  { type: 'accounting.period.close', action: 'close-fiscal-year', tier: 'high', capabilities: ['accounting.close'], approveCapability: 'accounting.close', module: 'foundation', domain: 'erpclaw-gl', companyScoped: true, wave: '1' },
  { type: 'accounting.period.reopen', action: 'reopen-fiscal-year', tier: 'high', capabilities: ['accounting.close'], approveCapability: 'accounting.close', module: 'foundation', domain: 'erpclaw-gl', companyScoped: true, wave: '1' },
  { type: 'accounting.fx.revalue', action: 'revalue-foreign-balances', tier: 'high', capabilities: ['accounting.close'], approveCapability: 'accounting.close', module: 'foundation', domain: 'erpclaw-gl', companyScoped: true, wave: '1' },
  { type: 'accounting.gl.list', action: 'list-gl-entries', tier: 'read', capabilities: ['accounting.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-gl', companyScoped: true, wave: '1' },
  { type: 'accounting.gl.list.general_ledger', action: 'general-ledger', tier: 'read', capabilities: ['accounting.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-reports', companyScoped: true, wave: '1' },
  { type: 'accounting.dimension.list', action: 'list-dimensions', tier: 'read', capabilities: ['accounting.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-gl', companyScoped: true, wave: '1-api' },
  { type: 'accounting.cost_center.list', action: 'list-cost-centers', tier: 'read', capabilities: ['accounting.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-gl', companyScoped: true, wave: '1-api' },
  { type: 'accounting.budget.list', action: 'list-budgets', tier: 'read', capabilities: ['accounting.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-gl', companyScoped: true, wave: '1-api' },
  { type: 'accounting.dimension.create', action: 'add-dimension', tier: 'commit', capabilities: ['accounting.configure'], approveCapability: null, module: 'foundation', domain: 'erpclaw-gl', companyScoped: true, wave: '1-api' },
  { type: 'accounting.dimension.update', action: 'update-dimension', tier: 'commit', capabilities: ['accounting.configure'], approveCapability: null, module: 'foundation', domain: 'erpclaw-gl', companyScoped: true, wave: '1-api' },
  { type: 'accounting.dimension.deactivate', action: 'deactivate-dimension', tier: 'commit', capabilities: ['accounting.configure'], approveCapability: null, module: 'foundation', domain: 'erpclaw-gl', companyScoped: true, wave: '1-api' },
  { type: 'accounting.cost_center.create', action: 'add-cost-center', tier: 'commit', capabilities: ['accounting.configure'], approveCapability: null, module: 'foundation', domain: 'erpclaw-gl', companyScoped: true, wave: '1-api' },
  { type: 'accounting.tax.template.list', action: 'list-tax-templates', tier: 'read', capabilities: ['accounting.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-tax', companyScoped: true, wave: '1-api' },
  { type: 'accounting.tax.template.get', action: 'get-tax-template', tier: 'read', capabilities: ['accounting.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-tax', companyScoped: true, wave: '1-api' },
  { type: 'accounting.tax.category.list', action: 'list-tax-categories', tier: 'read', capabilities: ['accounting.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-tax', companyScoped: true, wave: '1-api' },
  { type: 'accounting.tax.rule.list', action: 'list-tax-rules', tier: 'read', capabilities: ['accounting.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-tax', companyScoped: true, wave: '1-api' },
  { type: 'accounting.tax.resolve', action: 'resolve-tax-template', tier: 'read', capabilities: ['accounting.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-tax', companyScoped: true, wave: '1-api' },
  { type: 'accounting.tax.calculate', action: 'calculate-tax', tier: 'read', capabilities: ['accounting.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-tax', companyScoped: false, wave: '1' },
  { type: 'accounting.tax.template.create', action: 'add-tax-template', tier: 'commit', capabilities: ['accounting.configure'], approveCapability: null, module: 'foundation', domain: 'erpclaw-tax', companyScoped: true, wave: '1' },
  { type: 'accounting.tax.template.update', action: 'update-tax-template', tier: 'commit', capabilities: ['accounting.configure'], approveCapability: null, module: 'foundation', domain: 'erpclaw-tax', companyScoped: true, wave: '1' },
  { type: 'accounting.tax.category.create', action: 'add-tax-category', tier: 'commit', capabilities: ['accounting.configure'], approveCapability: null, module: 'foundation', domain: 'erpclaw-tax', companyScoped: true, wave: '1-api' },
  { type: 'accounting.tax.rule.create', action: 'add-tax-rule', tier: 'commit', capabilities: ['accounting.configure'], approveCapability: null, module: 'foundation', domain: 'erpclaw-tax', companyScoped: true, wave: '1-api' },
  { type: 'accounting.tax.item_template.create', action: 'add-item-tax-template', tier: 'commit', capabilities: ['accounting.configure'], approveCapability: null, module: 'foundation', domain: 'erpclaw-tax', companyScoped: true, wave: '1-api' },
  { type: 'accounting.tax.template.delete', action: 'delete-tax-template', tier: 'commit', capabilities: ['accounting.configure'], approveCapability: null, module: 'foundation', domain: 'erpclaw-tax', companyScoped: true, wave: '1' },
  { type: 'reports.pnl', action: 'profit-and-loss', tier: 'read', capabilities: ['reports.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-reports', companyScoped: true, wave: '1' },
  { type: 'reports.pnl.comparative_pl', action: 'comparative-pl', tier: 'read', capabilities: ['reports.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-reports', companyScoped: true, wave: '1' },
  { type: 'reports.ar_aging', action: 'ar-aging', tier: 'read', capabilities: ['reports.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-reports', companyScoped: true, wave: '1' },
  { type: 'reports.ap_aging', action: 'ap-aging', tier: 'read', capabilities: ['reports.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-reports', companyScoped: true, wave: '1' },
  { type: 'reports.trial_balance', action: 'trial-balance', tier: 'read', capabilities: ['reports.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-reports', companyScoped: true, wave: '1-api' },
  { type: 'reports.balance_sheet', action: 'balance-sheet', tier: 'read', capabilities: ['reports.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-reports', companyScoped: true, wave: '1-api' },
  { type: 'reports.cash_flow', action: 'cash-flow', tier: 'read', capabilities: ['reports.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-reports', companyScoped: true, wave: '1-api' },
  { type: 'reports.trial_balance_by_dimension', action: 'multi-dim-trial-balance', tier: 'read', capabilities: ['reports.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-reports', companyScoped: true, wave: '1-api' },
  { type: 'reports.dimension_balance', action: 'dimension-balance-report', tier: 'read', capabilities: ['reports.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-reports', companyScoped: true, wave: '1-api' },
  { type: 'reports.gl_summary', action: 'gl-summary', tier: 'read', capabilities: ['reports.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-reports', companyScoped: true, wave: '1-api' },
  { type: 'reports.party_ledger', action: 'party-ledger', tier: 'read', capabilities: ['reports.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-reports', companyScoped: true, wave: '1-api' },
  { type: 'reports.tax_summary', action: 'tax-summary', tier: 'read', capabilities: ['reports.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-reports', companyScoped: true, wave: '1-api' },
  { type: 'settings.company.list', action: 'list-companies', tier: 'read', capabilities: ['erp.admin', 'accounting.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-setup', companyScoped: false, wave: '1' },
  { type: 'settings.company.get', action: 'get-company', tier: 'read', capabilities: ['erp.admin', 'accounting.view'], approveCapability: null, module: 'foundation', domain: 'erpclaw-setup', companyScoped: true, wave: '1' },
  { type: 'settings.company.create', action: 'setup-company', tier: 'high', capabilities: ['erp.admin'], approveCapability: 'erp.admin', module: 'foundation', domain: 'erpclaw-setup', companyScoped: false, wave: '1' },
  { type: 'settings.company.update', action: 'update-company', tier: 'commit', capabilities: ['erp.admin'], approveCapability: null, module: 'foundation', domain: 'erpclaw-setup', companyScoped: true, wave: '1' },
  { type: 'settings.company.regional', action: 'update-regional-settings', tier: 'commit', capabilities: ['erp.admin'], approveCapability: null, module: 'foundation', domain: 'erpclaw-setup', companyScoped: true, wave: '1' },
  { type: 'settings.company.seed_defaults', action: 'seed-defaults', tier: 'commit', capabilities: ['erp.admin'], approveCapability: null, module: 'foundation', domain: 'erpclaw-setup', companyScoped: true, wave: '1-api' },
  { type: 'settings.payment_terms.list', action: 'list-payment-terms', tier: 'read', capabilities: ['accounting.configure'], approveCapability: null, module: 'foundation', domain: 'erpclaw-setup', companyScoped: true, wave: '1-api' },
  { type: 'settings.payment_terms.create', action: 'add-payment-terms', tier: 'commit', capabilities: ['accounting.configure'], approveCapability: null, module: 'foundation', domain: 'erpclaw-setup', companyScoped: true, wave: '1-api' },
  { type: 'settings.uom.list', action: 'list-uoms', tier: 'read', capabilities: ['accounting.configure'], approveCapability: null, module: 'foundation', domain: 'erpclaw-setup', companyScoped: false, wave: '1-api' },
  { type: 'settings.uom.create', action: 'add-uom', tier: 'commit', capabilities: ['accounting.configure'], approveCapability: null, module: 'foundation', domain: 'erpclaw-setup', companyScoped: false, wave: '1-api' },
  { type: 'settings.uom.convert', action: 'add-uom-conversion', tier: 'commit', capabilities: ['accounting.configure'], approveCapability: null, module: 'foundation', domain: 'erpclaw-setup', companyScoped: false, wave: '1-api' },
  { type: 'settings.registry.account_type.create', action: 'add-account-type', tier: 'commit', capabilities: ['erp.admin'], approveCapability: null, module: 'foundation', domain: 'erpclaw-setup', companyScoped: false, wave: '1-api' },
  { type: 'settings.registry.account_type.list', action: 'list-account-types', tier: 'read', capabilities: ['erp.admin'], approveCapability: null, module: 'foundation', domain: 'erpclaw-setup', companyScoped: false, wave: '1-api' },
  { type: 'settings.registry.voucher_type.create', action: 'add-voucher-type', tier: 'commit', capabilities: ['erp.admin'], approveCapability: null, module: 'foundation', domain: 'erpclaw-setup', companyScoped: false, wave: '1-api' },
  { type: 'settings.registry.voucher_type.list', action: 'list-voucher-types', tier: 'read', capabilities: ['erp.admin'], approveCapability: null, module: 'foundation', domain: 'erpclaw-setup', companyScoped: false, wave: '1-api' },
  { type: 'settings.registry.validate', action: 'validate-registry-completeness', tier: 'read', capabilities: ['erp.admin'], approveCapability: null, module: 'foundation', domain: 'erpclaw-setup', companyScoped: false, wave: '1-api' },
];

const BY_TYPE: ReadonlyMap<string, BackOfficeCommandSpec> = new Map(BACKOFFICE_COMMANDS.map((c) => [c.type, c]));
const BY_ACTION: ReadonlyMap<string, BackOfficeCommandSpec> = new Map(BACKOFFICE_COMMANDS.map((c) => [c.action, c]));

export function getCommandSpec(type: string): BackOfficeCommandSpec | undefined {
  return BY_TYPE.get(type);
}

export function getCommandSpecByAction(action: string): BackOfficeCommandSpec | undefined {
  return BY_ACTION.get(action);
}

export const COMMAND_TYPES: readonly string[] = BACKOFFICE_COMMANDS.map((c) => c.type);
