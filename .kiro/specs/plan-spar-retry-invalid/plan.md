# Plan — plan-spar-retry-invalid

Retry a sparring round that ended without a review, and stop handing stuck plans to Claude Code. This replaces lane
`collab-kiro-governance/retry-partner-invalid` (VTID-05261), which can no longer get `governance: true` (see Today 3).

<!-- plan:begin -->
## Goal (owner, 2026-10-20)
"Eliminate Claude Code, I want everything done by Kiro end-to-end" and "go with option B and the real fix". The owner
chose Option A on 2026-10-20: governance lanes use `governance: true` from `retire-claude-code` (#4210, VTID-05259). This
plan is Change B of `collab-kiro-governance`, re-planned as a new lane on that rule. Pinned:
`exafyltd/vitana-platform@3063c9543`.

## Today (verified in code at the pin)
1. **A partner that never submits a review stalls the plan.** The partner pass fails with `partner_output_invalid`
   when it ends its turn without `submit_review` or runs out of turns
   (`services/gateway/src/services/plan-sparring/partner.ts:212`, `:279`, `:285`). `scripts/collab/plan-spar.mjs:34`
   counts it as infra, but not as retryable (`:35`), so `retryInfra` (`:188`) never re-creates the session. The gateway
   also dedups a create on the same producer + plan hash (`plan-sparring-service.ts:267`). It re-runs only when the
   stored session is `escalated` with a reason in its own `RETRYABLE_REASONS` (`:46`, `:283`–`:285`). VTID-05254's
   dead-round-1 re-run (`:271`–`:281`) does not cover it: that session is `escalated`, not `in_progress`.
   `plan-spar.test.mjs:193` pins today's behaviour. Seen on 2026-10-20 on `gateway-test-cachebust` (#4207) round 3.
2. **A stuck plan is handed to an actor that is being retired.** On an infra escalation `plan-spar.mjs:278` sets
   `next_actor: 'claude'`, with the log line "Claude Code looks at the partner, then re-runs" (`:281`). A plan parked
   after `MAX_SESSIONS` also gets `next_actor: 'claude'` (`:279`).
3. **Why a new plan.** Old lane `retry-partner-invalid` depends on `owner-governance`, which the owner closed
   (Option A). Under #4210 no commit may change an existing lane's permission fields, so the old lane cannot gain
   `governance: true`. A permission change is a new lane in a new `plan(` PR, and PLAN-SPAR does not re-spar a
   converged plan.

## Change — lane `retry-invalid`
1. `plan-spar.mjs:35`: add `partner_output_invalid` to `RETRYABLE_REASONS`.
2. `plan-sparring-service.ts:46`: add `partner_output_invalid` to the gateway's `RETRYABLE_REASONS`. Both lists move
   together, or the gateway dedups the retry (`:285`).
3. **Loop guard: one count, enforced on both sides.** The cap is **2 partner passes in total per producer** for
   `partner_output_invalid`: the first pass plus one automatic re-run. It is counted per producer
   (`ci-plan-spar.<slug>`, `plan-spar.mjs:195`), not per plan hash, so editing `plan.md` does not reset it.
   - **Gateway:** before re-running a stored `partner_output_invalid` session, `createSparringSession` counts the
     producer's `escalated` sessions whose `escalation_reasons` contain `partner_output_invalid`. This is one new
     count query in `plan-sparring-repository.ts`, next to `fetchSessionByPlanHash` (`:75`).
     - Count below 2: re-run, not dedup.
     - Count at 2: dedup, and the create route also returns a top-level `retry_exhausted: true`, next to the existing
       `deduplicated` (`routes/plans-spar.ts:49`–`:50`).
     - Both are response fields, not stored columns, so `SparringSession`, `SESSION_COLUMNS` (`:39`) and the table do
       not change. Every other reason keeps today's rule.
   - **CI:** `gatewayClient.create` (`plan-spar.mjs:114`–`:121`) today returns only the session and drops
     `deduplicated`. It will return `{ session, deduplicated, retry_exhausted }`, also from its lost-response re-post
     path (`:119`–`:121`). `step()` reads them and sets
     `entry.retryable = <reason retryable> && !deduplicated && !retry_exhausted` (`:228`). So once the cap is reached,
     `retryInfra` (`:188`) is false and the plan waits.
4. **No hand-off to Claude** (`plan-spar.mjs:278`–`:281`):
   - an infra escalation that will be retried sets `next_actor: kiro`, with the log line "the next push to this PR
     re-runs the partner";
   - an infra escalation that will not be retried (another reason, or `retry_exhausted`), and a plan parked after
     `MAX_SESSIONS`, set `next_actor: owner`;
   - the log line names the reason. Nothing else in the handoff changes.
5. **Lane fields:**
   - `executor: kiro`, `governance: true` (it changes `scripts/collab/**`);
   - seat `exafyltd` (the plan's author seat), reviewer `jtadic`;
   - `paths` limited to the files in Tests below plus its evidence.

## Out of scope
- `ROUND_CAPS`, `MAX_SESSIONS`, the evidence floor, and which reasons count as infra;
- the `sparred` branch used when VTID allocation is off (`plan-spar.mjs:264`, `:268`);
- any other governance path;
- production deploy rules.

## Order and bootstrap
- **Build order:** the lane is built only after #4210 (VTID-05259) is on `main`. Main's checker today refuses every
  governance path from a Kiro lane, and only #4210 makes `governance: true` valid.
- **On this plan PR:** the report-only `Collab handoff` step flags the lane's `scripts/collab/**` paths, which is
  that same old refusal.
- **On the lane PR:** after #4210 merges, the lane PR passes Lane scope with no override.

## Tests
- `node --test scripts/collab/queue.test.mjs scripts/collab/plan-spar.test.mjs`.
- `plan-spar.test.mjs:193` becomes "is retried on the next push, at most once":
  - the first push re-creates;
  - a second escalation with `retry_exhausted: true` does not create again;
  - a third push does nothing;
  - `create` is called exactly twice;
  - `handoff.md` shows `next_actor: kiro` after the first escalation and `owner` after the cap.
- **Gateway Jest** (`test/vtid-04868-plan-sparring-service.test.ts`):
  - a stored `partner_output_invalid` session is re-run, not deduplicated;
  - with 2 such sessions for the producer, the next create is deduplicated with `retry_exhausted`, also when the plan
    hash changed in between;
  - `model_unavailable` keeps today's behaviour;
  - `test/plan-sparring-stale-session.test.ts` (VTID-05254) stays green.
- `tsc --noEmit`.
- Change suite: `existing` entries running those Jest files, and a read-only `GET /alive` after the staging deploy.

## Risks
- **Retry loop:** bounded at 2 passes per producer, enforced on both sides (Change 3).
- **A real model problem behind `partner_output_invalid`:** after one re-run the plan goes to `owner` with the reason
  logged; it does not loop.
- **Governance lane built by Kiro:** it goes through #4210's rules (a different-seat review, and an owner-instruction
  plus merge record) and merges only on the owner's explicit per-PR instruction.
<!-- plan:end -->
