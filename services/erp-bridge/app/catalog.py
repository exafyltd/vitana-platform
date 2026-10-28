"""Versioned action allowlist for erp-bridge (VTID-03840).

Source of truth for WHAT the bridge will run. Everything not listed here is
refused before any subprocess starts. The tier/capability columns are
copied from docs/backoffice/GOLDEN-WORKFLOWS.md §4 (VTID-03831); the
gateway (VTID-F) enforces capability + maker-checker, the bridge enforces
that Commit/High-risk actions arrive with an admitted confirmation and
that ERPClaw's own `--user-confirmed` gate is only ever set by the bridge.

Parameter admission: a request param `foo_bar` becomes `--foo-bar` ONLY if
(a) the spec admits the name (explicit `params`, or by default every flag
the pinned domain script declares minus DENY_FLAGS) and (b) the pinned
manifest (vendor/action-flags.json, generated from the vendored trees)
declares that flag for the action's domain. No model-selected CLI flags.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any, Literal

CATALOG_VERSION = "v1"
ERPCLAW_PIN = "4d32db6585297a1d05a7b5927168de8c75bb7708"        # avansaber/erpclaw  (v4.15.0)
ERPCLAW_ADDONS_PIN = "7c1b5ae5701980e97f34cf25fa5943066140f6a3"  # avansaber/erpclaw-addons (erpclaw-growth 2.10.0)
FX_API_HOST = "api.frankfurter.dev"   # the ONE outbound host fetch-exchange-rates needs

Tier = Literal["read", "draft", "commit", "high"]
FOUNDATION = "foundation"
GROWTH = "erpclaw-growth"

# Copied verbatim from the pinned router's DANGEROUS_ACTIONS (74). A test
# re-derives it from the vendored router when ERPCLAW_ROOT is available.
DANGEROUS_ACTIONS = frozenset("""
add-role approve-expense-claim approve-ic-transaction approve-leave assign-role cancel-delivery-note
cancel-intercompany-invoice cancel-journal-entry cancel-payment cancel-payroll-run cancel-pick-list
cancel-purchase-invoice cancel-purchase-order cancel-purchase-receipt cancel-sales-invoice cancel-sales-order
cancel-stock-entry cancel-stock-revaluation cleanup-backups close-fiscal-year complete-pick-list
create-payroll-run delete-credential delete-journal-entry delete-payment delete-recurring-template
delete-tax-template freeze-account generate-nacha-file generate-w2-data import-master-key-from-backup
initialize-database install-module legal-write-off-invoice migrate migrate-credentials post-gl-entries
reject-expense-claim reject-leave remove-elimination-surplus remove-module reopen-fiscal-year
restore-database reverse-gl-entries revoke-role rollback-foundation run-consolidation schema-apply
schema-rollback seed-permissions set-credential set-password submit-blanket-order submit-blanket-po
submit-delivery-note submit-journal-entry submit-material-request submit-payment submit-payroll-run
submit-pick-list submit-purchase-invoice submit-purchase-order submit-purchase-receipt submit-quotation
submit-rfq submit-sales-invoice submit-sales-order submit-stock-entry submit-stock-reconciliation
unfreeze-account update-foundation update-modules update-user write-off-invoice
""".split())

# Never dispatchable through the bridge, whatever a caller sends (§4.2
# "never exposed" rows + every install/schema/credential/user path).
NEVER_EXPOSED = frozenset("""
post-gl-entries reverse-gl-entries install-module remove-module update-modules update-foundation
rollback-foundation initialize-database restore-database backup-database cleanup-backups migrate
schema-apply schema-rollback set-credential delete-credential migrate-credentials
import-master-key-from-backup set-password add-role assign-role revoke-role seed-permissions update-user
sync-registry available-modules generate-nacha-file generate-w2-data update-invoice-outstanding
update-purchase-outstanding create-payment-ledger-entry seed-naming-series next-series seed-demo-data
run-consolidation remove-elimination-surplus
""".split())

# Flags a request can never set, whatever the domain declares them.
DENY_FLAGS = frozenset("""
--action --db-path --db-url --user-confirmed --force --confirm --dry-run --from-stdin --from-env
--passphrase-from-stdin --passphrase-from-env --csv-path --company --company-id --no-reconcile-check
--target-table --table --backup-path --output-path --file-path --path --encrypt --reset
""".split())

# Flags whose value is a JSON document (list/dict) rather than a scalar.
JSON_FLAGS = frozenset("""
--lines --items --item-overrides --allocations --deductions --entries --values --custom-fields
--fields --rules --stages --lines-json --items-json
""".split())


@dataclass(frozen=True)
class ActionSpec:
    name: str                 # ERPClaw action
    command: str              # typed command name (gateway-facing)
    tier: Tier
    capabilities: tuple[str, ...]
    domain: str               # foundation domain script or module domain
    module: str = FOUNDATION  # FOUNDATION or an allowlisted expansion module
    params: tuple[str, ...] | None = None   # explicit admitted param names; None => domain flags − DENY
    company_scoped: bool = True
    wave: str = "1"
    note: str = ""

    @property
    def dangerous(self) -> bool:
        return self.name in DANGEROUS_ACTIONS

    @property
    def requires_confirmation(self) -> bool:
        return self.tier in ("commit", "high")


class CatalogError(ValueError):
    pass


_MANIFEST_PATH = os.path.join(os.path.dirname(__file__), "..", "vendor", "action-flags.json")


def _load_manifest() -> dict[str, Any]:
    with open(_MANIFEST_PATH, encoding="utf-8") as fh:
        return json.load(fh)


MANIFEST = _load_manifest()

# Actions served by module_manager.py rather than a domain script; their
# flags are pinned here because the manifest scanner only reads domain scripts.
_PSEUDO_DOMAIN_FLAGS: dict[str, dict[str, dict[str, bool]]] = {
    "module-manager": {"--module-name": {"store_true": False}},
}


def domain_flags(spec: ActionSpec) -> dict[str, dict[str, bool]]:
    if spec.domain in _PSEUDO_DOMAIN_FLAGS:
        return _PSEUDO_DOMAIN_FLAGS[spec.domain]
    if spec.module == FOUNDATION:
        return MANIFEST["foundation"]["domains"][spec.domain]["flags"]
    return MANIFEST["modules"][spec.module]["domains"][spec.domain]["flags"]


def to_flag(param: str) -> str:
    if not param or not param.replace("_", "").isalnum() or not param[0].isalpha():
        raise CatalogError(f"bad parameter name {param!r}")
    return "--" + param.lower().replace("_", "-")


def admitted_flag(spec: ActionSpec, param: str) -> tuple[str, bool]:
    """Return (flag, store_true) for an admitted param or raise CatalogError."""
    flag = to_flag(param)
    if flag in DENY_FLAGS:
        raise CatalogError(f"parameter {param!r} is not admitted")
    if spec.params is not None and param not in spec.params:
        raise CatalogError(f"parameter {param!r} is not admitted for {spec.name}")
    flags = domain_flags(spec)
    if flag not in flags:
        raise CatalogError(f"parameter {param!r} is not a declared flag of {spec.domain}")
    return flag, bool(flags[flag].get("store_true"))


def admitted_params(spec: ActionSpec) -> list[str]:
    if spec.params is not None:
        return list(spec.params)
    return sorted(f[2:].replace("-", "_") for f in domain_flags(spec) if f not in DENY_FLAGS)


def _a(name, command, tier, caps, domain, **kw) -> ActionSpec:
    caps = (caps,) if isinstance(caps, str) else tuple(caps)
    return ActionSpec(name=name, command=command, tier=tier, capabilities=caps, domain=domain, **kw)


_SPECS: list[ActionSpec] = [
    # --- Overview / Health / Audit ---------------------------------------
    _a("status", "erp.health.read", "read", ("erp.admin", "audit.view"), "erpclaw-setup", company_scoped=False, params=()),
    _a("check-installation", "erp.health.read", "read", ("erp.admin", "audit.view"), "erpclaw-meta", company_scoped=False, params=()),
    _a("get-schema-version", "erp.health.read", "read", ("erp.admin", "audit.view"), "erpclaw-setup", company_scoped=False, params=()),
    _a("list-modules", "erp.health.read", "read", ("erp.admin", "audit.view"), "module-manager", company_scoped=False, params=()),
    _a("module-status", "erp.health.read", "read", ("erp.admin", "audit.view"), "module-manager", company_scoped=False, params=("module_name",)),
    _a("get-audit-log", "audit.erp_log.read", "read", "audit.view", "erpclaw-setup", company_scoped=False),
    _a("check-gl-integrity", "accounting.gl.integrity_check", "read", "accounting.view", "erpclaw-gl"),
    # --- CRM (erpclaw-growth, CRM domain only) ---------------------------
    _a("list-leads", "crm.lead.list", "read", "crm.view", "erpclaw-crm", module=GROWTH),
    _a("get-lead", "crm.lead.get", "read", "crm.view", "erpclaw-crm", module=GROWTH),
    _a("list-lead-sources", "crm.lead_source.list", "read", "crm.view", "erpclaw-crm", module=GROWTH),
    _a("add-lead", "crm.lead.create", "draft", "crm.manage", "erpclaw-crm", module=GROWTH),
    _a("update-lead", "crm.lead.update", "draft", "crm.manage", "erpclaw-crm", module=GROWTH),
    _a("add-lead-source", "crm.lead_source.create", "draft", "crm.manage", "erpclaw-crm", module=GROWTH),
    _a("convert-lead-to-opportunity", "crm.lead.convert", "commit", "crm.manage", "erpclaw-crm", module=GROWTH),
    _a("list-crm-contacts", "crm.contact.list", "read", "crm.view", "erpclaw-crm", module=GROWTH),
    _a("get-crm-contact", "crm.contact.get", "read", "crm.view", "erpclaw-crm", module=GROWTH),
    _a("list-crm-companies", "crm.company.list", "read", "crm.view", "erpclaw-crm", module=GROWTH),
    _a("get-crm-company", "crm.company.get", "read", "crm.view", "erpclaw-crm", module=GROWTH),
    _a("add-crm-contact", "crm.contact.create", "draft", "crm.manage", "erpclaw-crm", module=GROWTH),
    _a("update-crm-contact", "crm.contact.update", "draft", "crm.manage", "erpclaw-crm", module=GROWTH),
    _a("add-crm-company", "crm.company.create", "draft", "crm.manage", "erpclaw-crm", module=GROWTH),
    _a("update-crm-company", "crm.company.update", "draft", "crm.manage", "erpclaw-crm", module=GROWTH),
    _a("link-contact-to-company", "crm.contact.link_company", "draft", "crm.manage", "erpclaw-crm", module=GROWTH),
    _a("merge-crm-contacts", "crm.contact.merge", "commit", "crm.manage", "erpclaw-crm", module=GROWTH),
    _a("remove-crm-contact", "crm.contact.remove", "commit", "crm.manage", "erpclaw-crm", module=GROWTH),
    _a("promote-contact-to-customer", "crm.contact.promote_to_customer", "commit", ("crm.manage", "sales.draft"), "erpclaw-crm", module=GROWTH),
    _a("list-opportunities", "crm.opportunity.list", "read", "crm.view", "erpclaw-crm", module=GROWTH),
    _a("get-opportunity", "crm.opportunity.get", "read", "crm.view", "erpclaw-crm", module=GROWTH),
    _a("pipeline-report", "crm.pipeline.report", "read", "crm.view", "erpclaw-crm", module=GROWTH),
    _a("add-opportunity", "crm.opportunity.create", "draft", "crm.manage", "erpclaw-crm", module=GROWTH),
    _a("update-opportunity", "crm.opportunity.update", "draft", "crm.manage", "erpclaw-crm", module=GROWTH),
    _a("set-opportunity-pipeline-stage", "crm.opportunity.set_stage", "draft", "crm.manage", "erpclaw-crm", module=GROWTH),
    _a("mark-opportunity-won", "crm.opportunity.mark_won", "commit", "crm.manage", "erpclaw-crm", module=GROWTH),
    _a("mark-opportunity-lost", "crm.opportunity.mark_lost", "commit", "crm.manage", "erpclaw-crm", module=GROWTH),
    _a("convert-opportunity-to-quotation", "crm.opportunity.convert_to_quotation", "draft", ("crm.manage", "sales.draft"), "erpclaw-crm", module=GROWTH),
    _a("list-crm-pipelines", "crm.pipeline.list", "read", "crm.view", "erpclaw-crm", module=GROWTH),
    _a("list-crm-pipeline-stages", "crm.pipeline_stage.list", "read", "crm.view", "erpclaw-crm", module=GROWTH),
    _a("add-crm-pipeline", "crm.pipeline.create", "commit", "crm.manage", "erpclaw-crm", module=GROWTH, wave="1-api"),
    _a("add-crm-pipeline-stage", "crm.pipeline_stage.create", "commit", "crm.manage", "erpclaw-crm", module=GROWTH, wave="1-api"),
    _a("update-crm-pipeline-stage", "crm.pipeline_stage.update", "commit", "crm.manage", "erpclaw-crm", module=GROWTH, wave="1-api"),
    _a("list-crm-tasks", "crm.task.list", "read", "crm.view", "erpclaw-crm", module=GROWTH),
    _a("get-crm-task", "crm.task.get", "read", "crm.view", "erpclaw-crm", module=GROWTH),
    _a("list-activities", "crm.activity.list", "read", "crm.view", "erpclaw-crm", module=GROWTH),
    _a("add-crm-task", "crm.task.create", "draft", "crm.manage", "erpclaw-crm", module=GROWTH),
    _a("update-crm-task", "crm.task.update", "draft", "crm.manage", "erpclaw-crm", module=GROWTH),
    _a("complete-crm-task", "crm.task.complete", "draft", "crm.manage", "erpclaw-crm", module=GROWTH),
    _a("cancel-crm-task", "crm.task.cancel", "draft", "crm.manage", "erpclaw-crm", module=GROWTH),
    _a("link-task-to-entity", "crm.task.link", "draft", "crm.manage", "erpclaw-crm", module=GROWTH),
    _a("unlink-task-from-entity", "crm.task.unlink", "draft", "crm.manage", "erpclaw-crm", module=GROWTH),
    _a("add-activity", "crm.activity.create", "draft", "crm.manage", "erpclaw-crm", module=GROWTH),
    # --- Selling ---------------------------------------------------------
    _a("list-customers", "sales.customer.list", "read", "sales.view", "erpclaw-selling"),
    _a("get-customer", "sales.customer.get", "read", "sales.view", "erpclaw-selling"),
    _a("add-customer", "sales.customer.create", "draft", "sales.draft", "erpclaw-selling"),
    _a("update-customer", "sales.customer.update", "draft", "sales.draft", "erpclaw-selling"),
    _a("check-credit-limit", "sales.customer.check_credit", "read", "sales.view", "erpclaw-selling"),
    _a("place-customer-on-hold", "sales.customer.hold_release", "commit", "finance.approve", "erpclaw-selling", wave="1-api"),
    _a("list-quotations", "sales.quotation.list", "read", "sales.view", "erpclaw-selling"),
    _a("get-quotation", "sales.quotation.get", "read", "sales.view", "erpclaw-selling"),
    _a("add-quotation", "sales.quotation.create", "draft", "sales.draft", "erpclaw-selling"),
    _a("update-quotation", "sales.quotation.update", "draft", "sales.draft", "erpclaw-selling"),
    _a("submit-quotation", "sales.quotation.submit", "commit", "sales.commit", "erpclaw-selling"),
    _a("list-sales-invoices", "sales.invoice.list", "read", "sales.view", "erpclaw-selling"),
    _a("get-sales-invoice", "sales.invoice.get", "read", "sales.view", "erpclaw-selling"),
    _a("create-sales-invoice", "sales.invoice.create", "draft", "sales.draft", "erpclaw-selling"),
    _a("update-sales-invoice", "sales.invoice.update", "draft", "sales.draft", "erpclaw-selling"),
    _a("submit-sales-invoice", "sales.invoice.submit", "commit", "sales.commit", "erpclaw-selling"),
    _a("cancel-sales-invoice", "sales.invoice.cancel", "high", ("sales.commit", "finance.approve"), "erpclaw-selling"),
    _a("list-credit-notes", "sales.credit_note.list", "read", "sales.view", "erpclaw-selling"),
    _a("create-credit-note", "sales.credit_note.create", "draft", "sales.draft", "erpclaw-selling",
       note="GW-3 A: a credit note is a sales_invoice with is_return; its submit is submit-sales-invoice at High-risk (pinned VTID-E)"),
    _a("check-overdue", "sales.invoice.overdue", "read", "sales.view", "erpclaw-reports"),
    # --- Payments --------------------------------------------------------
    _a("list-payments", "finance.payment.list", "read", "finance.view", "erpclaw-payments"),
    _a("get-payment", "finance.payment.get", "read", "finance.view", "erpclaw-payments"),
    _a("get-outstanding", "finance.outstanding.read", "read", "finance.view", "erpclaw-payments"),
    _a("get-unallocated-payments", "finance.unallocated.read", "read", "finance.view", "erpclaw-payments"),
    _a("list-open-advances", "finance.advances.read", "read", "finance.view", "erpclaw-payments"),
    _a("payment-summary", "finance.payment.summary", "read", "finance.view", "erpclaw-reports"),
    _a("add-payment", "finance.payment.record", "draft", ("finance.approve", "accounting.post"), "erpclaw-payments"),
    _a("update-payment", "finance.payment.update", "draft", ("finance.approve", "accounting.post"), "erpclaw-payments"),
    _a("submit-payment", "finance.payment.submit", "commit", ("finance.approve", "accounting.post", "finance.pay"), "erpclaw-payments",
       note="Commit for kind=receive; High-risk (approver finance.pay) for kind=pay — escalation decided by the gateway policy from the payment's type"),
    _a("cancel-payment", "finance.payment.cancel", "high", "finance.pay", "erpclaw-payments"),
    _a("delete-payment", "finance.payment.delete", "commit", "finance.approve", "erpclaw-payments", wave="1-api"),
    _a("allocate-payment", "finance.payment.allocate", "commit", "finance.approve", "erpclaw-payments"),
    _a("apply-advance-to-invoice", "finance.payment.allocate", "commit", "finance.approve", "erpclaw-payments"),
    _a("reconcile-payments", "finance.bank.reconcile", "commit", "finance.reconcile", "erpclaw-payments"),
    _a("bank-reconciliation", "finance.bank.reconcile", "commit", "finance.reconcile", "erpclaw-payments"),
    _a("write-off-invoice", "finance.invoice.write_off", "high", "finance.pay", "erpclaw-payments", wave="1-api"),
    _a("list-currencies", "finance.fx.list", "read", "finance.view", "erpclaw-setup", company_scoped=False),
    _a("list-exchange-rates", "finance.fx.list", "read", "finance.view", "erpclaw-setup", company_scoped=False),
    _a("get-exchange-rate", "finance.fx.get", "read", "finance.view", "erpclaw-setup", company_scoped=False),
    _a("add-currency", "finance.fx.add_currency", "commit", "accounting.post", "erpclaw-setup", company_scoped=False, wave="1-api"),
    _a("add-exchange-rate", "finance.fx.set_rate", "commit", "accounting.post", "erpclaw-setup", company_scoped=False, wave="1-api"),
    _a("fetch-exchange-rates", "finance.fx.fetch", "commit", "accounting.post", "erpclaw-setup", company_scoped=False, wave="1-api",
       note=f"explicitly allowlisted outbound call: https://{FX_API_HOST} only (egress policy pins that host)"),
    # --- Accounting: journals -------------------------------------------
    _a("list-journal-entries", "accounting.journal.list", "read", "accounting.view", "erpclaw-journals"),
    _a("get-journal-entry", "accounting.journal.get", "read", "accounting.view", "erpclaw-journals"),
    _a("add-journal-entry", "accounting.journal.create", "draft", "accounting.post", "erpclaw-journals",
       params=("posting_date", "entry_type", "remark", "lines", "amended_from", "cwip_asset_id")),
    _a("update-journal-entry", "accounting.journal.update", "draft", "accounting.post", "erpclaw-journals",
       params=("journal_entry_id", "posting_date", "entry_type", "remark", "lines")),
    _a("duplicate-journal-entry", "accounting.journal.duplicate", "draft", "accounting.post", "erpclaw-journals",
       params=("journal_entry_id", "posting_date")),
    _a("amend-journal-entry", "accounting.journal.amend", "draft", "accounting.post", "erpclaw-journals",
       params=("journal_entry_id", "posting_date", "remark", "lines")),
    _a("submit-journal-entry", "accounting.journal.submit", "commit", ("accounting.post", "payroll.approve", "accounting.close"), "erpclaw-journals",
       params=("journal_entry_id",), note="High-risk when tags contain payroll or amount >= policy threshold (gateway policy)"),
    _a("cancel-journal-entry", "accounting.journal.cancel", "high", "accounting.close", "erpclaw-journals", params=("journal_entry_id",)),
    _a("delete-journal-entry", "accounting.journal.delete", "commit", "accounting.post", "erpclaw-journals", params=("journal_entry_id",), wave="1-api"),
    # --- Accounting: CoA / periods / GL / dimensions ---------------------
    _a("list-accounts", "accounting.coa.list", "read", "accounting.view", "erpclaw-gl"),
    _a("get-account", "accounting.coa.get", "read", "accounting.view", "erpclaw-gl"),
    _a("get-account-balance", "accounting.account.balance", "read", "accounting.view", "erpclaw-gl"),
    _a("add-account", "accounting.coa.add_account", "commit", "accounting.configure", "erpclaw-gl"),
    _a("update-account", "accounting.coa.update_account", "commit", "accounting.configure", "erpclaw-gl"),
    _a("freeze-account", "accounting.coa.freeze", "commit", "accounting.configure", "erpclaw-gl", wave="1-api"),
    _a("unfreeze-account", "accounting.coa.unfreeze", "commit", "accounting.configure", "erpclaw-gl", wave="1-api"),
    _a("setup-chart-of-accounts", "accounting.coa.load_template", "high", ("erp.admin", "accounting.close"), "erpclaw-gl", params=("template",), wave="1-api"),
    _a("list-fiscal-years", "accounting.period.list", "read", "accounting.view", "erpclaw-gl"),
    _a("validate-period-close", "accounting.period.validate", "read", "accounting.view", "erpclaw-gl"),
    _a("add-fiscal-year", "accounting.period.create", "commit", "accounting.configure", "erpclaw-gl"),
    _a("close-fiscal-year", "accounting.period.close", "high", "accounting.close", "erpclaw-gl"),
    _a("reopen-fiscal-year", "accounting.period.reopen", "high", "accounting.close", "erpclaw-gl"),
    _a("revalue-foreign-balances", "accounting.fx.revalue", "high", "accounting.close", "erpclaw-gl"),
    _a("list-gl-entries", "accounting.gl.list", "read", "accounting.view", "erpclaw-gl"),
    _a("general-ledger", "accounting.gl.list", "read", "accounting.view", "erpclaw-reports"),
    _a("list-dimensions", "accounting.dimension.list", "read", "accounting.view", "erpclaw-gl", wave="1-api"),
    _a("list-cost-centers", "accounting.cost_center.list", "read", "accounting.view", "erpclaw-gl", wave="1-api"),
    _a("list-budgets", "accounting.budget.list", "read", "accounting.view", "erpclaw-gl", wave="1-api"),
    _a("add-dimension", "accounting.dimension.create", "commit", "accounting.configure", "erpclaw-gl", wave="1-api"),
    _a("update-dimension", "accounting.dimension.update", "commit", "accounting.configure", "erpclaw-gl", wave="1-api"),
    _a("deactivate-dimension", "accounting.dimension.deactivate", "commit", "accounting.configure", "erpclaw-gl", wave="1-api"),
    _a("add-cost-center", "accounting.cost_center.create", "commit", "accounting.configure", "erpclaw-gl", wave="1-api"),
    # --- Accounting: tax --------------------------------------------------
    _a("list-tax-templates", "accounting.tax.template.list", "read", "accounting.view", "erpclaw-tax", wave="1-api"),
    _a("get-tax-template", "accounting.tax.template.get", "read", "accounting.view", "erpclaw-tax", wave="1-api"),
    _a("list-tax-categories", "accounting.tax.category.list", "read", "accounting.view", "erpclaw-tax", wave="1-api"),
    _a("list-tax-rules", "accounting.tax.rule.list", "read", "accounting.view", "erpclaw-tax", wave="1-api"),
    _a("resolve-tax-template", "accounting.tax.resolve", "read", "accounting.view", "erpclaw-tax", wave="1-api"),
    _a("calculate-tax", "accounting.tax.calculate", "read", "accounting.view", "erpclaw-tax", company_scoped=False,
       params=("tax_template_id", "items", "item_overrides"), wave="1-api"),
    _a("add-tax-template", "accounting.tax.template.create", "commit", "accounting.configure", "erpclaw-tax",
       params=("name", "tax_type", "lines", "is_default", "tax_category_id"), wave="1-api"),
    _a("update-tax-template", "accounting.tax.template.update", "commit", "accounting.configure", "erpclaw-tax",
       params=("tax_template_id", "name", "lines", "is_default", "tax_category_id"), wave="1-api"),
    _a("add-tax-category", "accounting.tax.category.create", "commit", "accounting.configure", "erpclaw-tax", wave="1-api"),
    _a("add-tax-rule", "accounting.tax.rule.create", "commit", "accounting.configure", "erpclaw-tax", wave="1-api"),
    _a("add-item-tax-template", "accounting.tax.item_template.create", "commit", "accounting.configure", "erpclaw-tax", wave="1-api"),
    _a("delete-tax-template", "accounting.tax.template.delete", "commit", "accounting.configure", "erpclaw-tax",
       params=("tax_template_id",), wave="1-api"),
    # --- Reports ---------------------------------------------------------
    _a("profit-and-loss", "reports.pnl", "read", "reports.view", "erpclaw-reports"),
    _a("comparative-pl", "reports.pnl", "read", "reports.view", "erpclaw-reports"),
    _a("ar-aging", "reports.ar_aging", "read", "reports.view", "erpclaw-reports"),
    _a("ap-aging", "reports.ap_aging", "read", "reports.view", "erpclaw-reports"),
    _a("trial-balance", "reports.trial_balance", "read", "reports.view", "erpclaw-reports", wave="1-api"),
    _a("balance-sheet", "reports.balance_sheet", "read", "reports.view", "erpclaw-reports", wave="1-api"),
    _a("cash-flow", "reports.cash_flow", "read", "reports.view", "erpclaw-reports", wave="1-api"),
    _a("multi-dim-trial-balance", "reports.trial_balance_by_dimension", "read", "reports.view", "erpclaw-reports", wave="1-api"),
    _a("dimension-balance-report", "reports.dimension_balance", "read", "reports.view", "erpclaw-reports", wave="1-api"),
    _a("gl-summary", "reports.gl_summary", "read", "reports.view", "erpclaw-reports", wave="1-api"),
    _a("party-ledger", "reports.party_ledger", "read", "reports.view", "erpclaw-reports", wave="1-api"),
    _a("tax-summary", "reports.tax_summary", "read", "reports.view", "erpclaw-reports", wave="1-api"),
    # --- Settings › Company ---------------------------------------------
    _a("list-companies", "settings.company.list", "read", ("erp.admin", "accounting.view"), "erpclaw-setup", company_scoped=False, params=("limit", "offset")),
    _a("get-company", "settings.company.get", "read", ("erp.admin", "accounting.view"), "erpclaw-setup"),
    _a("setup-company", "settings.company.create", "high", "erp.admin", "erpclaw-setup", company_scoped=False,
       params=("name", "abbr", "currency", "country", "industry", "tax_id", "fiscal_year_start_month")),
    _a("update-company", "settings.company.update", "commit", "erp.admin", "erpclaw-setup"),
    _a("update-regional-settings", "settings.company.regional", "commit", "erp.admin", "erpclaw-setup"),
    _a("seed-defaults", "settings.company.seed_defaults", "commit", "erp.admin", "erpclaw-setup", params=(), wave="1-api"),
    _a("list-payment-terms", "settings.payment_terms.list", "read", "accounting.configure", "erpclaw-setup", wave="1-api"),
    _a("add-payment-terms", "settings.payment_terms.create", "commit", "accounting.configure", "erpclaw-setup", wave="1-api"),
    _a("list-uoms", "settings.uom.list", "read", "accounting.configure", "erpclaw-setup", company_scoped=False, wave="1-api"),
    _a("add-uom", "settings.uom.create", "commit", "accounting.configure", "erpclaw-setup", company_scoped=False, wave="1-api"),
    _a("add-uom-conversion", "settings.uom.convert", "commit", "accounting.configure", "erpclaw-setup", company_scoped=False, wave="1-api"),
    _a("add-account-type", "settings.registry.account_type.create", "commit", "erp.admin", "erpclaw-setup", company_scoped=False, wave="1-api"),
    _a("list-account-types", "settings.registry.account_type.list", "read", "erp.admin", "erpclaw-setup", company_scoped=False, wave="1-api"),
    _a("add-voucher-type", "settings.registry.voucher_type.create", "commit", "erp.admin", "erpclaw-setup", company_scoped=False, wave="1-api"),
    _a("list-voucher-types", "settings.registry.voucher_type.list", "read", "erp.admin", "erpclaw-setup", company_scoped=False, wave="1-api"),
    _a("validate-registry-completeness", "settings.registry.validate", "read", "erp.admin", "erpclaw-setup", company_scoped=False, wave="1-api"),
]

CATALOG: dict[str, ActionSpec] = {}
for _s in _SPECS:
    if _s.name in CATALOG:
        raise RuntimeError(f"duplicate catalog entry {_s.name}")
    if _s.name in NEVER_EXPOSED:
        raise RuntimeError(f"{_s.name} is on NEVER_EXPOSED and cannot be in the catalog")
    CATALOG[_s.name] = _s


def get_spec(action: str) -> ActionSpec:
    spec = CATALOG.get(action)
    if spec is None:
        raise CatalogError(f"action {action!r} is not allowlisted")
    return spec


def public_catalog() -> list[dict[str, Any]]:
    return [{
        "action": s.name, "command": s.command, "tier": s.tier, "capabilities": list(s.capabilities),
        "module": s.module, "domain": s.domain, "wave": s.wave, "erpclaw_gated": s.dangerous,
        "company_scoped": s.company_scoped, "params": admitted_params(s), "note": s.note,
    } for s in CATALOG.values()]
