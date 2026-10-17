---
lane: wizard-price-polish
state: ready
next_actor: owner
depends_on: [tenant-domains-db]
executor: kiro
seat: exafyltd
reviewer_seat: hotmail
area: frontend
paths:
  - src/components/admin/tenant-provisioning/**
  - src/lib/tenant-provisioning-api.ts
  - src/lib/price-display/**
  - src/i18n/de/tenantProvisioning.json
  - src/i18n/en/tenantProvisioning.json
  - docs/multitenancy/RUNBOOK-offboarding.md
  - tests/e2e/staging/vtid-*-wizard-polish.staging.spec.ts
  - docs/validation/VTID-*/**
  - docs/SCREEN_INVENTORY.md
  - i18n-source-stamps/**
updated: 2026-10-15T16:40Z
---
# Wizard polish, price-display de-hardcoding, offboarding runbook — mt-m3 (repo vitana-v1)

Plan: `.kiro/specs/mt-m3/plan.md`; tasks P1–P7 in `tasks.md`; design in `design.md`. Polishes VTID-05221's provisioning
panel (readiness affordances, a custom-domain field posting to `tenant_domains` via the admin API, clearer step errors),
de-hardcodes price/currency DISPLAY to read `tenant_settings.currency` (display only — no wallet/plan/invoice, D2/D9),
and adds `docs/multitenancy/RUNBOOK-offboarding.md` referencing mt-tenant-admin's deactivate/archive RPCs (reference
only). Depends on `tenant-domains-db` (the custom-domain field needs the table). i18n DE-first du-form; Spotlight; RTL.
The lane adds its own `docs/validation/VTID-<vtid>/`.

Rules (collaboration §7a): no VTID allocation, no `_plan` claim, no `handoff.md` edit, no merge/approve/deploy/dispatch,
no Supabase/AWS writes, and never call a provisioning write endpoint against a live system (staging read-only). Work only
inside the allowed paths. Branch `kiro/mt-m3/wizard-price-polish`; PR title `VTID-xxxxx (mt-m3/wizard-price-polish): …`;
trailers `Collab-Session` / `Collab-Lane: mt-m3/wizard-price-polish`. When the PR is open: set `state: in-review`,
`next_actor: kiro`, `pr: <url>`, append a log entry, release the claim.

HELD: `next_actor: owner` until PLAN-SPAR allocates this lane's VTID.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created by the mt-m3 plan. Held for PLAN-SPAR. Frontend lane, seat `exafyltd` (area `frontend`), reviewer `hotmail`;
depends on `tenant-domains-db`.
