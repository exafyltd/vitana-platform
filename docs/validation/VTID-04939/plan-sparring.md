# Plan sparring record — VTID-04939 (item 2 of the plan sparred under VTID-04938)

Sparred and owner-approved plan: `docs/validation/VTID-04938/plan-sparring.md` (plan hash `4f2e36ed66177ffaf3b1b06633b19e63442d12c3da7e16e58c39fed3ff3c5224`, CONVERGED after 2 rounds, owner approval 2026-10-07 "proceed with item 2").

## Premise correction found while implementing (not re-sparred; the change only narrows scope)
Item 2 as sparred said "surfaces that list partner orgs to staff or non-admins (Commerce portal supplier lists, Command Hub partner queues, any public partner roster) exclude orgs whose owner is allowlisted, via one shared helper". Reading the code for those surfaces found none exists to wrap:
- Every gateway read of `partner_organizations` is per-user (`/partner-orgs/mine`), by id, or an activate/onboarding write (`routes/partner-orgs.ts`, `routes/partner-onboarding*.ts`, `services/partner-onboarding-service.ts`); no cross-org list.
- `grep` of the Command Hub `app.js` finds no partner-org listing; vitana-v1 has no `partner_organizations` query.
- The only cross-org list is admin-only (`routes/admin-marketplace-repository.ts`), where reviewer orgs SHOULD stay visible to the owner.
- The only member-facing surface is Discover, already gated by `supplier_listing_block()` (migration 20261001120000).
A helper with no caller and a guard test with nothing to guard would be dead code, so item 2 is delivered as the part that matters: a CI test that pins the existing gate for allowlisted owners, so a reviewer account can never reach Discover. If a staff/portal partner list is added later, it adopts the helper then (plan item 2's helper stays the pattern).

## Verdict
Scope narrowed within the approved plan; owner informed in chat.
