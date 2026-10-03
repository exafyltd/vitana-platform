# VTID-04857 — Jev community cost control, slice 1: the budget caps community spend only, owner pages at 80% / 100%

Owner approval 2026-10-03 ("Community cost control: approved"): Maxina $50/month, Alkalma $10/month; page the
owner at 80%, fall back to rules at 100%; internal stays unlimited. Plan: `docs/JEV-INTEGRATION-PLAN.md` §10.4 / §10.6.

Before this change `monthly_budget_usd` was compared with the tenant's spend across **all** planes, so a
community budget would also have throttled staff tooling and Dev Autopilot — against the owner's rule that
internal use is unlimited.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: The tenant budget is compared only with the tenant's `member` + `patient` + `partner_org` spend (`JEV_BUDGETED_PLANES`). Internal and system_autopilot calls never read the budget and are never refused for it, even when the community budget is exhausted.
  TEST: services/gateway/test/vtid-04857-jev-community-budget.test.ts
AC-2: Member-content decisions count as `member` spend whoever runs them (an admin moderating, an autopilot ranking), so they are capped by the budget and recorded under `member` in `jev_spend_counters`.
  TEST: services/gateway/test/vtid-04857-jev-community-budget.test.ts
AC-3: At 100% a budgeted call returns the existing fallback `tenant_budget_exhausted` (429) with no Jev call — every caller keeps its own rules. An unreadable spend still fails closed (`budget_check_failed`).
  TEST: services/gateway/test/vtid-04857-jev-community-budget.test.ts
  TEST: services/gateway/test/vtid-04754-jev-foundation.test.ts
AC-4: The call that crosses 80% (and the one that crosses 100%) emits one OASIS `jev.budget.threshold_crossed` event and one Command Hub chat page, once per tenant × month × level; an alert another gateway task already raised (found in `oasis_events` by `alert_key`) is not raised again; a failing page never throws or slows the decision.
  TEST: services/gateway/test/vtid-04857-jev-community-budget.test.ts
AC-5: Data fix-up `supabase/migrations/data-fixups/20261003120000_vtid_04857_jev_community_budgets.sql` sets `feature_flags.jev` for maxina ($50) and alkalma ($10) with planes internal, system_autopilot, member — applied only after this code is live in production. Listing `member` does not open the member plane: `JEV_COMMUNITY_ENABLED` stays unset on every gateway.
AC-6: All Jev suites, the operator pipeline and role-separation suites stay green.
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
  TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts

## Scope

SCOPE_ALLOWLIST:
- services/gateway/src/services/jev/jev-policy.ts (budgeted planes, spend plane, alert levels)
- services/gateway/src/services/jev/jev-tenant-control.ts (plane-aware spend reads)
- services/gateway/src/services/jev/jev-repository.ts (plane filter, alert lookup)
- services/gateway/src/services/jev/jev-decision-service.ts (budget scope, alert hook)
- services/gateway/src/services/jev/jev-budget-alerts.ts (new)
- services/gateway/test/vtid-04857-jev-community-budget.test.ts (new), services/gateway/test/vtid-04754-jev-foundation.test.ts (budget tests moved to a member-content decision)
- supabase/migrations/data-fixups/20261003120000_vtid_04857_jev_community_budgets.sql (new)
- DATABASE_SCHEMA.md, docs/JEV-INTEGRATION-PLAN.md, docs/validation/VTID-04857/**

Contract change on purpose: the VTID-04754 test that expected an internal call to hit `tenant_budget_exhausted` now expects that of a member-content call; an internal call with an exhausted community budget is now decided.

## OASIS

OASIS_IMPACT: one new topic, `jev.budget.threshold_crossed` (VTID-04857, source `jev:budget`, warning at 80%, error at 100%, payload `alert_key, tenant_id, month, level_pct, budget_usd, spent_usd`), at most two per tenant per month. Existing `jev.decision.*` events unchanged.

## MERGE_PAYLOAD_PREVIEW

Squash merge to `main` → staging deploy. No env change, no schema change. With no tenant budget set today nothing
changes in behaviour. The member plane stays closed (`JEV_COMMUNITY_ENABLED` unset). After production PUBLISH the
data fix-up sets the Maxina and Alkalma budgets; until a community decision runs, no spend is budgeted and no page fires.
