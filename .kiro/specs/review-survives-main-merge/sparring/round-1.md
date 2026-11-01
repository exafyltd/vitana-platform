# Sparring round 1 — in_progress

Session: `631d7483-7ff0-4c30-bcf5-3bf34ebbd482` · plan hash `44767c95415791e5d7bf88e20f22d7cd19e7ed1c6b733561d5673dea765f8333`

## Summary

The plan is technically coherent and most premises about the existing code hold. Three substantive gaps remain: (1) the merge authority is the Project Manager, whose observe-live.ts reviewOnlySince / governance.ts reviewOnCurrentHead stay stricter (a merge commit ends the review walk), so the rule text §3 will say "clean merges count" while the actual PM merger refuses them whenever the PM is live — the stated O(n²) goal is not achieved on the PM path and the normative text diverges from the enforcing code; (2) the mergeKeepsReview protectedFiles check only consults PROTECTED_GATE_PATHS, which (premise 6) excludes .claude/rules/collaboration.md and land-guard.mjs, so a clean merge of main that brings in a change to the governance rule itself is accepted without re-review — a weakening relative to today (where any merge of main voids the review); (3) no caller/completed wiring is specified for the new --repo path, risking dead code. The core mergeKeepsReview/prDiffSame/localAfter design is sound for the plan-driver path.

## Findings

### R1-F1 [major]

The Project Manager is the actual merge authority (§7b), and its observe-live.ts reviewOnlySince + governance.ts reviewOnCurrentHead stay on the old rule (a merge commit is not review-only, so the walk breaks immediately and review_only_since is empty). The plan rewrites collaboration.md §3 to say clean merges of main count, but the PM code that enforces §3 for governance paths will still refuse such PRs with stale_head whenever the PM is live. The stated goal (eliminate the O(n²) re-review) is therefore only achieved on the plan-driver's land-guard.mjs --repo path, not on the PM path, and the normative rule text now contradicts the enforcing code.

- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/observe-live.ts:221` — export async function reviewOnlySince(...) { ... if (!isReviewOnly(parseTrailers(c.message), laneKey)) break; const files = await r.commitFiles(repo, c.sha); if (files.length !== 1 || files[0] !== laneFile) break; ... }
- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:152` — export function reviewOnCurrentHead(r, pr) { if (r.head_sha === pr.head_sha) return true; return (pr.review_only_since ?? []).includes(r.head_sha); }
- `exafyltd/vitana-platform:.claude/rules/collaboration.md:253` — The Project Manager merges a lane PR — and the plan driver (Kiro) applies the same rule while the PM is not live — ... a review entry (§3) is Collab-Verdict: accept ... on the PR's current head

Suggestion: Either (a) follow up the PM observer/governance change in the same plan (it is the enforcement path and leaving it divergent creates a documented rule/code mismatch), or (b) explicitly state in §3 and in the plan's out-of-scope that the PM path remains stricter and will still require a re-review on a main merge, so the claimed O(n²) reduction is limited to the plan-driver path. Do not claim the goal is met repo-wide while the PM (the primary merger) still refuses.

### R1-F2 [major]

mergeKeepsReview guards only against PROTECTED_GATE_PATHS (queue.mjs glob set, mirrored from protected-gate-files.json), which does not include .claude/rules/collaboration.md or scripts/collab/land-guard.mjs (premise 6). A clean merge of main that brings in a change to these governance files — which are not in the PR's own diff paths, so prDiffSame stays true — will be accepted with no re-review. Today any merge of main (including one carrying a governance-rule change) voids the review; the plan silently weakens this for the rule files themselves.

- `exafyltd/vitana-platform:scripts/collab/protected-gate-files.json:4` — "globs": [ "CLAUDE.md", "scripts/collab/plan-spar.mjs", "scripts/collab/queue.mjs", ... ]
- `exafyltd/vitana-platform:scripts/collab/land-guard.mjs:24` — import { globToRegex, PROTECTED_GATE_PATHS } from './queue.mjs';
- `exafyltd/vitana-platform:scripts/collab/land-guard.mjs:76` — export function protectedTouched(files, globs) { return files.filter((f) => globs.some((g) => globToRegex(g).test(f))); }

Suggestion: Add .claude/rules/collaboration.md and scripts/collab/land-guard.mjs (and any other governance rule files) to PROTECTED_GATE_PATHS / protected-gate-files.json, or explicitly extend mergeKeepsReview to refuse a clean merge that changes any §3a governance path, not only PROTECTED_GATE_PATHS.

### R1-F3 [minor]

The --repo local path is only reachable if some caller passes it to land-guard.mjs review|merge. The plan specifies the new CLI flag, usage line and header comment, but does not name the caller (plan-driver.mjs, CI workflow, or Kiro session invocation) that will supply --repo. Without updating the actual invocation, the new behavior is dead code and the O(n²) problem persists in production.

- `exafyltd/vitana-platform:scripts/collab/land-guard.mjs:5` — node scripts/collab/land-guard.mjs review --gh <owner/repo> --pr <n> --reviewed-head <sha> ... node scripts/collab/land-guard.mjs merge --gh <owner/repo> --pr <n> --reviewed-head <sha> ...
- `exafyltd/vitana-platform:scripts/collab/land-guard.mjs:173` — if (cmd === 'review') { need(o, 'gh', 'pr', 'reviewed-head'); ... reviewCurrent(o['reviewed-head'], head, afterCommits(o.gh, ...), ...) }

Suggestion: Name the exact caller(s) and command line that will pass --repo (plan-driver.mjs merge step, the lane-reviewer/preflight invocation, or a workflow), and include a test or acceptance command demonstrating --repo reaches localAfter.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
