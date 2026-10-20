# Sparring round 2 — in_progress

Session: `c73e91d4-70f2-4497-b4aa-4855ab6f6096` · plan hash `07e2b1ce88028c558b3081ac53fa7de7fdb8050b41031c4d21a755ce1c3aadcc`

## Summary

The revision correctly accepts and materially addresses all three round-1 findings. R1-F1 is fixed soundly by adding `governance` to the PERM list (the scopeCheck fold-back would take `governance` from the base revision and reject a self-grant). R1-F3 is fixed by keying the cap on the stable producer (`ci-plan-spar.<slug>`), not the mutable plan hash. R1-F2 (cap observability to the CI) is addressed in intent but has a concrete data-path gap: the CI's gateway client discards the API's top-level `deduplicated` flag and `retry_exhausted` is not currently part of a session, so the plan's stated "records entry.retryable = false" cannot work without also changing `gatewayClient.create` and the session type/columns — which the plan does not name. Separately, the plan locates the validate-side self-grant rejection in `validateLane`, which runs on the head file only and cannot see the base-vs-head change the plan describes; that check must instead live in `validateRange`. The core blocking guard (PERM) is sound, so the validate-side issue is defense-in-depth rather than an actual escape, but it is a correctness gap in the guard the plan explicitly claims.

## Findings

### R2-N1 [major]

The CI-side retry-exhaustion guard in B.3 has no data path today. `plans-spar.ts:50` returns `{ ok, deduplicated, session }`, but `gatewayClient.create()` (plan-spar.mjs:114-121) reads only `r.json.session` and discards the top-level `deduplicated` flag; and `retry_exhausted` is not a field on `SparringSession` (types.ts:123-147) nor in `SESSION_COLUMNS` (repository.ts:39-40). So 'plan-spar.mjs records entry.retryable = false when the create answer is deduplicated or carries retry_exhausted' cannot be implemented as written unless the plan also (a) surfaces `deduplicated` through the client, and (b) adds `retry_exhausted` to the session type, columns, and the dedup return path. Without this, after adding `partner_output_invalid` to the CI's RETRYABLE_REASONS (B.1), `entry.retryable` (plan-spar.mjs:228) is recomputed true from escalation_reasons and the unbounded re-create loop from R1-F2 persists.

- `exafyltd/vitana-platform:services/gateway/src/routes/plans-spar.ts:49` — const { session, deduplicated } = await createSparringSession(req.body, getDeps()); return res.status(deduplicated ? 200 : 201).json({ ok: true, deduplicated, session });
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:114` — async create(body) { const r = await call('POST', '/api/v1/plans/spar', body); if (r.json?.session) return r.json.session.rounds.length >= 1 || r.json.session.verdict !== 'in_progress' ? r.json.session : waitFor(r.json.session.id, 1); if (!lost(r)) throw ...
- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/types.ts:123` — export interface SparringSession { id: string; ... verdict: SparringVerdict; escalation_reasons: string[]; ... }
- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/plan-sparring-repository.ts:39` — const SESSION_COLUMNS = 'id, plan_id, plan_hash, final_plan_hash, producer, change_class, trust_tier, base_ref, rounds, verdict, escalation_reasons, model_log, human_approved_by, human_approved_at, approval_evidence, approval_policy, policy_approved_at, policy_approval_rule, vtid, created_at, updated_at';

Suggestion: Extend the plan to: (1) change `gatewayClient.create` to return `{ session, deduplicated }` (or thread the top-level flag) so plan-spar.mjs can see dedup vs new; (2) add a `retry_exhausted?: boolean` field to `SparringSession`, `SESSION_COLUMNS`, and set it on the dedup-return path; then compute `entry.retryable = (escalation_reasons has retryable) && !deduplicated && !session.retry_exhausted`. Add a test that a third push with the gateway already returning a dedup/retry_exhausted answer does not re-create.

### R2-N2 [major]

A.3a claims 'validate rejects a lane commit that changes governance in a lane file that already exists at the base', but `validateLane` is head-only (queue.mjs:349 passes `showFile(repo, head, p)`), so it cannot compare base vs head to detect a changed `governance` field. The only base-vs-head comparison in validateRange is `checkTransition` at :364, which compares `state` only, not arbitrary front-matter fields. So the validate-side self-grant rejection must be a new check added to `validateRange` (which already computes base/head at :337/:357), not to `validateLane`. As written the plan locates the check in the wrong function; the actual blocking guard (scopeCheck PERM fix) is sound, so this is defense-in-depth, but the claimed validate guard is not implementable where stated.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:346` — for (const p of headFiles) { const c = classifyPath(p); const fm = parseFrontMatter(showFile(repo, head, p)); const e = c.kind === 'plan' ? validatePlan(fm, slug) : validateLane(fm, slug, c.lane, laneIds);
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:174` — if (fm.reviewer_seat !== undefined) { ... } const paths = asList(fm.paths); if (fm.executor && fm.state && ...) e.push(...); if (fm.executor === 'kiro') for (const g of paths) if (globTouchesGovernance(g)) e.push(`paths "${g}" reaches a governance path; such a lane needs executor: claude`); ...
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:356` — const before = parseFrontMatter(showFile(repo, mergeBase, p)); const after = parseFrontMatter(showFile(repo, head, p)); ... for (const x of checkTransition(c.kind, before, after, { allowInitial: allowInitial.includes(c.slug) })) errors.push(`${p}: ${x}`);

Suggestion: Implement the base-vs-head `governance` change detection in `validateRange` (next to the transition check at :364), comparing `before.governance` vs `after.governance` for an existing lane file when the commit that wrote it is a non-`_plan`, non-CI_PLAN_SPAR lane commit. Keep `validateLane`'s A.2 addition (allow `governance: owner` on head for kiro lanes) as the field-shape/validity check, but do not claim it can detect a self-grant; state explicitly that self-grant rejection is in both scopeCheck (PERM) and the new validateRange base-comparison.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
