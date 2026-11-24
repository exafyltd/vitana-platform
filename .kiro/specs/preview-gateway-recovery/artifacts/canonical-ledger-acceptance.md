# What the canonical ledger would need to accept a verified staging sparring result (D2, documentation only)

Owner decision 2026-11-18 (D2): official VTID allocation is deferred. Preview sparring runs with allocation disabled and
its end-to-end run is recovery evidence only. Nothing below is built by this plan.

## Why a preview session cannot authorise an official VTID today
- The gate is inside the database. `trg_plan_sparring_check` (BEFORE INSERT on `vtid_ledger`) calls
  `_plan_sparring_gate_eval`, which reads `plan_sparring_sessions` **in the same database** and accepts only a session
  that converged, carries a matching `final_plan_hash`, is approved (`human_approved_by` or a `converged-auto-v1`
  policy approval), and is not bound to another VTID
  (`supabase/migrations/20261015180000_vtid_05214_plan_sparring_policy_approval.sql:48-156`).
- The preview's sessions live in Aurora staging (`vitana-aurora-staging` / `vitana`); the canonical ledger is the
  production database. In `log` mode an unknown `sparring_id` is logged `invalid` and dropped; in `enforce` it is refused.

## A path the schema already anticipates: the `attested` tier
`plan_sparring_sessions.trust_tier` allows `'attested'`, and `public.submit_plan_sparring_record(...)`
(`20261004110000_vtid_04868_plan_sparring_gate.sql:310-380`, EXECUTE for `service_role` only) inserts an attested record
that can never approve itself: tier, verdict (`pending_human_approval`) and approval columns are fixed by the function.
No gateway route calls it today (no reference under `services/gateway/src`).

## What would be required (each item a reviewed change; protected files marked P)
1. **Export.** A preview-side endpoint that emits the converged session as a canonical record: `plan_id`, `plan_hash`,
   `final_plan_hash`, `producer`, `change_class`, `base_ref`, `rounds`, `model_log`, `verdict`, the PLAN-SPAR run URL
   and the PR head SHA. (P: `services/gateway/src/services/plan-sparring/**`.)
2. **Signature.** The export is signed with an asymmetric KMS key that only the preview task role may use
   (`kms:Sign`), and verified on the canonical side with the public key (`kms:Verify` or a pinned public key). A copy
   without a valid signature, or whose `final_plan_hash` does not equal the SHA-256 of the plan block on the PR head,
   is refused.
3. **Import.** A canonical-side route (exafy_admin or a dedicated token, never the preview token) that verifies the
   signature and calls `submit_plan_sparring_record`. The record lands as `trust_tier='attested'`,
   `verdict='pending_human_approval'`. (P: `services/gateway/src/services/plan-sparring/**`.)
4. **Approval.** The owner approves it with the existing `POST /api/v1/plans/spar/:id/approve` (exafy_admin), which sets
   `human_approved_*`. Policy approval (`converged-auto-v1`) never crosses databases: an attested record is never
   auto-approved.
5. **Gate.** `_plan_sparring_gate_eval` already accepts a human-approved session; it must also check that an attested
   session's `final_plan_hash` equals the allocation's `p_plan_hash` (it does for every session today). If any change is
   needed there, it is a new migration (P: `supabase/migrations/*plan_sparring*.sql`).
6. **Allocation.** `POST /api/v1/vtid/allocate` on the canonical gateway with that `sparring_id` and plan hash.
   PLAN-SPAR keeps `PLAN_SPAR_ALLOCATE` off for preview runs (plan-spar-token patch), so allocation is never automatic.
7. **Audit.** Every import emits an OASIS event naming the preview session id, the signature key id and the PR head;
   the reconciler flags attested sessions without an approval.

Production-data sparring stays out of scope (owner, 2026-11-18).
