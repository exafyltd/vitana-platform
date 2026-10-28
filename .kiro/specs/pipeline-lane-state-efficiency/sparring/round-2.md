# Sparring round 2 — converged

Session: `d42e6d11-da3b-4667-a583-5fa34778196f` · plan hash `8abacc490633f41f780b76b51720b91c06560edd8bc3655568548888e38c2271`

## Summary

The revised plan adequately addresses all three accepted findings from Round 1. R1-F1's `parked_from` tracking through the chain is now described clearly. R1-F2's merge-sha evidence rule now accepts both conventions and both entry locations. R1-F3's test matrix now includes intermediate-parked valid and invalid cases. One minor new finding on a wrong line reference. The plan is otherwise sound: the security model (§3.3 requiring `Collab-Review` commits to back review entries in chains) is well-designed, the ci-plan-spar exception is properly insulated from the new code path, and the append-only log check mirrors the proven pattern in `pmAgentOverreach`.

## Findings

### R2-F1 [minor]

§3.3 cites `:597` as the reviewer's authorization check, but line 597 is `if (id === PLAN_LANE) continue;` (the plan-lane skip inside the session-per-lane loop). The actual reviewer authorization — the rule that a review commit may only append to a lane log without changing front matter — is at line 590: `if (c.kind === 'lane' && k.review === key && !frontMatterChanged(repo, k.sha, f)) continue;`.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:590` — if (c.kind === 'lane' && k.review === key && !frontMatterChanged(repo, k.sha, f)) continue; // reviewer appends a log entry
        errors.push(...);
      }
    }
    for (const [lane, sessions] of sessionsByLane) {
      if (sessions.size > 1) errors.push(...);
      const [slug, id] = lane.split('/');
      if (id === PLAN_LANE) continue;

Suggestion: Update the line reference in §3.3 from `:597` to `:590`.
