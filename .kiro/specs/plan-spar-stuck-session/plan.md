---
change_class: standard
---
# plan(plan-spar-stuck-session): a sparring session whose partner never answers recovers inside the same PLAN-SPAR run
Author: Kiro, seat `exafy`, session `kiro-exafy-202610271051-d636` (Kiro Web). Repo: `exafyltd/vitana-platform`.
Premises pinned to `origin/main` `6e0dfca618`. Proposed change, tested red → green locally: `proposed.patch` (this
folder). Investigation record: `findings.md`. Every changed file is a protected gate file, so the lane is
`executor: claude` and needs a legacy Claude review on the current head or an owner instruction naming this plan.
<!-- plan:begin -->
## 1. Goal
Owner, 2026-10-27 (Kiro Web): *"investigate why this sparring session is stuck and prepare a concrete fix for the
retry behavior. Check whether a shorter timeout and a fresh session can recover from an unresponsive partner without
weakening the review. Test the failure and recovery where possible. If the protected PLAN-SPAR file requires a
specific review, prepare the change and route it through that review."*

## 2. Today (`6e0dfca618`)
1. Incident: PLAN-SPAR run `40492189091` (plan `kiro-web-reliability`, head `87cd8767`) failed on attempt 1
   (10:59→11:27Z) and on its re-run (11:38→12:04Z) with `session 087401c4-…: no round 1 after 25 min`; a changed plan
   text (new plan hash, so no dedup) got a new session with round 1 in ~16 min. Other plans sparred normally.
2. `scripts/collab/plan-spar.mjs:45-46` `POLL_MS` 20 s, `WAIT_MS` 25 min; `:153-162` `waitFor` throws
   `no round N after 25 min`; `:164-173` `create` posts once (plus one re-post only for a lost response) and then waits.
   The timeout throws before `state.sessions.push` (`:321`) and the `state.json` write (`:363`): nothing is recorded,
   so a re-run posts the identical body again.
3. `services/gateway/src/services/plan-sparring/plan-sparring-service.ts:259-342` runs round 1 synchronously inside
   the create request; `:267-287` dedups by producer + plan hash: an `in_progress` session with 0 rounds is re-run only
   when `isDeadRoundOne` (`:58-67`), i.e. older than `STALE_AFTER_MS` = 60 min (`:51`); otherwise the same stuck
   session is returned. Attempt 2 posted at ~11:39 against a row created at ~10:59 (40 min) → deduplicated → waited
   25 min again. `repo.escalateDeadRoundOne` is a guarded UPDATE; `appendRound` refuses a write to a session that is
   no longer `in_progress` (`round_conflict`), so escalating a stuck row early is safe even if its pass finishes later.
4. `services/gateway/src/services/plan-sparring/partner.ts:174` checks the pass deadline (`PASS_DEADLINE_MS`,
   standard 15 min, service `:44`) only between turns; `:181` `await invoke(...)` has no bound, and the Bedrock
   handler has no request timeout (`providers/bedrock.ts:219-220`). One model call that never returns keeps the
   session without a round for as long as the request lives.
5. Protected gate files (`scripts/collab/protected-gate-files.json`): `scripts/collab/plan-spar.mjs`,
   `services/gateway/src/services/plan-sparring/**`. Test files are not protected.
6. Open plans in the area: #4215 `plan-spar-retry-invalid` (approved; edits `plan-spar.mjs` `create` return shape and
   both `RETRYABLE_REASONS`) — shared hot file; #4189, #4191 do not handle stuck sessions.

## 3. Change — one lane `stuck-recovery` (`executor: claude`; built by Claude, or by the exceptions seat `exafyltd`
while Claude is unavailable, collaboration.md §7)
1. **Bound each partner model call** (`partner.ts`): race `invoke(...)` against the remaining pass deadline; on timeout
   the pass ends `deadline_exceeded` — the existing escalated round 1, `infra` + retryable (gateway
   `RETRYABLE_REASONS` `:46`, CI `INFRA_REASONS`/`RETRYABLE_REASONS` `:43-44`), so the existing retry path applies.
2. **`STALE_AFTER_MS` 60 → 20 min** (`plan-sparring-service.ts:51`): above the 15-min standard pass deadline (now
   enforced per call), below the client's 25-min wait.
3. **Client recovers in the same run** (`plan-spar.mjs` `create`): when `waitFor(id, 1)` times out, re-post the same
   body once; the row is then > 20 min old, so the gateway escalates it (`deadline_exceeded`) and opens a fresh session,
   which the client waits on. If the re-post returns the same session, fail with an explicit `stuck` error (no loop).
   The stuck session is never written to `state.json`, so it does not count against `MAX_SESSIONS` (`:36`).
4. Tests (red on base, green with `proposed.patch`): gateway `test/plan-sparring-stuck-session.test.ts` — a model call
   that never resolves ends the pass `deadline_exceeded` at the deadline (base: hangs past the 15 s test timeout);
   `STALE_AFTER_MS` between 15 and 25 min; a 21-min 0-round row is dead, a 19-min one is not. CI
   `scripts/collab/plan-spar.test.mjs` — a stuck first session is re-posted once and the fresh session returned; a
   session still stuck after the re-post fails with `stuck` after exactly 2 posts. Existing suites stay green
   (`plan-sparring-stale-session.test.ts` boundary cases use the constant; `node --test scripts/collab/*.test.mjs`).
5. Sequencing: if #4215 merges first, the lane rebases its `create` change onto #4215's return shape (merge, not
   rebase; one merge at a time, hot file).

## 4. Unchanged (the review is not weakened)
Partner prompts, `submit_review`, the evidence floor, round caps, convergence and escalation rules, `MAX_SESSIONS = 2`
and re-plan semantics, policy approval `converged-auto-v1`, VTID allocation. A stuck session never produced a review,
so replacing it drops no finding; the fresh session runs a full pass.

## 5. Risks
- A live but slow pass older than 20 min would be escalated by a concurrent re-post. With every call bounded by the
  15-min deadline a live pass cannot run that long; its late write is refused (`round_conflict`), never merged.
- Worst-case PLAN-SPAR job time 25 + 25 min, under the job's `timeout-minutes: 120`.
- Deploys the gateway (staging) → STAGING-VERIFY and Gate 2 per the pipeline.
<!-- plan:end -->
