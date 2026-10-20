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
3. **Loop guard: one count, one window, enforced on both sides.** The cap is **2 partner passes per producer per 24 h**
   for `partner_output_invalid`: the first pass plus one automatic re-run. It is counted per producer
   (`ci-plan-spar.<slug>`, `plan-spar.mjs:195`), not per plan hash, so editing `plan.md` does not reset it.
   `PARTNER_INVALID_CAP = 2` and `PARTNER_INVALID_WINDOW_MS = 24 h` are the same constants on both sides.
   - **Gateway (sparring R1-F1).** The cap check runs on every create, before any session is inserted:
     - Where it sits: after the existing producer + hash lookup and its dedup returns (`plan-sparring-service.ts:267`–`:285`),
       and immediately before `insertSession` (`:289`), outside the `if (existing.data)` block. So a create whose plan
       hash changed (no `existing.data`) is counted too.
     - The count is one new query in `plan-sparring-repository.ts`, next to `fetchSessionByPlanHash` (`:75`): the
       producer's `escalated` sessions whose `escalation_reasons` contain `partner_output_invalid`, created within the
       window.
     - Count at or above 2: no insert. The service returns the producer's newest session with `deduplicated: true` and
       `retry_exhausted: true`.
     - Below 2, a stored `partner_output_invalid` session for the same hash is re-run (Change 2), not deduplicated.
     - `retry_exhausted` is a top-level response field of the create route, next to `deduplicated`
       (`routes/plans-spar.ts:49`–`:50`). It is not a stored column, so `SparringSession`, `SESSION_COLUMNS` (`:39`)
       and the table do not change.
     - Sessions with other reasons are not counted, and they keep today's rule.
   - **CI (sparring R1-F2).** `gatewayClient.create` (`plan-spar.mjs:114`–`:121`) returns `{ session, deduplicated,
     retry_exhausted }` on all three paths:
     - the direct response returns the flags from `r.json`;
     - the `waitFor` path (`:116`) takes the flags from `r.json` before it polls;
     - the lost-response re-post (`:119`–`:121`) takes the flags from `again.json` before calling `waitFor`.
     - `waitFor` polls `GET /:id`, which carries no flags, so the flags are never read from it. A missing flag is read
       as `false` only on the first create, where the gateway cannot have capped anything; the next create's response
       always carries the gateway's answer.
     - **The new return shape is wired through every caller (sparring R2-F1):**
       - in `step()`, `let deduplicated = false; let retryExhausted = false;` sit next to `let session` (`:186`), so
         they are in scope on every path, including the `round` path (`:215`), where they stay `false`;
       - the call site at `:194` becomes `({ session, deduplicated, retry_exhausted: retryExhausted } = await
         client.create({…}))`, so `state.sessions.push({ id: session.id, … })` (`:203`) and the shared block from
         `:222` keep reading the unwrapped `session`;
       - `client.round` keeps returning a bare session;
       - in `plan-spar.test.mjs`, `fakeClient.create` (`:39`) returns `{ session: take(), deduplicated: false,
         retry_exhausted: false }`, and a script entry may carry `{ flags: { deduplicated, retry_exhausted } }` for the
         cap tests. Every existing test keeps scripting bare sessions, and their assertions are unchanged.
     - `step()` sets `entry.retryable = <reason retryable> && !deduplicated && !retryExhausted` (`:228`). When
       `retryExhausted`, it also records `entry.exhausted_at` (ISO).
   - **After the window.** `retryInfra` (`:188`) is also true for an entry with `retry_exhausted` whose `exhausted_at`
     is older than the window. So the next push after 24 h tries once more, and the gateway allows it because its
     window has passed. The bound stays 2 passes per producer per 24 h on both sides; nothing loops faster.
4. **No hand-off to Claude** (`plan-spar.mjs:278`–`:281`):
   - an infra escalation that will be retried sets `next_actor: kiro`, with the log line "the next push to this PR
     re-runs the partner";
   - an infra escalation that will not be retried (another reason, or `retry_exhausted`), and a plan parked after
     `MAX_SESSIONS`, set `next_actor: owner`. For `retry_exhausted` the log line also says when the next try is
     possible (`exhausted_at` + 24 h, on the next push);
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
- `plan-spar.test.mjs:193` becomes "is retried on the next push, at most once per 24 h":
  - the first push re-creates;
  - a second escalation with `retry_exhausted: true` does not create again;
  - a third push does nothing;
  - `create` is called exactly twice;
  - `handoff.md` shows `next_actor: kiro` after the first escalation and `owner` after the cap;
  - with `now` moved past the window, the next push creates once more.
- `plan-spar.test.mjs:140` changes too (sparring R2-F2). Every reason already in `RETRYABLE_REASONS` takes the new
  rule:
  - it is renamed "a partner outage is retried by Kiro on the next push, is never parked, and the retry does not use
    up a session";
  - `next_actor` becomes `'kiro'` (was `'claude'`), and the log line says that the next push re-runs the partner;
  - its retry and session assertions are unchanged.
- One new test: a non-retryable infra reason, or `retry_exhausted`, sets `next_actor: 'owner'`. No test asserts
  `'claude'` after this lane.
- **The flags on every create path** (R1-F2):
  - the fake client answers through the lost-response re-post path with `retry_exhausted: true`, and `step()` does not
    retry;
  - the same holds for the `waitFor` path.
- **Gateway Jest** (`test/vtid-04868-plan-sparring-service.test.ts`):
  - a stored `partner_output_invalid` session is re-run, not deduplicated;
  - with 2 such sessions for the producer inside the window, the next create inserts nothing and returns
    `deduplicated` + `retry_exhausted`, also when the plan hash changed in between (no `existing` row: R1-F1);
  - with those 2 sessions older than the window, the create inserts;
  - `model_unavailable` keeps today's behaviour;
  - `test/plan-sparring-stale-session.test.ts` (VTID-05254) stays green.
- `tsc --noEmit`.
- Change suite: `existing` entries running those Jest files, and a read-only `GET /alive` after the staging deploy.

## Risks
- **Retry loop:** bounded at 2 passes per producer per 24 h, enforced on both sides. The gateway check runs before
  every insert, whatever the plan hash (Change 3).
- **A real model problem behind `partner_output_invalid`:** after one re-run the plan goes to `owner` with the reason
  logged. It can try again at most once per day after that, never in a tight loop.
- **Governance lane built by Kiro:** it goes through #4210's rules (a different-seat review, and an owner-instruction
  plus merge record) and merges only on the owner's explicit per-PR instruction.
<!-- plan:end -->
