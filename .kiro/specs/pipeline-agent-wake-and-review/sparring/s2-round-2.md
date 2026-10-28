# Sparring round 2 — in_progress

Session: `6b473db9-a755-45be-951d-0dba83663ee8` · plan hash `90538c68afe4e828eaaaccb00a56fc04e2ef83517adc598712fde26f76f6ba08`

## Summary

All four R1 findings were accepted and properly addressed in the revision. The plan is significantly improved. I found one new issue regarding the decision to add `agent:vitana-lane-reviewer-independent` to `REVIEWER_AGENTS`, which creates governance-bypass side effects that require explicit mitigations, when not adding it would naturally achieve the plan's stated goals without those risks.

## Findings

### R2-F1 [major]

Adding `agent:vitana-lane-reviewer-independent` to `REVIEWER_AGENTS` (lane 2 point 3a) makes `isReviewerAgent` return true for it, which silently allows governance-path bypasses at two security-relevant sites: `validateLane` line 234 (`globTouchesGovernance(g) && !isReviewerAgent(fm.reviewer_seat)` — the check is skipped) and `scopeCheck` line 701 (`isReviewerAgent(fm.reviewer_seat) && trustedFrom` — governance path bypass granted). The plan says `validateLane` will refuse `reviewer_seat: agent:vitana-lane-reviewer-independent` entirely, but the rejection must be placed before the paths loop at line 231-236; otherwise the governance-path check at line 234 silently passes before the rejection is evaluated. If the independent agent is NOT added to `REVIEWER_AGENTS`, `validateLane` line 224-225 naturally rejects it as an unrecognised reviewer_seat (it's not `'claude'` and fails `SEAT_RE`), and the governance bypasses at lines 234 and 701 never apply. The scopeCheck reviewer rule (line 709-713) can be fixed with a targeted exception for independent sessions on chain-reviewer lanes without broadening `isReviewerAgent`.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:221` — if (fm.reviewer_seat !== undefined) {
      if (isReviewerAgent(fm.reviewer_seat)) {
        if (fm.executor !== 'kiro') e.push(...);
      } else if (fm.reviewer_seat !== 'claude' && !SEAT_RE.test(fm.reviewer_seat)) {
        e.push(...);
      }
      ...
    }
    ...
    if (fm.executor === 'kiro') {
      for (const g of paths) {
        if (globTouchesProtected(g)) e.push(...)
        else if (globTouchesGovernance(g) && !isReviewerAgent(fm.reviewer_seat)) e.push(...)
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:698` — else if (!matchesAny(f, GOVERNANCE_PATHS)) continue;
        else if (fm.executor === 'kiro' && isReviewerAgent(fm.reviewer_seat) && trustedFrom) continue;
        else errors.push(`${f} is a governance path; lane ${key} has executor ${fm.executor || 'unset'} (needs claude, or executor kiro with reviewer_seat ${REVIEWER_AGENTS[0]} from main or an approved plan( PR)`);
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:74` — export const REVIEWER_AGENTS = ['agent:vitana-lane-reviewer'];
export const isReviewerAgent = (v) => REVIEWER_AGENTS.includes(v);

Suggestion: Do not add `agent:vitana-lane-reviewer-independent` to `REVIEWER_AGENTS`. Instead: (a) `validateLane` already naturally rejects it at line 224-225 (not claude, not a seat), so no explicit rejection is needed; (b) in `scopeCheck`'s reviewer rule (line 710-712), add a targeted exception: when `fm.reviewer_seat` is the chain reviewer and `agentOf(k.session)` is `'agent:vitana-lane-reviewer-independent'`, accept the review entry — without broadening `isReviewerAgent`. This preserves defense-in-depth at lines 234 and 701.

## Next

Planner: answer every finding above in `sparring/s2-responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
