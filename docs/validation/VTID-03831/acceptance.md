# VTID-03831 — Governance: BackOffice operating design gate document

## Report

Phase 1 of the Vitanaland BackOffice (ERP/CRM on ERPClaw) plan is an
operating design gate: no code, one artefact that every following build
VTID (role + enum alignment, `/backoffice` skeleton, capability grants,
erp-bridge, orchestrator, wave-1 screens) is built against. This VTID
ships that artefact — `docs/backoffice/GOLDEN-WORKFLOWS.md` — plus this
evidence pack.

The document was derived from the pinned ERPClaw sources, not from
memory: `avansaber/erpclaw` at `4d32db6585297a1d05a7b5927168de8c75bb7708`
(v4.15.0; `SKILL.md`, the router's `DANGEROUS_ACTIONS` set, the CoA loader,
the tax-line model, the module registry) and the CRM module's own
`SKILL.md` in `avansaber/erpclaw-addons` at `7c1b5ae5` (read-only, HEAD on
the day; VTID-E pins it). Every ERPClaw action name the document cites was
cross-checked mechanically against those catalogs, and every action it
labels "ERPClaw-gated" was cross-checked against the router's actual
`DANGEROUS_ACTIONS` frozenset — that check caught three real mistakes in
the first draft (a non-existent action name, and three actions mislabelled
gated because they shared a table row with a gated one), which were fixed
before this pack was written. No ERPClaw code was executed. Nothing
touches production data; nothing deploys.

## Acceptance Criteria

AC-1 — `docs/backoffice/GOLDEN-WORKFLOWS.md` exists and contains the four
minimum golden workflows (order-to-cash; procure-to-pay; refund /
credit-note / reversal; month-end reconciliation & close), each with an
owner, an approver, an exception path, an accounting result and an
acceptance test.

TEST: `outputs/check-golden-workflows.py` section [3] — asserts all five
parts are present for GW-1..GW-4; result in `outputs/catalog-crosscheck.txt`
("GW-n: PASS all five parts present" ×4).

AC-2 — The document contains the capability catalog and the default
grants per Vitana role (plan B2/B4/B4b), with `hr.*`/`payroll.*` never in
the `admin` defaults and `developer`/`infra` capped at Read.

TEST: `outputs/check-golden-workflows.py` section [4] — asserts the
"## 3. Capability catalog" section exists; the two rules are stated in
§3.2 ("Never by default" column) and §3.3 rules 3 and 5 of the document
(manual read).

AC-3 — The wave-1 ERPClaw action → typed command → tier mapping is
derived from `SKILL.md` at the pinned commit: every action name cited in
the document exists in the pinned core catalog or the CRM module catalog.

TEST: `outputs/check-golden-workflows.py` section [1] — 267 cited action
names resolve; "PASS — no cited action is absent from the pinned catalogs"
in `outputs/catalog-crosscheck.txt`.

AC-4 — Vitana's tiers are at least as strict as ERPClaw's own gate: every
action the document marks "ERPClaw-gated" is in the router's
`DANGEROUS_ACTIONS` set at the pinned commit, and no `DANGEROUS_ACTIONS`
member is exposed at Read or Draft tier.

TEST: `outputs/check-golden-workflows.py` section [2] — 23 gated claims
all in the 74-member frozenset; "PASS — no DANGEROUS action is exposed at
Read or Draft tier" in `outputs/catalog-crosscheck.txt`.

AC-5 — Every High-risk row in the mapping names an approver capability
(maker-checker is never left implicit).

TEST: `outputs/check-golden-workflows.py` section [5] — 13 High-risk rows,
"PASS all name an approver".

AC-6 — The UAE compliance items (plan B4b) are tabulated with an owner
column, and the four still-open named-owner items from the plan are
listed and marked UNASSIGNED.

TEST: `outputs/check-golden-workflows.py` section [4] — "## 5. UAE"
section present; "open-decision rows marked UNASSIGNED: 4/4".

AC-7 — The VTID was self-allocated and taken through the full spec
pipeline (generate → validate → quality-check → approve) on the staging
gateway before the artefact was written; `spec_status = approved`.

CURL: `commands.log` — allocate 201, PATCH 200, generate 201 (v1, no 502
this time), validate 200 `result: pass`, quality-check 200
`overall_result: pass` (with the known false-positive `risk_level:
CRITICAL`), approve 200 `spec_status: approved`. Raw responses in
`outputs/spec-*.json`.

AC-8 — No code, no migration, no deploy, no production data write.

TEST: `git diff --stat origin/main...HEAD` in `commands.log` — only
`docs/backoffice/` and `docs/validation/VTID-03831/` change.

## Not verified / out of scope

- The document's §6 findings (CoA loader path lookup, reverse-charge
  modelling as a two-line template, credit-note lifecycle, monthly-close
  granularity) are read from source, not executed. They are explicitly
  handed to VTID-E (foundation spike) as proofs, not assumptions.
- The four §7 items are people decisions the platform owner makes; this
  VTID records them as UNASSIGNED, it does not resolve them.
