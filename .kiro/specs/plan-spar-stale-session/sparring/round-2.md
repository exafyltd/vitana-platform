# Sparring round 2 — converged

Session: `80edad05-1908-4025-ab32-de26dd7a4700` · plan hash `e66ff018195c817cd5e6d2e2460f56adc975c19381ba9e37b0e604c451610a56`

## Summary

The revised plan correctly addresses R1-F1 (60-min flat staleness threshold, documented residual trade-off) and R1-F2 (explicit dependency on `deadline_exceeded` remaining in `RETRYABLE_REASONS`, test (h)). The R1-F3 rejection is sound — both test files exist at the pinned commit. Two minor gaps remain: the existing service-test mock will be incomplete after the change, and the plan is silent on DB-error handling in the new code path.

## Findings

### R2-F1 [minor]

The existing `vtid-04868-plan-sparring-service.test.ts` mock (lines 31-112) will not include `escalateDeadRoundOne` after the change. The plan says the existing suite must stay green, and it will — but only because `makeDeps` always pins `now: () => 1_700_000_000_000` (line 228) and mock sessions receive `created_at: new Date(1_700_000_000_000 + idSeq)` (line 36), keeping every mock session within milliseconds of `now()`, far below `STALE_AFTER_MS`. The plan does not document this invariant. `idSeq` is also not reset in `beforeEach` (lines 238-248), so it accumulates across tests; at present the offset is negligible, but the reasoning is invisible to future contributors. Any test added to the existing file that uses an old absolute timestamp or overrides `deps.now` to a real-time value would hit `TypeError: repo.escalateDeadRoundOne is not a function` rather than a meaningful assertion failure.

- `exafyltd/vitana-platform:services/gateway/test/vtid-04868-plan-sparring-service.test.ts:31` — jest.mock('../src/services/plan-sparring/plan-sparring-repository', () => ({ insertSession: ..., fetchSession: ..., fetchSessionByPlanHash: ..., appendRound: ..., updateSessionState: ..., recordApproval: ..., recordPolicyApproval: ..., ... }));
- `exafyltd/vitana-platform:services/gateway/test/vtid-04868-plan-sparring-service.test.ts:228` — now: () => 1_700_000_000_000,
- `exafyltd/vitana-platform:services/gateway/test/vtid-04868-plan-sparring-service.test.ts:36` — created_at: new Date(1_700_000_000_000 + idSeq).toISOString()
- `exafyltd/vitana-platform:services/gateway/test/vtid-04868-plan-sparring-service.test.ts:238` — beforeEach(() => { store.sessions.clear(); store.ledger = []; ... }); // idSeq not reset

Suggestion: Add a no-op (or throw-unexpected-call) stub for `escalateDeadRoundOne` to the existing mock at lines 31-112, and add a brief comment explaining that `now` is pinned to match the mock timestamps so `isDeadRoundOne` never fires in the existing suite. This makes the mock self-documenting and prevents a confusing TypeError if the invariant is ever broken.

### R2-F2 [minor]

The plan describes two outcomes of `escalateDeadRoundOne` in the service (updated > 0 → proceed to insert; updated = 0 → re-read and return deduplicated) but is entirely silent on the third case: `escalateDeadRoundOne` itself returns a DB error. Every other repository call in `createSparringSession` checks `.error` and throws `SparringError(502, 'store_error', ...)`. The plan's items 1 and 2 omit this branch, and none of tests (a)–(h) covers it. An unhandled DB error here would propagate as an uncaught rejection and surface as an HTTP 500 with no structured error code, inconsistent with every other error path in the function.

- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/plan-sparring-service.ts:246` — const existing = await repo.fetchSessionByPlanHash(deps.sb, input.producer, plan.hash); if (existing.error) throw new SparringError(502, 'store_error', existing.error.message); if (existing.data) { ... const retryable = ...; if (!retryable) return { session: e, deduplicated: true }; }
- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/plan-sparring-service.ts:264` — if (ins.error || !ins.data) throw new SparringError(502, 'store_error', ins.error?.message ?? 'insert returned no row');

Suggestion: In the service code, add `if (upd.error) throw new SparringError(502, 'store_error', upd.error.message)` immediately after the `escalateDeadRoundOne` call, consistent with every other repository call in the function. Add a test case (i): `escalateDeadRoundOne` returns a DB error, the call throws 502 `store_error`, and neither a new session nor a re-read is attempted.

## Acknowledgements of earlier responses

- R1-F3: acknowledged — Both files confirmed at the pinned commit: `vtid-04868-plan-sparring-service.test.ts` (990 lines) and `vtid-04868-plan-sparring-repository.test.ts` (117 lines). The Round 1 listing was truncated before the `v` prefix. The rejection rationale is sound.
