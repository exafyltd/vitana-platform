# VTID-05273 — plan-spar-allocation: local test evidence

Lane `kiro-autonomy-fallback/plan-spar-allocation` (plan §5 B). Changes `scripts/collab/plan-spar.mjs` and
`scripts/collab/plan-spar.test.mjs` only. CI script only: deploys nothing, so there is no staging suite and no Gate 2.

## Red on the base (origin/main 422a7b0, new tests + unchanged plan-spar.mjs)
`node --test scripts/collab/plan-spar.test.mjs` → tests 19, pass 12, fail 7.

| Test | Base |
|---|---|
| late lane: a converged, policy-approved plan allocates a lane added after convergence | fail (`nothing_to_do`) |
| late lane: the retry never re-sends the sparring id once the session is bound | fail (no retry allocation) |
| no lanes at convergence: handoff goes to kiro with reason lanes_missing, not "allocation is off" | fail (`next_actor: claude`) |
| lanes added later to a lane-less converged plan: first lane gets the bound VTID | fail (`nothing_to_do`) |
| allocation failure keeps the VTIDs already allocated and retries the rest on the next run | fail (step rejects) |
| orphaned bound VTID is adopted, not re-allocated | fail (`nothing_to_do`) |
| retry refuses a state.json that names another plan's session | fail (resolves, no reject) |
| retry with every lane allocated is a no-op with zero writes | pass (guard) |
| allocation off: a converged plan with a late lane is not retried and still goes to claude | pass (guard) |

## Green on the lane branch
- `node --test scripts/collab/plan-spar.test.mjs` → tests 19, pass 19, fail 0 (the 10 existing tests unchanged).
- `node --test scripts/collab/queue.test.mjs` → tests 30, pass 29, fail 1 locally on Windows: test 25 ("programme
  registry …") spawns `node \C:\…\queue.mjs` (a `URL.pathname` path, so `C:\C:\…` on Windows). `queue.mjs` and
  `queue.test.mjs` are not changed by this lane; the test runs on Linux in CI.

## Behaviour proven
- A lane without `vtid` on a converged, policy-approved plan gets one on any later PLAN-SPAR run (`allocate_retry`),
  after the live session is verified (producer `ci-plan-spar.<slug>`, `converged`, `policy_approved_at`, same
  `final_plan_hash`); no new round, no new session.
- `sparring_id` + `plan_hash` are sent at most once per session (only while the live session has no `vtid`); an
  orphaned bound VTID is adopted with zero allocate calls.
- A failed allocation keeps what was written, resolves (exit 0), `reason: allocation_pending`, `next_actor: kiro`; the
  next run allocates the rest unbound and clears `reason`.
- No lanes at convergence → `state: sparred`, `next_actor: kiro`, `reason: lanes_missing`; allocation off → `claude`.
- Every lane allocated → `nothing_to_do`, `wrote: []`, no gateway call (no commit loop).
