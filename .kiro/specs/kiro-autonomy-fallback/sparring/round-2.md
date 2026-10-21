# Sparring round 2 — converged

Session: `697e758a-de29-42e1-831b-b85c35bae398` · plan hash `451fd850e1b43446af98b9414d847ece2c77744c595f3df5898e602ccdf686db`

## Summary

Round 2 review. All seven prior findings were ACCEPTED (none rejected/deferred), and I verified the revised plan substantively addresses each. Key premises re-verified against the pinned code: (1) `pm_lease` migration exists at `20261015180000_vtid_05214_plan_sparring_policy_approval.sql:222-240` with seed row and RLS grants — R1-F1 block removed; (2) `/mode` public route separation is implementable against `routes/project-manager.ts:25` (auth-gated `/status`); (3) the vtid-05077 pin mismatch is real (`test:212` expects `…20261120-vtid-05148`, `index.html:32` serves `…20261121-vtid-05082`); (4) `REQUIRED_MERGE_CHECKS` still names 'Collab handoff' as a continue-on-error step, consistent with §2.2 and the D lane's plan to promote it to a real job; (5) the `guard.cjs` `check()` returns early when no `.kiro/steering/*.md` files, and v1 has its own steering, so the new `checkAgents` gating on `scripts/collab/queue.mjs` presence is sound. I found no blocker or major new defect. One minor and one informational observation are recorded.

## Findings

### R2-F1 [minor]

B lane's `step()` new `allocate_retry` branch is gated on `policy_approved_at` being present, but the current `step()` only records `policy_approved_at` on the state entry via the `session.policy_approved_at` field (plan-spar.mjs:230), and the converged branch that sets `action = 'allocate_retry'` must read the OLD converged state entry (already written on a prior run), not the current 'nothing_to_do' short-circuit at :218-219. The plan says the new branch goes 'before :218', which is exactly where `cur.verdict !== 'in_progress'` falls into the `else` returning `nothing_to_do` today — so the retry branch MUST also handle the case where `cur.verdict === 'converged'` (not just 'in_progress'), otherwise a converged+approved session with an unallocated lane still returns `nothing_to_do` and never retries. The plan text specifies the branch reads `client.get(cur.id)` and checks `converged` + `policy_approved_at` + `final_plan_hash`, which is correct IF the branch is reachable for verdict 'converged' — but the existing code path at :204 (`in_progress`) and :218 (`else`) means the plan should explicitly state the retry branch intercepts the `converged` verdict path, not merely 'before :218'. This is a precision gap, not a defect in the design.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:204` — } else if (cur.verdict === 'in_progress') { ... } else { return { action: 'nothing_to_do', wrote };
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:218` — } else { return { action: 'nothing_to_do', wrote };

Suggestion: State explicitly that the `allocate_retry` branch intercepts the `cur.verdict === 'converged'` state (the current `else`/`nothing_to_do` path), and that its eligibility derives from the persisted state entry's `policy_approved_at` + `final_plan_hash` rather than the live round session, so a converged plan with a late-added lane is actually re-entered.

### R2-F2 [minor]

The bootstrap (§6) sets `executor: claude` on governance-path lanes (steering-rules, plan-spar-allocation, scope-check, exceptions-seat, pipeline-speed) to satisfy today's `validateLane` (queue.mjs:180) and scope-check (queue.mjs:471), and gives every lane a Kiro `seat` with a different Kiro `reviewer_seat`. But `validateLane` (queue.mjs:176) also rejects `reviewer_seat === seat`, and `scopeCheck` review rule (queue.mjs:479) requires a `session_…` review entry when `reviewer_seat === 'claude'`. Since these lanes are `executor: claude` but reviewed by a Kiro seat (the plan says 'never from another Kiro seat' but the D/A changes that allow `reviewer_seat: agent:vitana-lane-reviewer` with `executor: kiro` are NOT yet on main during bootstrap), the review entry committed under the legacy `reviewer_seat` id must satisfy the OLD rule — which for a non-'claude' reviewer_seat requires the review session's seat to equal reviewer_seat (queue.mjs:479). The plan states the review entry is 'committed by the calling Kiro session under the legacy reviewer_seat id', which is consistent, but the bootstrap depends on D (scope-check) landing to relax `executor: kiro` for governance paths; until then these lanes are `executor: claude` and the agent review is a Kiro seat, which today's `scopeCheck:479` would REJECT as 'review entry from <kiro seat>, but reviewer_seat is claude'. The plan's mitigation is the `--admin` Lane-scope false-positive row (§6 table), which this instance qualifies for — but the plan should make explicit that the agent-review-on-governance bootstrap merges are precisely the Lane-scope false positives that `--admin` covers, so there is a single coherent story.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:479` — const ok = fm.reviewer_seat === 'claude' ? /^session_/.test(k.session) : !fm.reviewer_seat || seat === fm.reviewer_seat;
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:180` — if (fm.executor === 'kiro') for (const g of paths) if (globTouchesGovernance(g)) e.push(...needs executor: claude...)

Suggestion: Add one sentence to §6 stating that the agent-review entries on the `executor: claude` bootstrap lanes are the Lane-scope false positives the `--admin` row is scoped for (the old rule requires a `session_` review for `reviewer_seat: claude`), so the override is precisely bounded and the Kiro-seat review is not silently treated as a legacy claude review.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Premise corrected: the pm_lease table IS created by the migration named in the finding; the revised plan cites the exact file/lines and adds the F precondition (require last_lease acquired before claiming proof). Verified the migration directly.
- R1-F2: acknowledged — The single merge-authority table cleanly separates PM safe-merge (never workflow files), plain gh pr merge under owner instruction, and --admin strictly for Lane-scope false positives. Coherent.
- R1-F3: acknowledged — /mode returns exactly {ok, enabled, mode, executor_mode}; claude detail stays behind auth-gated /status. Deliberate residual documented.
- R1-F4: acknowledged — Trailer cutover pinned to 70d6af401 with git trailer verification; proof asserts both actor ids and trailer content across the window.
- R1-F5: acknowledged — Verified the test pin (20261120-vtid-05148) is stale vs served pin (20261121-vtid-05082); H0 edits only the test literal + adds a chip assertion, deterministic single ownership.
- R1-F6: acknowledged — Only 'validate' is required; rollup keeps its name 'Test Suite Summary'; merge rule treats all shards + union + summary as green requirement. No required-check gap.
- R1-F7: acknowledged — PROTECTED_GATE_GLOBS is a compiled-in constant (runtime never reads the JSON); pm-fallback depends_on scope-check so ordering is enforced; legacy claude guard stays until both land.
