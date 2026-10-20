# Tasks — plan-spar-stale-session
Authoritative plan: `plan.md` (this folder). Lane files: `lanes/`.
VTID: allocated by PLAN-SPAR after approval (one per lane).

<!-- lane: stale-session-dedup -->
## stale-session-dedup — re-run dead round-1 sessions (repo vitana-platform)
Allowed paths:
- `services/gateway/src/services/plan-sparring/plan-sparring-service.ts`
- `services/gateway/src/services/plan-sparring/plan-sparring-repository.ts`
- `services/gateway/test/plan-sparring-stale-session.test.ts`
- `docs/validation/<VTID>/**` (the lane's own record and staging suite, rule 47)

- [ ] S1. Repository: add `escalateDeadRoundOne(sb, id, cutoffIso)`, a guarded UPDATE in the style of
  `recordPolicyApproval` (`plan-sparring-repository.ts:165-180`). It sets `verdict 'escalated'`,
  `escalation_reasons ['deadline_exceeded']` and `updated_at`, filtered on `id`, `verdict = 'in_progress'`,
  `updated_at < cutoffIso`, `human_approved_by IS NULL` and `policy_approved_at IS NULL`, and runs `.select('id')`.
  It returns `DbResult<Array<{ id: string }>>`.
- [ ] S2. Service: add `STALE_AFTER_MS = 60 * 60_000` and an exported `isDeadRoundOne(session, nowMs)` (plan item 1).
  Wire it into the create dedup branch (`plan-sparring-service.ts:248-253`): escalate with
  `cutoffIso = new Date(now() - STALE_AFTER_MS).toISOString()`, then insert. On zero
  updated rows, re-read once and return that row with `deduplicated: true` (no insert). A store error becomes
  `SparringError(502, 'store_error')`, as the rest of the file does. Do not touch `RETRYABLE_REASONS` (`:46`):
  the partial-failure recovery (plan item 1, test (h)) relies on `deadline_exceeded` staying in it.
- [ ] S3. Tests in `services/gateway/test/plan-sparring-stale-session.test.ts`: cases (a)–(h) from `plan.md`
  item 3. Copy the repository mock and `makeDeps` pattern from `vtid-04868-plan-sparring-service.test.ts:31-112,209-236`,
  and add `escalateDeadRoundOne` to the mock with the same guards. Seed sessions straight into the store with
  explicit `created_at`/`updated_at`, and drive time with `deps.now`. Exercise the real `escalateDeadRoundOne`
  guard chain with `jest.requireActual` and a recording fake `sb` (assert the filters `eq('verdict','in_progress')`,
  `lt('updated_at', cutoff)`, `is('human_approved_by', null)`, `is('policy_approved_at', null)`). For case (h),
  give the mock's `insertSession` a one-shot error switch (the template mock at `:31-38` always succeeds).
- [ ] S4. `docs/validation/<VTID>/staging-tests.json`, read-only, modelled on `docs/validation/VTID-05236/staging-tests.json`
  (GET `/alive`, GET `/api/v1/vtid/health`), plus the Jest commands in `commands.log`.

Acceptance:
- `cd services/gateway; npx jest test/plan-sparring-stale-session.test.ts test/vtid-04868-plan-sparring-service.test.ts test/vtid-04868-plan-sparring-repository.test.ts` passes.
- `cd services/gateway; npm run typecheck` is clean.
- The diff touches only the allowed paths. No migration, and no change to `scripts/collab/**`.
<!-- lane: stale-session-dedup -->
