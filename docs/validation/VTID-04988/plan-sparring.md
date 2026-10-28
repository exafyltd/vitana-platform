# VTID-04988 — plan sparring record

Partner: plan-sparring-partner agent (read-only). Class: standard. Rounds: 2. Verdict: CONVERGED.
Owner approval: 2026-10-08, Gate 1 "Approve (Recommended)" — plan hash 09ae72e25620a456fa97eef3cdee4e80fbe33bd228d452b0f4d24debce5a035a.

# Plan — earned VTNA is spent only on rewards (paywall overage uses purchased credits)

<!-- plan:begin -->
## Change class
standard (migration on a config table + gateway selection logic + a member-facing billing contract)

## Owner decision (2026-10-08, not to be re-argued)
"Rewards only": earned VTNA is spent only on the rewards shop and Premium conversion; paywall
overage never spends it. This confirms BUSINESS-MODEL.md §11 item 6 and backend.md §13c rule 8,
and supersedes BUSINESS-MODEL.md §4's "reward_credits: cheap features only … rewards first".

## Current state (verified read-only 2026-10-08)
- `feature_entitlements.allowed_burn_buckets` includes `reward_credits` for match_posts,
  match_reveals, lab_analyses, photo_uploads (4 plans each, 16 rows; seed
  `20260526030000_VTID_03107_seed_plans.sql:148-177`); live_room_minutes and voice_live_minutes
  are purchased-only.
- `consumeCredits()` (`services/gateway/src/services/entitlement-service.ts:~596-640`) picks a
  caller-preferred bucket if allowed, else `reward_credits` first when allowed and sufficient,
  else `purchased_credits`. `POST /api/v1/billing/consume` (`routes/billing.ts:~586`) passes a
  member-supplied `preferredBucket`; vitana-v1 `useBilling.ts:67` / `billingApi.ts:243` type it as
  `'purchased_credits' | 'reward_credits'`.
- `fn_consume_credits` maps `reward_credits` -> `credit_wallet(..., 'reward', -n)`; since
  VTID-04981 only the gateway can call it.
- No member has ever been debited this way (0 `paywall:%` wallet_transactions).

## Work
1. Migration `<ts>_vtid_<n>_earned_vtna_rewards_only.sql`:
   - `UPDATE feature_entitlements SET allowed_burn_buckets = array_remove(allowed_burn_buckets,
     'reward_credits') WHERE 'reward_credits' = ANY(allowed_burn_buckets);` (16 rows; idempotent).
   - `CREATE OR REPLACE fn_consume_credits` with the body unchanged except `reward_credits`
     returns `{ok:false, error:'BUCKET_NOT_SPENDABLE', message:'earned VTNA is spent only on
     rewards'}` without writing — the same shape as the existing cash_balance branch; privileges
     restated (service_role only) because CREATE OR REPLACE keeps grants but the self-check from
     VTID-04981 is repeated.
   - Self-check: no feature_entitlements row allows reward_credits; members cannot execute.
   - Header comment: this migration must run after the VTID-03107 seed (whose ON CONFLICT DO UPDATE
     would restore reward_credits if re-run); timestamps guarantee the order.
2. Gateway `entitlement-service.ts`: the selection drops the rewards-first branch; a
   `preferredBucket` of `reward_credits` is ignored (falls to purchased_credits) rather than
   honoured; `WalletBucket` keeps the type value for reads (balances still report it).
   `routes/billing.ts` unchanged except it no longer forwards `reward_credits` as a preference.
3. The seed migration file is NOT edited (history); the new migration is the source of truth.
4. Tests: SQL harness (extends the VTID-04981 runner pattern: 04809 wallet + VTID-03107 seed rows
   for the 4 features + the function) asserting no row allows reward_credits after apply, a
   reward_credits debit returns BUCKET_NOT_SPENDABLE and leaves earned_balance unchanged, a
   purchased debit still works; Jest for consumeCredits (never selects reward_credits, even when
   preferred and sufficient; purchased path unchanged) and for the billing route.
5. Docs: BUSINESS-MODEL.md §4 table row and burn-order line rewritten to the owner decision;
   DATABASE_SCHEMA.md note; backend.md §13c rule 8 sentence names this VTID.
6. vitana-v1: no change needed for behaviour (the gateway ignores the preference); the
   `bucket?: 'reward_credits'` type stays harmless. Not touched in this VTID.

## Rollout
PR -> CI -> merge -> RUN-MIGRATION (shared database; read-only check after: 0 rows allow
reward_credits) -> gateway staging deploy -> STAGING-VERIFY -> Gate 2 -> publish.
Order is safe either way: the migration alone already stops earned spending (config + function);
the gateway change removes the dead branch.

## Risks
- User-visible: the paywall 402 body's `user_credit_balance` for the four features is the sum of
  the allowed buckets (`bucketsToBalance()`, entitlement-service.ts ~401-406), so after the
  migration it excludes earned VTNA — a member with only earned VTNA sees 0 available credits for
  match posts/reveals, lab analyses and photo uploads and gets the overage refusal. This is the
  intended outcome of the owner's decision and is stated to the owner at Gate 1.
- A member whose purchased credits are exhausted but who has earned VTNA now gets the
  overage refusal for those four features instead of spending VTNA — the intended outcome.
- Between migration and gateway publish, the old gateway may still pick reward_credits (it reads
  allowed_burn_buckets, which no longer lists it, so it will not) — config change alone is
  sufficient.
<!-- plan:end -->

## Planner responses (round 1)
- F1 major (paywall user_credit_balance drops for the 4 features): ACCEPTED — stated under Risks as an intended, user-visible change and named at Gate 1.
- F2 minor (provenance of "0 paywall debits"): acknowledged — read-only production query 2026-10-08, also recorded in the VTID-04981 migration header.
- F3 minor (body baseline): acknowledged — no intermediate CREATE OR REPLACE; the VTID-03107 body is the baseline.
- F4 minor (seed re-run would restore the bucket): ACCEPTED — header comment added; ordering is guaranteed by timestamps.
- F5 minor (preferredBucket fall-through): acknowledged — the config change alone already makes it fall through; the gateway edit removes dead branches.
- Q1: yes, intended (owner decision "rewards only", 2026-10-08).

## Round 2 (partner)
F1-F5 closed; no new findings.

## Verdict
CONVERGED after 2 rounds (standard class). Plan hash: 09ae72e25620a456fa97eef3cdee4e80fbe33bd228d452b0f4d24debce5a035a
