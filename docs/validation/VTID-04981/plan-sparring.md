# VTID-04981 — plan sparring record

Partner: plan-sparring-partner agent (read-only). Class: standard. Rounds: 2. Verdict: CONVERGED.
Owner approval: 2026-10-08, Gate 1 "Approve (Recommended)" — plan hash cd181818eab38539e50914143c84036dae76a215568d95edd38a5e1f5f8bbcd6.

# Plan — members cannot spend another member's credits through fn_consume_credits

<!-- plan:begin -->
## Change class
standard (one migration; security/governance-relevant; no route, workflow or deploy change)

## Problem (verified read-only 2026-10-08, production)
- `public.fn_consume_credits(uuid,uuid,integer,text,text,text)` (VTID-03107,
  `supabase/migrations/20260526040000_VTID_03107_usage_helpers.sql:150-213`) is SECURITY DEFINER,
  `GRANT EXECUTE ... TO authenticated` (live: `has_function_privilege('authenticated', …)` = true,
  anon = false), takes any `p_user_id` and never checks `auth.uid()`. It calls
  `credit_wallet(..., -p_credits, 'reward'|'purchase', ...)`.
- So any signed-in member can call `POST /rest/v1/rpc/fn_consume_credits` with another member's
  user id and debit that member's earned VTNA (`p_bucket='reward_credits'`) or purchased credits.
  232 members hold earned VTNA today (17,565 VTNA paid). Not exploited so far: 0
  `wallet_transactions` rows with `metadata.source like 'paywall:%'` and 0 negative reward rows.
- The only caller is the gateway on the service role
  (`services/gateway/src/services/entitlement-service-repository.ts:67`, from
  `entitlement-service.ts` ~623); no vitana-v1 code or edge function calls it (grep).
- Separately, owner decision (BUSINESS-MODEL.md §11 item 6, backend.md §13c rule 8): earned VTNA
  is spent only by rewards (shop, subscription conversion); purchased credits stay with feature
  overage. The `reward_credits` bucket of this function contradicts that.

## Work (access only — behaviour of the function is unchanged)
1. Migration `supabase/migrations/<ts>_vtid_<n>_consume_credits_lockdown.sql`:
   - `REVOKE ALL ON FUNCTION public.fn_consume_credits(uuid,uuid,integer,text,text,text) FROM
     PUBLIC, anon, authenticated; GRANT EXECUTE ... TO service_role;`
   - The function body is NOT changed: every bucket, including `reward_credits`, behaves exactly
     as today for the gateway (the only caller), so the live `allowed_burn_buckets` feature config
     keeps working.
   - Self-check DO block: raises if authenticated or anon can execute it.
2. Tests: `supabase/tests/vtid_<n>_consume_credits_lockdown.test.sql` asserting
   `has_function_privilege` false for authenticated/anon and true for service_role, wired into CI
   by a new `scripts/ci/test-vtid-<n>-consume-credits-lockdown.sh` modelled on
   `scripts/ci/test-vtid-04878-capped-rewards.sh` and added to the same workflow step that runs
   that script (named in the PR). A gateway Jest test pins that `entitlement-service-repository.ts`
   calls the RPC through the service-role client.
3. Docs: DATABASE_SCHEMA.md note; validation folder.

## Out of scope — separate decision, tracked for the owner
Whether paywall overage may spend earned VTNA at all. BUSINESS-MODEL.md §11 item 6 (owner,
2026-10-01) and backend.md §13c rule 8 say only rewards spend earned VTNA; §4 and the live
`allowed_burn_buckets` seed still allow `reward_credits` on match_reveals, match_posts,
lab_analyses and photo_uploads. Reconciling that (re-seed buckets + gateway selection + docs) is a
follow-up plan once the owner confirms which rule stands; this fix does not change it.

## Rollout
PR -> CI -> merge -> RUN-MIGRATION.yml. Staging and production share one Supabase project, so the
migration cannot be staged separately; the verification is read-only after apply:
`has_function_privilege('authenticated', …)` = false and `('service_role', …)` = true, plus the
gateway paywall path unchanged (no code change). No gateway deploy, so no Gate 2.

## Risks
- Anything calling the RPC as a member breaks — none in either repo (grep: only
  `entitlement-service-repository.ts:67`, service role).
<!-- plan:end -->

## Planner responses (round 1)
- F1 blocker (blocking reward_credits contradicts the live allowed_burn_buckets seed): ACCEPTED — the function body is no longer changed; the plan is access-only. The rule conflict is moved to "Out of scope", to be decided by the owner (your Q3).
- F2: please restate it in round 2 — your round-1 text reached me starting at F3; I will answer it then.
- F3 minor (gateway would not fall back after BUCKET_NOT_SPENDABLE): ACCEPTED — moot, the block is removed.
- F4 minor (CI wiring of the SQL test): ACCEPTED — Work 2 names the new script and that it runs in the same step as the 04878 script.
- F5 minor (migration targets the shared DB; cannot be staged): ACCEPTED — stated in Rollout with the read-only checks.
- Q1/Q2: the rule question goes to the owner as a separate decision; nothing is re-seeded here.
- Q3: yes — that is now the plan.

## Round 2 (partner)
F1 (blocker: blocking reward_credits breaks four seeded features) closed; F2 (major: a later re-GRANT; needs a CI regression test) closed; F3-F5 closed; no new findings.

## Verdict
CONVERGED after 2 rounds (standard class). Plan hash: cd181818eab38539e50914143c84036dae76a215568d95edd38a5e1f5f8bbcd6
