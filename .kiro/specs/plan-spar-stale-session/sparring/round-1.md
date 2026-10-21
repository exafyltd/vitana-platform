# Sparring round 1 — in_progress

Session: `80edad05-1908-4025-ab32-de26dd7a4700` · plan hash `cd263e99b15d90e62c63bc77deb5bcc2b0116d6a9267ea40e50f99acfc67658d`

## Summary

The plan's core premises are accurate: create-dedup loads the newest session by producer+plan_hash and only re-runs escalated sessions whose reason is RETRYABLE (verified); the session row's updated_at is only advanced by updateSessionState and the BEFORE-UPDATE touch trigger (verified), so a dead round-1 pass leaves rounds=[] and updated_at=created_at; the pass deadline is only checked between model turns (verified), so a single slow invoke has no bound; and later-round death is handled by re-posting (submitPlannerRound has no dedup, verified). The escalation UPDATE writes only verdict/escalation_reasons/updated_at, all of which are in the service_role UPDATE grant (verified). The design is sound for the five stuck rows, which are hours old. The main risk is that the fix ships globally: the arbitrary 10-minute margin plus the client's 25-minute WAIT_MS means a slow-but-alive pass (plausible for standard, and the problem statement itself blames 6 concurrent passes) can be wrongly escalated and a duplicate pass launched — the exact concurrency the plan blames for the original deaths. Two minor items follow.

## Findings

### R1-F1 [major]

The staleness check has no way to distinguish a dead process from a slow-but-alive one, and the chosen margin makes a false positive reachable for standard-class sessions. The deadline is checked only between turns (so a single `invoke` has no upper bound), the margin is a fixed 10 min, and standard therefore escalates after 25 min — exactly the client's WAIT_MS. A standard pass whose one model call runs past 25 min (e.g. primary tier slow then fallback tiers, or an overloaded gateway) will be escalated and a fresh pass started while the original is still running; when the original returns it hits round_conflict (409) and its output is discarded. This launches concurrent passes — the same condition the problem statement blames for the original deaths — and wastes a full round-1 review for that plan's session budget.

- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/partner.ts:173` — for (let turn = 1; turn <= PARTNER_MAX_TURNS_PER_ROUND; turn++) { if (now() - startedAt > input.deadlineMs) return fail('deadline_exceeded', ...); ... for (;;) { const tier = tiers[tierIndex]; const t0 = now(); r = await invoke(prompt, tier);
- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/plan-sparring-service.ts:44` — const PASS_DEADLINE_MS: Record<ChangeClass, number> = { light: 10 * 60_000, standard: 15 * 60_000, expedited: 5 * 60_000 };
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:37` — const WAIT_MS = 25 * 60_000;

Suggestion: Recognize that this only affects the five hours-old rows and is a non-issue there, but for the general path either (a) bound the false-positive window by making the escalated verdict no more than a fresh re-run with the same pass (already true) AND document that a slow pass will 409; or (b) reduce the false-positive blast radius by considering `model_log` presence / a larger margin, or (c) accept the cost explicitly and note that the duplicate-pass race is benign (new session wins, old 409s) in the plan rationale so the trade-off is recorded.

### R1-F2 [minor]

The escalation UPDATE and the subsequent insertSession are not atomic. If escalation succeeds but insertSession throws (store error), the old row is left `escalated` with `deadline_exceeded` and `final_plan_hash = null` — a row that can never be approved and has no successor yet. Recovery then depends on the indirect retryable branch (deadline_exceeded ∈ RETRYABLE_REASONS) on the next create call rather than the new in_progress branch. This is self-healing but relies on a separate code path the plan describes as 'unchanged'.

- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/plan-sparring-service.ts:250` — const retryable = !e.human_approved_by && e.verdict === 'escalated' && (e.escalation_reasons ?? []).some((r) => RETRYABLE_REASONS.includes(r)); if (!retryable) return { session: e, deduplicated: true };
- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/plan-sparring-service.ts:445` — if (!session.final_plan_hash || b.final_plan_hash !== session.final_plan_hash) throw new SparringError(409, 'final_plan_hash_mismatch');

Suggestion: Either order insert-before-escalate or treat the escalated-orphan on error as retryable (it already is via deadline_exceeded), and add a test case asserting that a store error between escalate and insert recovers on the next create without terminalizing the plan.

### R1-F3 [minor]

The verification command references `test/vtid-04868-plan-sparring-service.test.ts` and `test/vtid-04868-plan-sparring-repository.test.ts`, and the plan cites the mock template at `vtid-04868-plan-sparring-service.test.ts:31-112`. Under the pinned test directory I could only confirm `services/gateway/test/plans-spar.test.ts` (which mocks the service module) and `services/gateway/test/vtid-04868-plan-sparring-migration.test.ts` via search; the specific service/repository test files were not located (the directory listing was truncated at ~200 files before the `v` prefix). If those files do not exist at the pinned commit, the verification command and the 'must stay green' assertion cannot be run.

- `exafyltd/vitana-platform:services/gateway/test/plans-spar.test.ts:43` — jest.mock('../src/services/plan-sparring/plan-sparring-service', () => { const actual = jest.requireActual('../src/services/plan-sparring/plan-sparring-service'); return { SparringError: actual.SparringError, ... createSparringSession: (...a) => svc.createSparringSession(...a), ... }
- `exafyltd/vitana-platform:services/gateway/test/vtid-04868-plan-sparring-migration.test.ts:1`

Suggestion: Confirm the exact filenames of the existing service/repository test suites at the pinned commit and update the change item 3 and the verification command to reference them precisely, or state that the reference is to the production test suite directory listing beyond the truncation.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
