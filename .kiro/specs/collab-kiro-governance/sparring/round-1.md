# Sparring round 1 — in_progress

Session: `c73e91d4-70f2-4497-b4aa-4855ab6f6096` · plan hash `2b2288e515608b8ea2ccb680593d7a7d08b1621847922a0430d396e31f979dc5`

## Summary

I verified the plan's core premises against the pinned code. The infrastructure claims hold: GOVERNANCE_PATHS (queue.mjs:69), validateLane governance rejection (queue.mjs:180), scopeCheck governance rejection (queue.mjs:471), the partner_output_invalid failure paths (partner.ts:212/279/285), the two RETRYABLE_REASONS lists and the dedup gate (plan-spar.mjs:34-35, plan-sparring-service.ts:46,246-252), and the pinned test (plan-spar.test.mjs:193). Two substantive defects: (1) the plan's central safety claim — that the base-revision rule prevents a lane from self-granting `governance: owner` — is false, because `governance` is not in the PERM list (queue.mjs:453) nor folded back (queue.mjs:460) nor covered by validateLane (which runs on head, queue.mjs:349); this is a blocker that voids the whole Change A safety model. (2) the Change B "2 retries" loop guard lives only on the gateway side, but the CI computes its own retryability from escalation_reasons (plan-spar.mjs:227-228), which the gateway never mutates, so the CI-side retry loop is effectively unbounded rather than capped at 2 — the plan would keep re-retrying instead of returning to "waits as today."

## Findings

### R1-F1 [blocker]

The plan's claim (Change A3) that 'the base-revision rule applies unchanged, so a lane PR cannot add governance: owner to itself' is false. The `governance` field is not in the PERM list, so an existing lane can self-grant `governance: owner` in its own PR and thereby touch governance paths.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:450` — const PERM = ['executor', 'seat', 'reviewer_seat', 'paths'];
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:460` — if (!(baseFm.executor === 'claude' && claudeOnly)) fm = { ...fm, ...Object.fromEntries(PERM.map((k) => [k, baseFm[k]])) };
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:446` — let fm = parseFrontMatter(text) || {};  // head revision

Suggestion: Add `governance` to the PERM list in scopeCheck (queue.mjs ~line 453) so a lane PR that changes/mutates `governance` is rejected unless it is already `governance: owner` on the base revision, and also guard validateLane (which runs on head, queue.mjs:349) against a lane setting `governance: owner` when the base revision does not carry it. Without this, a Kiro lane can self-grant governance access, exactly the 'Kiro changing its own guard rails' risk the plan claims is bounded.

### R1-F2 [major]

The 'at most 2 automatic retries' loop guard is enforced only on the gateway side and is not observable by the CI. The CI computes retryability from the session's escalation_reasons (which still contain partner_output_invalid), so after the gateway stops creating new sessions (dedup), the CI keeps popping and re-creating on every push instead of settling into 'waits as today'.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:188` — const retryInfra = cur && cur.verdict === 'escalated' && cur.infra && cur.retryable;
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:227` — entry.infra = (session.escalation_reasons ?? []).some((x) => INFRA_REASONS.includes(x));
entry.retryable = (session.escalation_reasons ?? []).some((x) => RETRYABLE_REASONS.includes(x));
- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/plan-sparring-service.ts:250` — const retryable = !e.human_approved_by && e.verdict === 'escalated' && (e.escalation_reasons ?? []).some((r) => RETRYABLE_REASONS.includes(r));
if (!retryable) return { session: e, deduplicated: true };

Suggestion: Make the cap observable to the CI. Either the gateway returns a flag in the create response (or a distinct escalation_reason/value) that the CI reads to stop retrying, or the CI tracks the retry count per plan hash itself (from the gateway session count). Otherwise the CI-side retry loop is unbounded and the plan never returns to the 'wait for Claude' terminal state, defeating the stated goal.

### R1-F3 [minor]

The retry cap is keyed on plan hash, but the CI re-sends the current plan.md text on each retry. If the planner edits plan.md between retries (not required to have a round to respond to when the partner never submitted a review), the hash changes and the per-hash retry count resets, bypassing the cap.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:194` — session = await client.create({ plan_text: planText, ... });
- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/plan-sparring-service.ts:243` — const plan = canonicalPlanHash(input.plan_text); ... const existing = await repo.fetchSessionByPlanHash(deps.sb, input.producer, plan.hash);

Suggestion: Consider keying the retry cap on producer (and perhaps a stable plan identity) rather than the mutable plan hash, or document the accepted risk. This is a design nuance, not a blocker.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
