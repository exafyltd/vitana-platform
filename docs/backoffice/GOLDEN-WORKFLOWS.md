# Vitanaland BackOffice — Operating Design Gate (VTID-03831)

**Status:** design-gate artefact, no code. This is Phase 1 of the BackOffice
plan (Plan v3.2, "Operating design gate"). Every architectural and product
decision it rests on was taken by the platform owner on 2026-09-12 and is
recorded in the plan's Decision Log; this document does not re-open any of
them. It turns those decisions into the four things the following VTIDs
build against:

1. the four minimum **golden workflows** with owner, approver, exception
   path, accounting result and acceptance test (§2);
2. the **capability catalog and default grants per role** (§3);
3. the **wave-1 ERPClaw action → typed command → tier mapping** (§4),
   derived from ERPClaw's own action catalog at the pinned commit, not
   from memory;
4. the **UAE compliance items** with an owner column (§5).

It closes with the four still-open named-owner items, marked UNASSIGNED
(§7), and with the code-level findings from reading the pinned ERPClaw
tree that the foundation spike (VTID-E) must prove rather than assume (§6).

Where this document and a repo `CLAUDE.md` differ, the stricter rule wins.

---

## 1. Inherited ground truth

### 1.1 Pinned references (read for this document)

| Repo | Commit | Used for |
|---|---|---|
| `avansaber/erpclaw` | `4d32db6585297a1d05a7b5927168de8c75bb7708` (v4.15.0) | `SKILL.md` action catalog (496 actions / 14 domains), `scripts/db_query.py` `DANGEROUS_ACTIONS` gate, `scripts/erpclaw-gl/db_query.py` CoA loader, `scripts/erpclaw-tax/db_query.py` tax-line model, `scripts/erpclaw-gl/assets/charts/us_gaap.json`, `scripts/module_registry.json` (46 modules) |
| `avansaber/erpclaw-addons` | `7c1b5ae5701980e97f34cf25fa5943066140f6a3` (HEAD on 2026-09-12; **not yet the pin** — VTID-E pins it) | `erpclaw-growth/SKILL.md` — the CRM module's own action list and its confirmation rules |
| `avansaber/erpclaw-web`, `avansaber/webclaw` | `898ed5fd…`, `1d150ba1…` | reference only, not read for this document |

**The "CRM module" is `erpclaw-growth` v2.10.0** (registry key
`erpclaw-growth`, `github: avansaber/erpclaw-addons`, `subdir:
erpclaw-growth`). It bundles four domains: CRM, CRM Advanced, Analytics
(25 actions) and AI Engine (21 actions). Decision 6's "wave-1 allowlist =
CRM only" therefore means: vendor the module as one unit (its `init_db.py`
and migrations are shared), but the bridge allowlists **only the CRM
domain actions listed in §4.2** — none of CRM Advanced (email campaigns,
territories, contracts, automation), Analytics or AI Engine. Any of those
is a separate owner approval.

### 1.2 Decisions this document executes (not re-opens)

| # | Decision | Consequence here |
|---|---|---|
| 1 | GPLv3, self-hosted only, never distributed | §4.4 denylist keeps every install/update/foundation action out of the bridge; nothing in this document runs on a customer device |
| 2 | ERPClaw owns CRM | GW-1 starts in ERPClaw's CRM tables; Vitana members/tenants link by immutable external ID, one direction |
| 3 | One isolated ERP Postgres; per-tenant `ERPCLAW_DB_URL` routing from day one | every typed command carries `tenant_id`; the bridge resolves the DB and the ERPClaw `company_id` from tenant config, never from user text |
| 4 / 4b | new `vitana_role` `backoffice` at ladder position 5 | role gates the door only; §3 capabilities gate every action |
| 5 | `/backoffice/*`, wave 1 = cockpit + order-to-cash | §4 is scoped to the wave-1 sections; GW-2 actions are mapped but flagged wave 2 |
| 6 | owner approves each module; wave-1 allowlist = CRM only | §1.1 above; `install-module` disabled in production (§4.4) |
| 8 | UAE (Abu Dhabi) | §5; German items in the plan are void |
| 9 | external UAE payroll provider; ERPClaw HR holds people data; payroll lands as one Commit-tier journal with maker-checker | GW-4 step 6, §4.3 note on content-based tiering, §5 |
| 10 | Legal and Marketing wave 2 | placeholders only; no mapping here |

### 1.3 Tier definitions used throughout

The plan's four tiers, made precise enough to write a policy engine against:

| Tier | Definition | What the user sees | What the engine requires |
|---|---|---|---|
| **Read** | no ERP write | data, with source + as-of timestamp | `*.view` capability |
| **Draft** | creates or edits an **unposted** record (a lead, a task, a draft quotation, a draft journal). No GL entry, no document status change, reversible by edit or delete. | structured review card; the write happens when the user accepts the card | `*.draft` / `*.manage` capability; receipt |
| **Commit** | posts a document or GL entry, or changes a document's lifecycle status (submit, allocate, mark won/lost, promote to customer). Reversal exists but is itself a Commit or High-risk. | explicit confirmation naming the business outcome | capability at commit level; idempotency key; receipt; ERPClaw's `--user-confirmed` is passed by the bridge **only** for a command that reached this tier through policy |
| **High-risk** | money leaves the company, a posted document is reversed or cancelled, a receivable is forgiven, a period is closed or reopened, payroll is booked, master data that changes whose books get posted is created | request lands in Approvals; the requester cannot approve it | maker-checker: requester ≠ approver (no exception, including Exafy super-admins); approver holds the approve-level capability; MFA-backed session; **never confirmable by voice alone**; receipt for both the request and the approval |

Two rules that follow:

- **Vitana's tiers are at least as strict as ERPClaw's own gate.** Every
  action in ERPClaw's `DANGEROUS_ACTIONS` set (`scripts/db_query.py`,
  pinned commit) that the bridge exposes at all is Commit or High-risk
  here — never Draft or Read. The reverse is not true: many High-risk
  commands here (a supplier payment, a credit note) are plain
  transaction-class actions to ERPClaw.
- **Tier is a function of the command AND its payload**, not of the
  ERPClaw action alone. `submit-payment` is Commit for a customer receipt
  and High-risk for a supplier pay-out; `submit-journal-entry` is Commit
  for an accrual and High-risk when tagged `payroll` or above the
  amount threshold set in Approvals › Policies. §4.3 lists the payload
  attributes that escalate a tier.

---

## 2. Golden workflows

Each workflow names the **owner** (the person accountable for the process
running), the **approver** for its High-risk steps, the **exception path**,
the **accounting result** a finance owner can reconcile, and the
**acceptance test** the corresponding build VTID must pass on staging
against the isolated ERP database. Acceptance tests use AED amounts and
5% VAT because the jurisdiction is the UAE (decision 8).

Roles in the tables are Vitana roles/capabilities from §3. "Finance owner"
and "HR owner" are named people still to be assigned (§7).

### GW-1 — Order-to-cash: lead → opportunity → quotation → invoice → payment → P&L

**Owner:** Sales lead (capability `crm.manage` + `sales.draft`) for steps
1–4; Finance owner (`finance.approve`) for steps 5–7.
**Approver (High-risk steps):** none in the happy path — a customer
receipt is Commit. The reversal branch (GW-3) is High-risk.

| # | Step | Actor | Tier | Typed command | ERPClaw action(s) | Accounting result |
|---|---|---|---|---|---|---|
| 1 | Capture lead | sales (`crm.manage`) | Draft | `crm.lead.create` | `add-lead` (+ `add-lead-source` once, config) | none |
| 2 | Qualify → opportunity | sales | Commit | `crm.lead.convert` | `convert-lead-to-opportunity` | none |
| 3 | Work the pipeline | sales | Draft | `crm.opportunity.update`, `crm.opportunity.set_stage`, `crm.task.*` | `update-opportunity`, `set-opportunity-pipeline-stage`, `add-crm-task` … | none |
| 4 | Quote | sales (`sales.draft`) | Draft | `sales.quotation.create` | `convert-opportunity-to-quotation` or `add-quotation` | none |
| 5 | Send quote | sales (`sales.commit`) | Commit | `sales.quotation.submit` | `submit-quotation` (ERPClaw-gated) | none (quotation is not a GL document) |
| 6 | Won → customer master | sales (`sales.commit`) | Commit | `crm.opportunity.mark_won`, `crm.contact.promote_to_customer` | `mark-opportunity-won`, `promote-contact-to-customer` (or `add-customer`) | none |
| 7 | Invoice | finance or sales (`sales.draft` then `sales.commit`) | Draft → Commit | `sales.invoice.create` → `sales.invoice.submit` | `create-sales-invoice` → `submit-sales-invoice` (ERPClaw-gated) | Dr AR 10,500 / Cr Revenue 10,000 / Cr VAT output 500 |
| 8 | Receipt | finance (`finance.approve`) | Commit | `finance.payment.record` → `finance.payment.submit` (kind: `receive`) | `add-payment` → `submit-payment` (ERPClaw-gated), allocation to the invoice inside the same command | Dr Bank 10,500 / Cr AR 10,500 |
| 9 | Report | anyone with `reports.view` | Read | `reports.pnl`, `reports.ar_aging` | `profit-and-loss`, `ar-aging`, `party-ledger` | P&L revenue 10,000; AR aging shows 0 for the customer; VAT output balance 500 |

**Entity resolution rule (all steps):** the ERPClaw `company_id` comes
from tenant configuration, never from the payload. Customers and contacts
are selected in the UI by immutable ID; a name in free text (Operator chat,
ORB) resolves by **exact match only** — the orchestrator mirrors
`SKILL.md`'s rule and refuses to guess, autocorrect or pick the nearest
match, returning the available names instead.

**Exception path:**
- Lead is a duplicate → `crm.contact.merge` (Commit, `crm.manage`), never
  a silent skip; the receipt records which record survived.
- Customer disputes the invoice before payment → GW-3 credit note; the
  posted invoice is never edited.
- Short payment → one `finance.payment.record` with a `deductions` block
  (write-off / early-payment discount), never a payment plus a separate
  write-off — this mirrors `add-payment --deductions` exactly. A residual
  the customer will never pay with no cash movement is
  `finance.invoice.write_off` (High-risk).
- Customer over credit limit at step 7 → `sales.customer.check_credit`
  (Read) blocks submit; override is `sales.customer.hold_release`
  (Commit, `finance.approve`).

**Acceptance test (staging, isolated ERP DB, one seeded tenant company with
AED base currency and the `uae_ifrs` chart):**
1. Steps 1–8 execute through `POST /api/v1/backoffice/commands` only; no
   step calls `db_query.py` outside the bridge (assert via the bridge's
   receipt log: 9 receipts, one per step, each with `idempotency_key`).
2. Replaying step 7's `sales.invoice.submit` with the same
   `idempotency_key` returns the original receipt and creates no second
   invoice (`list-sales-invoices` count unchanged).
3. After step 8, `party-ledger` for the customer nets to 0.00 and
   `ar-aging` lists nothing outstanding for them.
4. `profit-and-loss` for the period shows revenue 10,000.00; VAT output
   account balance 500.00; `check-gl-integrity` passes.
5. Every receipt names the human actor, tenant, command type, tier,
   ERPClaw action and ERPClaw voucher ID.
6. The same nine steps issued by a `staff` user with no capabilities are
   rejected with `403` at the gateway (not at the bridge) and produce no
   ERP write.

### GW-2 — Procure-to-pay: supplier → PO → receipt → supplier invoice → payment

**Owner:** Operations lead (`ops.manage`, `ops.commit`) for steps 1–4;
Finance owner for step 5.
**Approver:** step 5 (money out) is High-risk — approver holds
`finance.pay` and is not the requester.
**Wave:** the actions are mapped now (§4.2) because the golden workflow
must be designed end to end; the Operations screens are wave 2 (decision
5). Until then step 1–4 run only via the command endpoint on staging.

| # | Step | Actor | Tier | Typed command | ERPClaw action(s) | Accounting result |
|---|---|---|---|---|---|---|
| 1 | Supplier master | ops (`ops.manage`) | Draft | `ops.supplier.create` | `add-supplier` | none |
| 2 | Purchase order | ops | Draft → Commit | `ops.po.create` → `ops.po.submit` | `add-purchase-order` → `submit-purchase-order` (ERPClaw-gated) | none (commitment, not a GL document) |
| 3 | Goods/service receipt | ops (`ops.commit`) | Commit | `ops.receipt.create` → `ops.receipt.submit` | `create-purchase-receipt` → `submit-purchase-receipt` (ERPClaw-gated) | stock items: Dr Inventory / Cr GRNI; services: no entry until invoice |
| 4 | Supplier invoice | finance (`accounting.post`) | Draft → Commit | `ops.supplier_invoice.create` → `ops.supplier_invoice.submit` | `create-purchase-invoice` → `submit-purchase-invoice` (ERPClaw-gated) | Dr Expense/GRNI 1,000 (EUR at day rate) / Cr AP; reverse charge on an imported service: Dr VAT input 5% and Cr VAT output 5% in the same voucher |
| 5 | Pay supplier | finance requester (`finance.view`+`accounting.post`) → approver (`finance.pay`) | **High-risk** | `finance.payment.record` → `finance.payment.submit` (kind: `pay`) | `add-payment` → `submit-payment` (ERPClaw-gated), executed by the bridge **only after** the approval record exists | Dr AP / Cr Bank at payment-date rate; FX difference to realised gain/loss |
| 6 | Report | `reports.view` | Read | `reports.ap_aging`, `reports.party_ledger` | `ap-aging`, `party-ledger` | AP aging shows 0 for the supplier |

**Exception path:**
- Receipt quantity ≠ PO quantity → ERPClaw's receipt tolerance /
  three-way-match policy decides; an over-tolerance receipt is rejected at
  step 3 and the exception is a `ops.po.amend` (Draft → Commit) with a
  receipt, never a manual GRNI journal.
- Supplier invoice arrives before the receipt (services) → step 3 is
  skipped; the invoice posts directly to expense.
- Wrong supplier paid → GW-3 payment cancellation (High-risk) plus a
  fresh payment; the cancelled payment stays visible.
- Payment file / bank transfer is **outside** ERPClaw in wave 1 — the
  approved `finance.payment.submit` records the payment; the actual
  transfer is executed by the finance owner in the bank portal and the
  bank-rec step (GW-4) proves it happened. `generate-nacha-file` is a US
  ACH format and is never exposed (§4.4).

**Acceptance test:**
1. Steps 1–4 for a EUR supplier invoice of 1,000.00 with reverse-charge
   VAT produce, on `submit-purchase-invoice`, a voucher whose GL legs
   include both a VAT-input debit and a VAT-output credit of equal amount
   at 5% of the AED-converted net; the net VAT effect of the voucher is
   0.00 and both legs appear in `tax-summary`. (This is the UAE
   reverse-charge proof §5 requires; if ERPClaw cannot express it as a
   template, VTID-E records that as a finding, not a workaround.)
2. Step 5 submitted by user A (`accounting.post`, no `finance.pay`) lands
   in `awaiting_approval`; user A's own approve call is rejected with the
   no-self-approval error; user B (`finance.pay`) approves; only then does
   a `submit-payment` receipt exist.
3. An approve call by voice/ORB for the same request is rejected
   regardless of who speaks (the command endpoint's `channel` attribute
   is `voice`).
4. `ap-aging` after step 5 shows 0.00 for the supplier; a realised FX
   gain/loss line exists if the rate moved between steps 4 and 5.

### GW-3 — Refund, credit note and reversal

**Owner:** Finance owner. **Approver:** every step below is High-risk;
approver holds `finance.approve` (credit note, cancellation) or
`finance.pay` (refund pay-out) and is never the requester.

| # | Case | Tier | Typed command | ERPClaw action(s) | Accounting result |
|---|---|---|---|---|---|
| A | Partial credit against a posted sales invoice (customer keeps the goods/service, price reduced) | Draft → **High-risk** | `sales.credit_note.create` → `sales.credit_note.submit` | `create-credit-note` → the credit note's own submit (the exact ERPClaw submit action for a credit note is pinned in VTID-E's action-contract discovery; SKILL.md lists `create-credit-note` under Invoicing) | Dr Revenue 2,000 / Dr VAT output 100 / Cr AR 2,100; original invoice untouched, its outstanding reduced |
| B | Refund cash to the customer for a credit note already applied | Draft → **High-risk** | `finance.payment.record` → `finance.payment.submit` (kind: `pay`, party: customer) | `add-payment` → `submit-payment` | Dr AR (clears the credit) / Cr Bank |
| C | Full reversal of a posted sales invoice issued in error (nothing delivered) | **High-risk** | `sales.invoice.cancel` | `cancel-sales-invoice` (ERPClaw-gated) | reversing GL entries under the same voucher; original stays visible with status cancelled |
| D | Reversal of a posted payment (wrong party / wrong amount) | **High-risk** | `finance.payment.cancel` | `cancel-payment` (ERPClaw-gated) | reversing legs; invoice outstanding restored |
| E | Reversal of a posted journal | **High-risk** | `accounting.journal.cancel` | `cancel-journal-entry` (ERPClaw-gated) | reversing legs; amended re-entry is a new Draft via `amend-journal-entry` |
| F | Bad-debt write-off, no cash | **High-risk** | `finance.invoice.write_off` | `write-off-invoice` (ERPClaw-gated) | Dr Bad-debt expense / Cr AR |

**Rule:** a posted document is **never edited**; the only corrections are
a credit/debit note or a cancellation, both audited, both High-risk. The
receipt for every case links the correcting voucher to the original.

**Exception path:**
- Credit note larger than the invoice outstanding → rejected at policy
  check (payload validation), not at ERPClaw.
- Reversal requested in a closed period → rejected; the correcting entry
  is dated in the open period (ERPClaw's `write-off-invoice` posting-date
  rule is the model: dated by the decision, not the original).
- Refund without a credit note → rejected: case B requires an applied
  credit note reference in the payload.

**Acceptance test:**
1. Run GW-1 to completion, then case A for 2,000 + 100 VAT: revenue for
   the period becomes 8,000.00, VAT output 400.00, the invoice's
   outstanding is 0.00 and the customer's party ledger shows a 2,100
   credit balance.
2. Case B refunds 2,100: bank decreases by 2,100, party ledger nets to
   0.00, `ar-aging` shows nothing.
3. Every request in 1–2 by user A is `awaiting_approval`; A cannot
   approve; B approves; the independent audit log has request, approval
   and execution as three separate events with three actors/timestamps.
4. Case C on a fresh invoice: `list-gl-entries` shows the original and
   the reversing legs both present; `check-gl-integrity` passes; the
   invoice list still shows the cancelled document.
5. Attempting case A by voice → rejected before policy evaluation.

### GW-4 — Month-end reconciliation and close

**Owner:** Finance owner (`finance.reconcile`, `accounting.close`).
**Approver:** period close is High-risk; approver is a second holder of
`accounting.close` (in a one-finance-person tenant the tenant admin holds
it as approver-only — see §3.3 note on minimum staffing).

| # | Step | Tier | Typed command | ERPClaw action(s) | Accounting result |
|---|---|---|---|---|---|
| 1 | Bank reconciliation | Commit (`finance.reconcile`) | `finance.bank.reconcile` | `bank-reconciliation`, `reconcile-payments`, `get-unallocated-payments`, `allocate-payment` | every bank movement matched to a payment or an explaining journal |
| 2 | Unallocated receipts / advances cleared | Commit | `finance.payment.allocate` | `allocate-payment` / `apply-advance-to-invoice` | no unallocated payments older than the period |
| 3 | Recurring and accrual journals | Draft → Commit (`accounting.post`) | `accounting.journal.create` → `accounting.journal.submit` | `add-journal-entry` → `submit-journal-entry` | accruals posted, tagged with `department` dimension where applicable |
| 4 | FX revaluation of open foreign balances | **High-risk** (`accounting.close`) | `accounting.fx.revalue` | `revalue-foreign-balances` | unrealised gain/loss posted |
| 5 | Payroll journal (from the external provider's output) | **High-risk** (payload tag `payroll` escalates; approver `payroll.approve`) | `accounting.journal.create` → `accounting.journal.submit` | `add-journal-entry` → `submit-journal-entry` | salaries, WPS transfer, gratuity accrual and GPSSA booked as one balanced voucher |
| 6 | Pre-close validation | Read | `accounting.period.validate` | `validate-period-close`, `check-gl-integrity`, `trial-balance` | zero blockers: no draft documents dated in the period, trial balance balanced, no unreconciled bank lines |
| 7 | Close | **High-risk** (`accounting.close`) | `accounting.period.close` | `close-fiscal-year` (period granularity as ERPClaw supports it — VTID-E confirms whether monthly close is a period lock or a fiscal-year action) | period locked; postings dated inside it are rejected |
| 8 | Reports | Read | `reports.trial_balance`, `reports.pnl`, `reports.balance_sheet`, `reports.tax_summary` | `trial-balance`, `profit-and-loss`, `balance-sheet`, `tax-summary` | the month's pack; `tax-summary` is the input to the FTA return (§5) |

**Exception path:**
- Step 6 reports blockers → close is refused by policy; the blockers are
  listed in the Approvals request as the reason; nobody can approve past
  them.
- A correction is needed after close → `accounting.period.reopen`
  (High-risk, `accounting.close`, second approver), the correction, then
  a fresh close; both reopen and re-close are receipts.
- `revalue-foreign-balances` finds nothing → step 4 is a no-op receipt,
  not skipped silently.

**Acceptance test:**
1. Run GW-1, GW-2 and GW-3 in one period, then steps 1–8.
2. Step 6 with one deliberately unposted draft invoice dated in the period
   returns a blocker naming it; the close request is refused.
3. After posting or deleting that draft, step 7 lands in
   `awaiting_approval`, is approved by a second person, and a subsequent
   `sales.invoice.submit` dated inside the period is rejected by ERPClaw
   and surfaced as a policy error, not a 500.
4. `trial-balance` debits equal credits; `balance-sheet` balances; the
   sum of `tax-summary` output VAT minus input VAT equals the VAT
   liability account balance.
5. The whole GW-1 → GW-4 chain is reconciled by the named finance owner
   (§7 item 1) against ERPClaw's reports; **order-to-cash is not "done"
   until that person signs the reconciliation.**

---

## 3. Capability catalog and default grants

### 3.1 Catalog

Capabilities are per-tenant grants in `erp_capability_grants` (VTID-D),
issued through the gateway only. Naming is `<domain>.<level>`. The gateway
enforces; the UI only hides.

| Capability | Grants | Tier ceiling |
|---|---|---|
| `crm.view` | read leads, contacts, companies, opportunities, tasks, activities, pipeline report | Read |
| `crm.manage` | create/edit the above, convert lead, set stage, mark won/lost, merge contacts, promote to customer, pipeline config | Commit |
| `sales.view` | read customers, quotations, invoices, credit notes, sales orders | Read |
| `sales.draft` | create/edit draft quotations, invoices, credit notes, customers | Draft |
| `sales.commit` | submit quotations and invoices; put customer on hold | Commit |
| `finance.view` | read payments, outstanding, unallocated, bank rec state, FX rates | Read |
| `finance.approve` | record and submit customer receipts, allocate payments, approve credit notes and invoice cancellations | Commit (+ approver for High-risk credit/cancel) |
| `finance.pay` | approve money-out: supplier payments, refunds, payment cancellations, write-offs | High-risk approver |
| `finance.reconcile` | bank reconciliation, payment reconciliation | Commit |
| `accounting.view` | read journals, CoA, balances, GL entries, fiscal years, dimensions | Read |
| `accounting.post` | create and submit journals; supplier invoices; add exchange rates | Commit |
| `accounting.configure` | CoA accounts, dimensions, cost centres, fiscal years, tax templates/rules/categories, payment terms | Commit |
| `accounting.close` | FX revaluation, period close/reopen, opening balances, CoA import | High-risk approver |
| `reports.view` | every financial report | Read |
| `audit.view` | command receipts, independent audit log, ERPClaw audit log | Read |
| `approvals.policy` | edit tier rules, thresholds, maker-checker settings | Commit (policy edits are themselves receipts) |
| `ops.view` / `ops.manage` / `ops.commit` | suppliers, POs, receipts, items, warehouses, stock (wave 2) | Read / Draft / Commit |
| `hr.view` / `hr.manage` / `hr.approve` | employees, documents, leave, attendance, expense claims (wave 2) | Read / Draft / Commit |
| `payroll.view` / `payroll.approve` | payroll journal visibility; approver of the monthly payroll journal (wave 3) | Read / High-risk approver |
| `marketing.view` / `marketing.manage` | attribution read model; campaign links (wave 2) | Read / Draft |
| `legal.view` / `legal.manage` / `legal.sign` | contracts register, obligations (wave 2/3) | Read / Draft / Commit |
| `erp.admin` | company & legal-entity settings, regional settings, CoA template load, module list (read), bridge health; grant/revoke capabilities (also requires tenant `admin` role or Exafy super-admin) | High-risk for company creation, Commit otherwise |

Approving is **not** a capability of its own: to approve a High-risk
request the approver needs the request's approve-level capability
(`finance.pay`, `finance.approve`, `accounting.close`, `payroll.approve`,
`hr.approve`) **and** must not be the requester. `approvals.policy` edits
the rules; it never approves.

### 3.2 Default grants per role

Granted automatically when the role is granted (VTID-B/VTID-D); anything
else is an explicit per-user grant by a tenant admin through BackOffice ›
Settings › Access.

| Vitana role | Enters `/backoffice`? | Default capabilities | Never by default |
|---|---|---|---|
| `backoffice` (new, ladder 5) | yes — this is its home | none. The role opens the door; a tenant admin grants the person's actual function (e.g. a salesperson: `crm.view`, `crm.manage`, `sales.view`, `sales.draft`; a bookkeeper: `finance.view`, `finance.reconcile`, `accounting.view`, `accounting.post`, `reports.view`) | — |
| `admin` (tenant admin, ladder 6) | yes | all `*.view`, `crm.manage`, `sales.draft`, `sales.commit`, `finance.approve`, `finance.reconcile`, `accounting.post`, `accounting.configure`, `reports.view`, `audit.view`, `approvals.policy`, `erp.admin` | `finance.pay`, `accounting.close`, `hr.*`, `payroll.*` — money-out, period close and personal data are explicit grants, never inherited with the admin role |
| `staff` (ladder 4) | **no** — below `backoffice`; a staff member who needs BackOffice is granted the `backoffice` role | none | everything |
| `developer`, `infra` (ladder 7, 8) | yes | `*.view` (troubleshooting) + `audit.view` | any draft/commit/approve/pay/post/close — platform roles never post a tenant's books |
| Exafy super-admin | yes, cross-tenant via the existing tenant switcher | everything | nothing — but still bound by requester ≠ approver, and every action is a receipt in that tenant's audit log |
| `professional`, `patient`, `community` | no | — | — |

### 3.3 Separation-of-duties rules the engine enforces

1. **Requester ≠ approver**, for every High-risk command, for everyone.
2. **Minimum staffing:** a tenant needs at least two distinct people
   holding an approve-level capability before any High-risk command can
   complete; otherwise the request queues with reason
   `no_eligible_approver` and Settings › Access shows the gap. This is
   the honest alternative to letting one person self-approve in a small
   tenant.
3. **`hr.*` and `payroll.*` are never bundled** with `finance.*` or with
   the `admin` role's defaults (personal data under UAE PDPL and the
   GDPR-equivalent standard the plan already applied).
4. **Voice channel ceiling is Draft.** Commit requires an authenticated
   desktop confirmation; High-risk requires the Approvals screen.
5. **`developer`/`infra` ceiling is Read**, enforced at the gateway, not
   by convention.

---

## 4. Wave-1 mapping: ERPClaw action → typed command → tier

### 4.1 Conventions

- Typed command names are `<domain>.<entity>.<verb>`; the payload is a
  validated JSON object per command type; every call carries
  `tenant_id`, `idempotency_key`, `channel` (`web` | `chat` | `voice`),
  and returns `{command_id, tier, status: executed | awaiting_approval |
  rejected, receipt}` (plan B5).
- "ERPClaw-gated" marks an action in the pinned `DANGEROUS_ACTIONS` set:
  the bridge appends `--user-confirmed` for those and only those, and
  only for a command that policy has already admitted at Commit or
  High-risk tier. The flag is **never** model-selected and never a
  payload field.
- Every `list-*`/`get-*`/report action is invoked with explicit
  `--company-id` from tenant config; no action ever receives free-text
  company names.
- **Wave** = which BackOffice section/screen exposes it. `1` ships in the
  wave-1 screens; `1-api` is callable through the command endpoint and the
  Operator chat in wave 1 but has no dedicated screen yet; `2` is mapped
  for completeness of GW-2 and setup but stays behind the placeholder.

### 4.2 The mapping

**Overview / Health / Audit (Vitana-owned screens; ERPClaw supplies status only)**

| ERPClaw action | Typed command | Tier | Capability | Wave |
|---|---|---|---|---|
| `status`, `check-installation`, `get-schema-version`, `list-modules`, `module-status` | `erp.health.read` | Read | `erp.admin` or `audit.view` | 1 |
| `get-audit-log` | `audit.erp_log.read` | Read | `audit.view` | 1 |
| `check-gl-integrity` | `accounting.gl.integrity_check` | Read | `accounting.view` | 1 |

**Sales & CRM — CRM domain of `erpclaw-growth` (the only module actions allowlisted)**

| ERPClaw action | Typed command | Tier | Capability | Wave |
|---|---|---|---|---|
| `list-leads`, `get-lead`, `list-lead-sources` | `crm.lead.list`, `crm.lead.get`, `crm.lead_source.list` | Read | `crm.view` | 1 |
| `add-lead`, `update-lead` | `crm.lead.create`, `crm.lead.update` | Draft | `crm.manage` | 1 |
| `add-lead-source` | `crm.lead_source.create` | Draft | `crm.manage` | 1 |
| `convert-lead-to-opportunity` | `crm.lead.convert` | Commit | `crm.manage` | 1 |
| `list-crm-contacts`, `get-crm-contact`, `list-crm-companies`, `get-crm-company` | `crm.contact.list/get`, `crm.company.list/get` | Read | `crm.view` | 1 |
| `add-crm-contact`, `update-crm-contact`, `add-crm-company`, `update-crm-company`, `link-contact-to-company` | `crm.contact.create/update`, `crm.company.create/update`, `crm.contact.link_company` | Draft | `crm.manage` | 1 |
| `merge-crm-contacts` | `crm.contact.merge` | Commit | `crm.manage` | 1 |
| `remove-crm-contact` | `crm.contact.remove` | Commit | `crm.manage` | 1 |
| `promote-contact-to-customer` | `crm.contact.promote_to_customer` | Commit | `crm.manage` + `sales.draft` | 1 |
| `list-opportunities`, `get-opportunity`, `pipeline-report` | `crm.opportunity.list/get`, `crm.pipeline.report` | Read | `crm.view` | 1 |
| `add-opportunity`, `update-opportunity`, `set-opportunity-pipeline-stage` | `crm.opportunity.create/update/set_stage` | Draft | `crm.manage` | 1 |
| `mark-opportunity-won`, `mark-opportunity-lost` | `crm.opportunity.mark_won/mark_lost` | Commit | `crm.manage` | 1 |
| `convert-opportunity-to-quotation` | `crm.opportunity.convert_to_quotation` | Draft (creates a draft quotation) | `crm.manage` + `sales.draft` | 1 |
| `list-crm-pipelines`, `list-crm-pipeline-stages` | `crm.pipeline.list`, `crm.pipeline_stage.list` | Read | `crm.view` | 1 |
| `add-crm-pipeline`, `add-crm-pipeline-stage`, `update-crm-pipeline-stage` | `crm.pipeline.create`, `crm.pipeline_stage.create/update` | Commit (config) | `crm.manage` | 1-api |
| `list-crm-tasks`, `get-crm-task`, `list-activities` | `crm.task.list/get`, `crm.activity.list` | Read | `crm.view` | 1 (Follow-ups tab) |
| `add-crm-task`, `update-crm-task`, `complete-crm-task`, `cancel-crm-task`, `link-task-to-entity`, `unlink-task-from-entity`, `add-activity` | `crm.task.create/update/complete/cancel/link/unlink`, `crm.activity.create` | Draft | `crm.manage` | 1 |
| saved views, global search, CSV import/export | — | — | not mapped; wave 2 if a user asks | 2 |
| `add-campaign`, `list-campaigns` | — | — | Marketing is wave 2 (decision 10) | 2 |

**Sales & CRM — Selling (core)**

| ERPClaw action | Typed command | Tier | Capability | Wave |
|---|---|---|---|---|
| `list-customers`, `get-customer` | `sales.customer.list/get` | Read | `sales.view` | 1 |
| `add-customer`, `update-customer` | `sales.customer.create/update` | Draft | `sales.draft` | 1 |
| `check-credit-limit` | `sales.customer.check_credit` | Read | `sales.view` | 1 |
| `place-customer-on-hold` | `sales.customer.hold_release` | Commit | `finance.approve` | 1-api |
| `list-quotations`, `get-quotation` | `sales.quotation.list/get` | Read | `sales.view` | 1 |
| `add-quotation`, `update-quotation` | `sales.quotation.create/update` | Draft | `sales.draft` | 1 |
| `submit-quotation` (ERPClaw-gated) | `sales.quotation.submit` | Commit | `sales.commit` | 1 |
| `convert-quotation-to-so`, sales orders, blanket orders, deliveries, packing slips | — | — | wave 2 (decision 5 lists Quotes, Invoices, Credit Notes for wave 1). In wave 1 the invoice command carries the quotation reference; how the bridge materialises the lines (an ERPClaw flag vs. a line copy) is pinned in VTID-E's action-contract discovery | 2 |
| `list-sales-invoices`, `get-sales-invoice` | `sales.invoice.list/get` | Read | `sales.view` | 1 |
| `create-sales-invoice`, `update-sales-invoice` | `sales.invoice.create/update` | Draft | `sales.draft` | 1 |
| `submit-sales-invoice` (ERPClaw-gated) | `sales.invoice.submit` | Commit | `sales.commit` | 1 |
| `cancel-sales-invoice` (ERPClaw-gated) | `sales.invoice.cancel` | **High-risk** | requester `sales.commit`; approver `finance.approve` | 1 |
| `list-credit-notes` | `sales.credit_note.list` | Read | `sales.view` | 1 |
| `create-credit-note` | `sales.credit_note.create` | Draft | `sales.draft` | 1 |
| credit-note submit (exact action pinned in VTID-E; see GW-3 A) | `sales.credit_note.submit` | **High-risk** | requester `sales.commit`; approver `finance.approve` | 1 |
| `update-invoice-outstanding`, `update-purchase-outstanding` | — | — | **bridge-internal only**; never a user command | — |
| `check-overdue` | `sales.invoice.overdue` | Read | `sales.view` | 1 |
| dunning, recurring invoices, intercompany, sales partners | — | — | wave 2 | 2 |

**Finance & Treasury — Payments (core)**

| ERPClaw action | Typed command | Tier | Capability | Wave |
|---|---|---|---|---|
| `list-payments`, `get-payment`, `get-outstanding`, `get-unallocated-payments`, `list-open-advances`, `payment-summary` | `finance.payment.list/get`, `finance.outstanding.read`, `finance.unallocated.read`, `finance.payment.summary` | Read | `finance.view` | 1 |
| `add-payment`, `update-payment` | `finance.payment.record` (`kind: receive \| pay`, optional `deductions[]`) | Draft | `finance.approve` (receive) / `accounting.post` (pay) | 1 |
| `submit-payment` (ERPClaw-gated), `kind: receive` | `finance.payment.submit` | Commit | `finance.approve` | 1 |
| `submit-payment` (ERPClaw-gated), `kind: pay` | `finance.payment.submit` | **High-risk** | requester `accounting.post`; approver `finance.pay` | 1 |
| `cancel-payment` (ERPClaw-gated) | `finance.payment.cancel` | **High-risk** | approver `finance.pay` | 1 |
| `delete-payment` (ERPClaw-gated) | `finance.payment.delete` (draft payments only) | Commit | `finance.approve` | 1-api |
| `allocate-payment`, `apply-advance-to-invoice` | `finance.payment.allocate` | Commit | `finance.approve` | 1 |
| `reconcile-payments`, `bank-reconciliation` | `finance.bank.reconcile` | Commit | `finance.reconcile` | 1 |
| `write-off-invoice` (ERPClaw-gated) | `finance.invoice.write_off` | **High-risk** | approver `finance.pay` | 1-api |
| `create-payment-ledger-entry` | — | — | bridge-internal / not exposed | — |
| `list-currencies`, `list-exchange-rates`, `get-exchange-rate` | `finance.fx.list`, `finance.fx.get` | Read | `finance.view` | 1 |
| `add-currency`, `add-exchange-rate` | `finance.fx.add_currency`, `finance.fx.set_rate` | Commit | `accounting.post` | 1-api |
| `fetch-exchange-rates` | `finance.fx.fetch` | Commit | `accounting.post` (also runnable by the bridge's own scheduler as the service principal) | 1-api — **explicitly allowlisted**: the one outbound network call the bridge permits, with egress restricted to that API's host |

**Accounting — Journals, CoA, Periods (core)**

| ERPClaw action | Typed command | Tier | Capability | Wave |
|---|---|---|---|---|
| `list-journal-entries`, `get-journal-entry` | `accounting.journal.list/get` | Read | `accounting.view` | 1 |
| `add-journal-entry`, `update-journal-entry`, `duplicate-journal-entry`, `amend-journal-entry` | `accounting.journal.create/update/duplicate/amend` (dimension tags in payload) | Draft | `accounting.post` | 1 |
| `submit-journal-entry` (ERPClaw-gated) | `accounting.journal.submit` | Commit; **High-risk** when payload `tags` contains `payroll` or amount ≥ policy threshold | `accounting.post`; escalated approver `payroll.approve` / `accounting.close` | 1 |
| `cancel-journal-entry` (ERPClaw-gated) | `accounting.journal.cancel` | **High-risk** | approver `accounting.close` | 1 |
| `delete-journal-entry` (ERPClaw-gated) | `accounting.journal.delete` (drafts only) | Commit | `accounting.post` | 1-api |
| `create-intercompany-je`, recurring templates, `process-recurring` | — | — | wave 2 | 2 |
| `list-accounts`, `get-account`, `get-account-balance` | `accounting.coa.list/get`, `accounting.account.balance` | Read | `accounting.view` | 1 |
| `add-account`, `update-account` | `accounting.coa.add_account/update_account` | Commit | `accounting.configure` | 1 |
| `freeze-account`, `unfreeze-account` (ERPClaw-gated) | `accounting.coa.freeze/unfreeze` | Commit | `accounting.configure` | 1-api |
| `setup-chart-of-accounts`, `import-chart-of-accounts`, `import-opening-balances` | `accounting.coa.load_template`, `accounting.coa.import`, `accounting.opening_balances.import` | **High-risk** | requester `erp.admin`; approver `accounting.close` | 1-api (setup) |
| `list-fiscal-years`, `validate-period-close` | `accounting.period.list`, `accounting.period.validate` | Read | `accounting.view` | 1 |
| `add-fiscal-year` | `accounting.period.create` | Commit | `accounting.configure` | 1 |
| `close-fiscal-year`, `reopen-fiscal-year` (ERPClaw-gated) | `accounting.period.close/reopen` | **High-risk** | approver `accounting.close` | 1 |
| `revalue-foreign-balances` | `accounting.fx.revalue` | **High-risk** | approver `accounting.close` | 1 |
| `list-gl-entries`, `general-ledger` | `accounting.gl.list` | Read | `accounting.view` | 1 |
| `post-gl-entries`, `reverse-gl-entries` (ERPClaw-gated) | — | — | **never exposed** — documents post their own GL; raw GL posting bypasses every document-level control | — |
| `list-dimensions`, `list-cost-centers`, `list-budgets` | `accounting.dimension.list`, `accounting.cost_center.list`, `accounting.budget.list` | Read | `accounting.view` | 1-api |
| `add-dimension`, `update-dimension`, `deactivate-dimension`, `add-cost-center` | `accounting.dimension.create/update/deactivate`, `accounting.cost_center.create` | Commit | `accounting.configure` | 1-api |
| `seed-naming-series`, `next-series` | — | — | bridge-internal (numbering is Settings › Numbering, wave 2) | — |
| `list-tax-templates`, `get-tax-template`, `list-tax-categories`, `list-tax-rules`, `resolve-tax-template`, `calculate-tax` | `accounting.tax.template.list/get`, `accounting.tax.category.list`, `accounting.tax.rule.list`, `accounting.tax.resolve`, `accounting.tax.calculate` | Read | `accounting.view` | 1-api |
| `add-tax-template`, `update-tax-template`, `add-tax-category`, `add-tax-rule`, `add-item-tax-template` | `accounting.tax.template.create/update`, `accounting.tax.category.create`, `accounting.tax.rule.create`, `accounting.tax.item_template.create` | Commit | `accounting.configure` | 1-api (VAT setup) |
| `delete-tax-template` (ERPClaw-gated) | `accounting.tax.template.delete` | Commit | `accounting.configure` | 1-api |
| withholding / 1099 actions | — | — | US-specific; never exposed | — |

**Reports (core)**

| ERPClaw action | Typed command | Tier | Capability | Wave |
|---|---|---|---|---|
| `profit-and-loss`, `comparative-pl` | `reports.pnl` (with optional `group_by` dimension) | Read | `reports.view` | 1 |
| `ar-aging`, `ap-aging` | `reports.ar_aging`, `reports.ap_aging` | Read | `reports.view` | 1 |
| `trial-balance`, `balance-sheet`, `cash-flow`, `multi-dim-trial-balance`, `dimension-balance-report`, `gl-summary`, `party-ledger`, `tax-summary`, `payment-summary` | `reports.trial_balance`, `reports.balance_sheet`, `reports.cash_flow`, `reports.trial_balance_by_dimension`, `reports.dimension_balance`, `reports.gl_summary`, `reports.party_ledger`, `reports.tax_summary`, `reports.payment_summary` | Read | `reports.view` | 1-api (screens wave 2) |
| `budget-vs-actual`, `budget-variance` | `reports.budget_vs_actual` | Read | `reports.view` | 2 |
| elimination rules/runs | — | — | retired upstream ("do not call") | — |

**Settings › Company (core setup)**

| ERPClaw action | Typed command | Tier | Capability | Wave |
|---|---|---|---|---|
| `list-companies`, `get-company` | `settings.company.list/get` | Read | `erp.admin` or `accounting.view` | 1 |
| `setup-company` | `settings.company.create` | **High-risk** | requester `erp.admin`; approver a second `erp.admin` or Exafy super-admin | 1 |
| `update-company`, `update-regional-settings` | `settings.company.update`, `settings.company.regional` | Commit | `erp.admin` | 1 |
| `seed-defaults` | `settings.company.seed_defaults` (once, on creation, bridge-driven) | Commit | `erp.admin` | 1-api |
| `list-payment-terms`, `add-payment-terms`, `list-uoms`, `add-uom`, `add-uom-conversion` | `settings.payment_terms.list/create`, `settings.uom.list/create/convert` | Read / Commit | `accounting.configure` | 1-api |
| `add-account-type`, `list-account-types`, `add-voucher-type`, `list-voucher-types`, `validate-registry-completeness` | `settings.registry.*` | Read / Commit | `erp.admin` | 1-api |
| custom fields | — | — | wave 2 | 2 |

**Operations — Buying (core), mapped for GW-2, screens wave 2**

| ERPClaw action | Typed command | Tier | Capability | Wave |
|---|---|---|---|---|
| `list-suppliers`, `get-supplier` | `ops.supplier.list/get` | Read | `ops.view` | 2 |
| `add-supplier`, `update-supplier` | `ops.supplier.create/update` | Draft | `ops.manage` | 2 |
| `list-purchase-orders`, `get-purchase-order` | `ops.po.list/get` | Read | `ops.view` | 2 |
| `add-purchase-order`, `update-purchase-order` | `ops.po.create/update/amend` | Draft | `ops.manage` | 2 |
| `submit-purchase-order` (ERPClaw-gated) | `ops.po.submit` | Commit | `ops.commit` | 2 |
| `close-purchase-order` | `ops.po.close` | Commit | `ops.commit` | 2 |
| `cancel-purchase-order` (ERPClaw-gated) | `ops.po.cancel` | Commit (no GL) | `ops.commit` | 2 |
| `list-purchase-receipts`, `get-purchase-receipt` | `ops.receipt.list/get` | Read | `ops.view` | 2 |
| `create-purchase-receipt` | `ops.receipt.create` | Draft | `ops.manage` | 2 |
| `submit-purchase-receipt` (ERPClaw-gated) | `ops.receipt.submit` | Commit | `ops.commit` | 2 |
| `cancel-purchase-receipt` (ERPClaw-gated) | `ops.receipt.cancel` | **High-risk** | approver `accounting.close` | 2 |
| `list-purchase-invoices`, `get-purchase-invoice` | `ops.supplier_invoice.list/get` | Read | `finance.view` | 2 |
| `create-purchase-invoice`, `update-purchase-invoice` | `ops.supplier_invoice.create/update` | Draft | `accounting.post` | 2 |
| `submit-purchase-invoice` (ERPClaw-gated) | `ops.supplier_invoice.submit` | Commit | `accounting.post` | 2 |
| `cancel-purchase-invoice` (ERPClaw-gated) | `ops.supplier_invoice.cancel` | **High-risk** | approver `finance.approve` | 2 |
| `create-debit-note` | `ops.debit_note.create` | **High-risk** | approver `finance.approve` | 2 |
| `update-receipt-tolerance`, `update-three-way-match-policy` | `ops.policy.*` | Commit | `approvals.policy` | 2 |
| material requests, RFQs, blanket POs, drop-ship, landed cost, recurring bills, inventory | — | — | wave 2+, only with a named process owner | 2+ |

### 4.3 Payload attributes that escalate a tier

The policy engine evaluates these **before** any ERPClaw call:

| Attribute | Effect |
|---|---|
| `kind: pay` on `finance.payment.*` | Commit → High-risk (`finance.pay` approver) |
| `tags` contains `payroll` on `accounting.journal.submit` | Commit → High-risk (`payroll.approve` approver) |
| `amount` ≥ tenant threshold (Approvals › Policies; default AED 25,000 until the finance owner sets it) on any Commit command | Commit → High-risk (`finance.approve` or `accounting.close` per domain) |
| `posting_date` inside a closed period | rejected |
| `channel: voice` | ceiling Draft; Commit/High-risk rejected with `voice_not_permitted` |
| `channel: chat` | ceiling Commit; High-risk lands in the queue, is never confirmed in chat |
| requester = approver | rejected `self_approval_forbidden` |
| reference to a document the requester created (credit note against own invoice) | allowed, but the approver must differ — the engine records the chain |

### 4.4 Never exposed through the bridge (denylist, regardless of tier)

Denied by the bridge's allowlist by construction; listed so nobody adds
them later "for convenience":

- **Module and foundation lifecycle:** `install-module`, `remove-module`,
  `update-modules`, `available-modules`, `search-modules`,
  `update-foundation`, `rollback-foundation`, `verify-trust-root`,
  `schema-plan`, `schema-apply`, `schema-rollback`, `schema-drift`,
  `migrate`, `regenerate-skill-md`, `rebuild-action-cache`. Modules are
  vendored and pinned in the bridge image (decision 6); `migrate` runs
  from the deploy job as the service principal, never from a request.
- **Database lifecycle:** `initialize-database`, `restore-database`,
  `backup-database`, `list-backups`, `verify-backup`, `cleanup-backups`,
  `import-master-key-from-backup`. Backups are the bridge's scheduled job
  and the ERP Postgres's own snapshots (VTID-E backup/restore proof).
- **ERPClaw's own identity layer:** `add-user`, `update-user`, `get-user`,
  `list-users`, `set-password`, `add-role`, `list-roles`, `assign-role`,
  `revoke-role`, `seed-permissions`, `link-telegram-user`,
  `unlink-telegram-user`, `check-telegram-permission`. Vitana owns
  identity and capabilities; ERPClaw runs under one service principal per
  tenant DB and the receipt carries the Vitana actor.
- **Credentials:** `set-credential`, `get-credential`, `list-credentials`,
  `delete-credential`, `migrate-credentials`.
- **Raw GL:** `post-gl-entries`, `reverse-gl-entries`.
- **Retired upstream:** `create-stock-ledger-entries`,
  `reverse-stock-ledger-entries`, `add-elimination-rule`,
  `list-elimination-rules`, `run-elimination`, `list-elimination-entries`.
- **US-only payroll and tax:** every `*-fica-*`, `*-futa-suta-*`,
  `add-income-tax-slab`, `add-state-tax-slab`,
  `update-employee-state-config`, `generate-w2-data`,
  `generate-nacha-file`, `record-1099-payment`, `generate-1099-data`,
  `record-withholding-entry`, `add-tax-withholding-category`,
  `get-withholding-details`, `create-payroll-run`,
  `generate-salary-slips`, `submit-payroll-run`, `cancel-payroll-run`
  (decision 9: payroll is computed externally).
- **Demo / interactive helpers:** `seed-demo-data`, `tutorial`,
  `onboarding-step`, `install-guide`, `onboard`, `setup-web-dashboard`.
- **Anything in `erpclaw-growth` outside the CRM domain** (§1.1).

---

## 5. UAE (Abu Dhabi) compliance items

Owner column: a role or a named VTID where one exists; `UNASSIGNED`
where a person still has to be named (§7).

| # | Requirement | Approach | Owner | Wave / VTID |
|---|---|---|---|---|
| U1 | IFRS-style chart of accounts, AED base currency | Author `uae_ifrs.json` in the exact shape of `us_gaap.json` (94 rows; fields `account_number`, `name`, `parent_number`, `root_type`, `account_type`, `is_group`, `balance_direction`) and load it with `setup-chart-of-accounts --template uae_ifrs`. The loader is a plain `assets/charts/{template}.json` path lookup (§6.1), so the file is dropped into the vendored tree — a Vitana-owned config artefact, no ERPClaw code change | Finance owner (**UNASSIGNED**) signs the chart; engineering (VTID-E) proves the loader | VTID-E proof; sign-off before GW-1 acceptance |
| U2 | VAT 5%: standard, zero-rated, exempt, reverse charge on imported goods/services | ERPClaw core tax domain. Standard = template line `rate 5, add_deduct add`; zero-rated = line `rate 0`; exempt = party-level `exempt_from_sales_tax` or a tax rule with an exempt template; **reverse charge = one purchase template with two lines, `+5% add` to VAT output and `5% deduct` to VAT input, net 0**. All four are hypotheses from reading `erpclaw-tax/db_query.py` and must be proven with real vouchers (GW-2 acceptance test 1) | Engineering (VTID-E) proves; Finance owner (**UNASSIGNED**) confirms treatment | VTID-E |
| U3 | FTA VAT return (quarterly) | Vitana-owned Reports tab mapping `tax-summary` output to the FTA return boxes; filing stays manual by the accountant | Finance owner (**UNASSIGNED**) signs the box mapping | wave 2 |
| U4 | Corporate Tax 9% | Outside ERPClaw; annual, accountant-prepared from `profit-and-loss` / `balance-sheet` | External accountant | none |
| U5 | Payroll: WPS SIF via bank/exchange house; GPSSA for Emirati staff | External UAE payroll provider computes; ERPClaw HR holds employees/documents/leave/attendance/expense claims; the monthly payroll is one `accounting.journal.submit` tagged `payroll` (High-risk, `payroll.approve` approver ≠ requester) | HR owner (**UNASSIGNED**); provider (**UNASSIGNED**) | HR wave 2; payroll journal wave 3 |
| U6 | End-of-service gratuity | Provider computes; monthly accrual booked as a Draft → Commit journal tagged `payroll` | HR owner (**UNASSIGNED**) | wave 3 |
| U7 | Multi-currency: AED base, EUR/USD suppliers and customers | ERPClaw core multi-currency; `fetch-exchange-rates` allowlisted as the bridge's single outbound call, host-restricted; `revalue-foreign-balances` High-risk at month-end (GW-4 step 4) | Engineering (VTID-E) | wave 1 |
| U8 | Records retention and audit | ERPClaw immutable GL + Vitana independent audit log + receipts; the FTA retention period is an obligation entry in Legal & Compliance once that section exists | Finance owner (**UNASSIGNED**) for the policy; engineering for the log | wave 1 (log), wave 2 (obligation entry) |
| U9 | Personal data of employees (UAE PDPL) | `hr.*`/`payroll.*` never bundled into `admin` defaults; HR data lives in ERPClaw's HR tables in the isolated ERP DB; access is a capability grant with receipts | HR owner (**UNASSIGNED**) | wave 2 |

---

## 6. Findings from the pinned code that VTID-E must prove, not assume

6.1 **CoA template loader accepts a non-shipped template name.** In
`scripts/erpclaw-gl/db_query.py` (lines 201–203 at the pinned commit) the
template resolves as `os.path.join(CHARTS_DIR, f"{template}.json")` with
an existence check and no allowlist. So `uae_ifrs.json` placed in the
vendored `assets/charts/` directory should load without an upstream
change. VTID-E proves it by loading a `uae_ifrs.json` and listing the
resulting accounts. If the vendoring step ever pins `CHARTS_DIR`
elsewhere, this breaks silently — the spike records the resolved path.

6.2 **Reverse charge has no first-class concept in ERPClaw's tax domain.**
`tax_template_line` carries `rate`, `charge_type`, `add_deduct`
(`add`/`deduct`) and `included_in_print_rate`; `tax_type` is
`sales`/`purchase`/`both`; party exemption is a boolean
(`exempt_from_sales_tax`). Reverse charge is therefore modelled as the
two-line template in U2. Whether `calculate-tax` and
`submit-purchase-invoice` post both legs as separate GL lines to the two
VAT accounts (required for `tax-summary` to show them) is exactly what
GW-2 acceptance test 1 checks.

6.3 **`DANGEROUS_ACTIONS` is the only ERPClaw-side gate**, and it is a
per-invocation CLI flag, not a permission. The bridge must never pass
`--user-confirmed` from a payload field, an environment default, or a
model-selected argument; it is appended by the bridge after policy
admission, for the actions in §4.2 marked ERPClaw-gated. VTID-E's
security review covers argument construction (`shlex`-safe argv, no
shell), secrets (the ERP DB URL never in argv), and subprocess isolation.

6.4 **The CRM module's "confirm before" list is agent guidance, not a
router gate.** `erpclaw-growth/SKILL.md` asks the agent to confirm
`convert-lead-to-opportunity`, `mark-opportunity-won/lost`,
`convert-opportunity-to-quotation`, `merge-crm-contacts`,
`promote-contact-to-customer` and others, but none of them is in the
foundation's `DANGEROUS_ACTIONS`. §4.2 maps them to Commit (or Draft where
the outcome is an unposted draft) on Vitana's side so the confirmation is
enforced by policy, not by prompt.

6.5 **`fetch-exchange-rates` and `install-module` are ERPClaw's only two
network calls** (`SKILL.md`, Security). The bridge's egress policy
allowlists the first to its API host only and the second not at all.

6.6 **Period close granularity.** SKILL.md exposes `close-fiscal-year` /
`reopen-fiscal-year` / `validate-period-close`; whether a *monthly* close
is a period lock or only a fiscal-year action decides GW-4 step 7's exact
ERPClaw call. VTID-E pins it.

6.7 **Credit-note lifecycle.** SKILL.md lists `create-credit-note` and
`list-credit-notes` but no dedicated credit-note submit action; whether a credit note
posts on creation or via `submit-sales-invoice` on an `is_return`
document decides GW-3 case A's second action. VTID-E pins it; the
Vitana-side tier (High-risk) does not depend on the answer.

---

## 7. Open decisions — named-owner items, all UNASSIGNED

The plan's ten product decisions are closed. These four need a **named
person**, not a design; nothing in wave 1 is blocked on them until the
step that cites them, which is marked in each row.

| # | Item | Status | Blocks |
|---|---|---|---|
| 1 | **Named finance owner** who reconciles the first GW-1 → GW-4 run on staging, signs the `uae_ifrs.json` chart (U1), confirms the VAT treatments (U2) and the FTA box mapping (U3), and sets the High-risk amount threshold (§4.3) | **UNASSIGNED** | GW-1 acceptance test 5 / GW-4 acceptance test 5 (Phase 4's bar); U1–U3 sign-off |
| 2 | **Named UAE payroll provider and WPS route**, and the **HR owner** for HR & People (U5, U6, U9) | **UNASSIGNED** | HR section (wave 2), payroll journal (wave 3); nothing in wave 1 |
| 3 | **Counsel's one-line confirmation** of decision 1 (hosted-only, never distributed; GPLv3 network-use is not distribution) | **UNASSIGNED** (formality, not a gate) | nothing; recorded when received |
| 4 | **VTID-E spike proofs** — CoA loader accepts a non-shipped template (6.1); UAE VAT reverse-charge and zero-rated vouchers (6.2 / GW-2 test 1); subprocess latency distribution; concurrent GL posting; idempotent retry; backup/restore; upgrade rehearsal pinned → next tag; security review of subprocess + secrets — each with a named engineer responsible for the evidence in `docs/validation/<VTID-E>/outputs/` | **UNASSIGNED** (the engineer is named when VTID-E is allocated) | VTID-F and every wave-1 screen that executes Commit-tier commands |

---

*Derived from: Plan v3.2 (Decision Log 2026-09-12); `avansaber/erpclaw`
`SKILL.md`, `scripts/db_query.py`, `scripts/erpclaw-gl/db_query.py`,
`scripts/erpclaw-tax/db_query.py`, `scripts/module_registry.json` at
`4d32db65`; `avansaber/erpclaw-addons` `erpclaw-growth/SKILL.md` at
`7c1b5ae5`. No ERPClaw code was executed for this document.*
