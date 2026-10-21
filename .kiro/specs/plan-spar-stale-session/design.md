# Design — plan-spar-stale-session

## What exists (read these, do not copy them)
- `services/gateway/src/services/plan-sparring/plan-sparring-service.ts`
  - `:44` `PASS_DEADLINE_MS`; `:46` `RETRYABLE_REASONS`.
  - `:222-236` `writeRound`: append via RPC (refused unless in_progress + expected round), then state update.
  - `:238-305` `createSparringSession`: dedup at `:246-253`, insert at `:255-265`, round 1 at `:280-303`.
  - `:332-415` `submitPlannerRound`: no dedup; a dead round-n pass is re-run by resubmitting (plan premise 5).
- `services/gateway/src/services/plan-sparring/plan-sparring-repository.ts`
  - `:39-40` `SESSION_COLUMNS` (has `created_at`, `updated_at`, `policy_approved_at`).
  - `:75-89` `fetchSessionByPlanHash`; `:125-140` `updateSessionState`; `:165-180` `recordPolicyApproval`
    shows the guarded-update + `.select('id')` pattern to copy.
- `services/gateway/src/services/plan-sparring/partner.ts:174`: the deadline is checked between turns only.
- `services/gateway/src/services/plan-sparring/types.ts:19-26` `EscalationReason` already contains
  `deadline_exceeded`; `:123-146` `SparringSession` has `created_at?`/`updated_at?`.
- `supabase/migrations/20261004110000_vtid_04868_plan_sparring_gate.sql:97-106` (verdict CHECK, `updated_at`),
  `:146-161` (touch trigger), `:180-182` (service_role UPDATE grants include verdict, escalation_reasons, updated_at).
- `scripts/collab/plan-spar.mjs:34-37,103-129,188-231`: the client's retry / wait behaviour. Not changed.
- Test pattern: `services/gateway/test/vtid-04868-plan-sparring-service.test.ts:31-112` (in-memory repository
  mock), `:209-236` (`makeDeps`, `createBody`), `:415-440` (dedup and retry cases).

## Decisions
- **Where:** only the create dedup branch. That is the one place a dead session is kept alive. A reaper would
  need a scheduler and its own failure handling, for no extra coverage.
- **Signal:** `rounds.length === 0` plus age of `updated_at ?? created_at`. Sessions waiting on the planner
  (`rounds ≥ 1`) can legitimately stay `in_progress` for days, so they are excluded.
- **Threshold:** a flat `STALE_AFTER_MS = 60 min` for every change class. A dead pass and a slow live pass
  look the same on the row (no heartbeat; `model_log` is written only after the pass, `service.ts:294,301`).
  The deadline is soft (checked between turns, `partner.ts:174`) and one Bedrock call has no request timeout
  (`providers/bedrock.ts:218-229`). 60 min leaves 45 min past the longest deadline (standard, 15 min), so a
  false positive is practically unreachable. If one happens anyway, the old pass ends in 409 `round_conflict`
  and only that pass is wasted (plan item 1, residual trade-off). Cost: a newly dead session recovers on the
  first push 60 min or more after creation.
- **Partial failure:** escalate succeeds, insert fails → 502; the orphan `escalated` + `deadline_exceeded`
  row is re-run by the existing retryable branch (`service.ts:250-252`) on the next create (test (h)).
  Escalate stays before insert because the guarded UPDATE is what serialises two racing creates.
- **Terminal state for the dead row:** `escalated` + `deadline_exceeded`. That reason already means "no real
  review happened, re-run" in the gateway (`RETRYABLE_REASONS`) and in the client (`INFRA_REASONS` and
  `RETRYABLE_REASONS`). `final_plan_hash` stays null, so the row can never be approved.
- **Race:** a guarded UPDATE with `.select('id')`. The losing request re-reads once and returns that row with no
  insert. If the winner has not inserted yet, the row is the escalated `deadline_exceeded` one, which the
  client retries on the next push. A revived old pass is refused by the append RPC because the session is no longer `in_progress`.
- **Clock:** `deps.now ?? Date.now`, the same injection the service already uses, so tests are deterministic.

## Flow (create)
```
existing = fetchSessionByPlanHash(producer, hash)
if existing:
  if isDeadRoundOne(existing, now):
     upd = escalateDeadRoundOne(existing.id, cutoffIso)
     if upd.ids is empty: return { fetchSessionByPlanHash(...) again, deduplicated: true }   # lost race, no insert
  else if not retryable(existing): return { existing, deduplicated: true }
insert + round 1 (unchanged)
```
