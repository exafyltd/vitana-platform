# Sparring round 1 — in_progress

Session: `87068fbf-b3ce-4623-94c3-a8e18b3e28fd` · plan hash `65f4323924c61a806f9868362fa98a3b1139054f65fabd82386c4296f336ffc5`

## Summary

Plan review round 1 for autonomous-to-staging-r2. I verified the key premises about existing code (protected file lists, land-guard merge logic, staging workflows, governance.ts). Most premises hold. I found one significant issue with the gate-audit permissions model and a few minor items.

## Findings

### R1-F1 [major]

The plan's §3.1.3 gate-audit step needs `pull-requests: read` on the GITHUB_TOKEN to call `repos/{gh}/pulls/{pr}/files` and `repos/{gh}/pulls/{pr}/commits` via the GitHub API (it imports land-guard.mjs functions that use `gh api`). The current workflow has `permissions: contents: read` only (line 14). The plan says the audit uses `GITHUB_TOKEN` with `contents: read, pull-requests: read`, but the existing static test `workflow-trigger-check.test.mjs` at line 38 enforces `permissions:\s*\n\s+contents:\s*read\s*$` — a single-entry permissions block. Adding `pull-requests: read` on the next line would still match (because `$` with `m` flag matches end-of-line), so the *current* regex would not catch the change. However, the plan also adds a `report` job that uses `secrets.GATEWAY_SERVICE_TOKEN`, which the current line 39 check (`/secrets\./.test(yaml)`) would reject globally. The plan acknowledges the test must be updated to 'allow a secret only in job report', but the updated test must also positively assert `pull-requests: read` is present (the audit depends on it) and assert that no other permission is granted. Without specifying the exact new assertions, the implementer could either break the audit (by forgetting `pull-requests: read`) or weaken the gate (by allowing broader permissions).

- `exafyltd/vitana-platform:.github/workflows/GATE-INVARIANTS.yml:14` — permissions:
  contents: read
- `exafyltd/vitana-platform:scripts/ci/workflow-trigger-check.test.mjs:38` — if (!/^permissions:\s*\n\s+contents:\s*read\s*$/m.test(yaml)) problems.push('top-level permissions are not contents: read');
    if (/secrets\./.test(yaml)) problems.push('uses a secret (must be read-only, no credentials)');

Suggestion: Specify in the plan that `workflow-trigger-check.test.mjs` must: (1) assert top-level permissions are exactly `contents: read` + `pull-requests: read` and nothing else (tighten the regex or parse YAML); (2) assert that `secrets.` appears only in job `report`'s steps (not globally); (3) assert that job `report` has `if: failure()` and `needs: [invariants]`. Add these as explicit test cases in §5.

### R1-F2 [major]

The plan's §3.1.2 exact-head rule says 'every commit after it changes only the lane's own lane file (no merge commit, no other path)' for protected-file PRs with two accepts. But the plan's condition (c) says 'git diff of the protected paths between merge-base and reviewed head is byte-identical to that between merge-base and merged head'. These two rules conflict: (c) would allow a merge-of-main after the accepts if the merge doesn't change the protected bytes, but the 'no merge commit' phrase forbids it outright. The plan also says 'A PR brought up to date with main after the accepts needs new accepts on the new head (an automatic merge of main no longer carries a protected-file accept forward)' — which aligns with the stricter 'no merge commit' reading. But the current `reviewCurrent` (line 63-85) already allows merges of main when `prDiffSame === true` and `mergeKeepsReview` passes. If the plan truly wants NO merge commits at all for protected-file PRs, it must explicitly override `reviewCurrent` behavior rather than reuse it. Clarify whether merges of main are allowed (with byte-identical protected files) or forbidden entirely for protected-file PRs.

- `exafyltd/vitana-platform:scripts/collab/land-guard.mjs:63` — export function reviewCurrent(reviewed, head, after, laneKey, prDiffSame) {
    if (reviewed === head) return { ok: true, reason: 'reviewed head is the PR head' };
    ...
      if (c.merge) {
        const m = mergeKeepsReview(c.merge);
        if (!m.ok) return { ok: false, reason: ... };
        if (prDiffSame !== true) return { ok: false, reason: ... };
        merges++;
        continue;
      }

Suggestion: Clarify the rule: either (a) protected-file PRs reject ALL commits after the reviewed head except lane-file-only commits (no merges of main), requiring rebasing or new reviews; or (b) merges of main are allowed when the protected-file bytes are identical. State which one, and ensure both land-guard and governance.ts apply the same rule. If (a), the plan must note this is a behavioral change from `reviewCurrent`'s current logic and specify how it's implemented (override, wrapper, or flag).

### R1-F3 [minor]

The plan §3.1.2 introduces a self-review exclusion based on `Collab-Session` ids: 'neither of which is a session in the lane's executing log entries'. But the current `parseReviewEntry` (line 127-131) does not parse `Collab-Session` from commit messages — it only extracts `Collab-Review`, `Collab-Verdict`, `Collab-Reviewer`, and `Collab-Reviewed-Head`. The `session` field is parsed separately in `localAfter` (line 202) and `afterCommits` (line 179) for the walk, not for review entries. The plan should note that `parseReviewEntry` must be extended to include `Collab-Session`, and the `protectedAcceptModels` functions in both land-guard.mjs and governance.ts must be updated to consume and check it.

- `exafyltd/vitana-platform:scripts/collab/land-guard.mjs:126` — export function parseReviewEntry(message) {
    const get = (k) => (new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(message || '') || [])[1]?.trim();
    const review = get('Collab-Review');
    if (!review) return null;
    return { review, verdict: get('Collab-Verdict'), reviewer: get('Collab-Reviewer'), reviewedHead: get('Collab-Reviewed-Head') };
  }
- `exafyltd/vitana-platform:scripts/collab/land-guard.mjs:117` — export function protectedAcceptModels(entries) {
    const models = new Set();
    for (const e of entries || []) {
      if (!e || e.verdict !== 'accept' || !e.current) continue;
      const m = new RegExp(...);
      if (m && REVIEWER_MODELS.includes(m[1])) models.add(m[1]);
    }
    return [...models];
  }

Suggestion: Note in the plan that `parseReviewEntry` must be extended to extract `Collab-Session`, and that `protectedAcceptModels` in both land-guard.mjs (line 117) and governance.ts (line 67) must implement the distinct-session and self-review-exclusion checks. Include these in the shared fixture cases.

### R1-F4 [minor]

The plan §3.1.3 says gate-audit.mjs 'applies the same land-guard.mjs functions (imported, not copied)'. But land-guard.mjs's `protectedAcceptModels` (line 117-124) and the merge command's review-entry collection (lines 316-333) rely on `reviewWalk` which needs either a local checkout (`--repo`) or the GitHub API. The gate-audit script auditing historical merges would need to reconstruct the `after` walk for each historical merge's review entries. The plan should clarify how `gate-audit.mjs` gets the data for historical PRs — does it clone the repo (expensive for 14 days of merges), use the API walk (which the plan just identified as insufficient for protected-file checks because `prDiffSame` is undefined), or use a different approach?

- `exafyltd/vitana-platform:scripts/collab/land-guard.mjs:315` — if (protectedFiles.length && review.ok) {
          const commits = [];
          ...
          for (const c of commits) {
            const e = parseReviewEntry(c.commit?.message);
            ...
            if (!memo.has(e.reviewedHead)) {
              const w = reviewWalk(o, e.reviewedHead, head, key);
              memo.set(e.reviewedHead, reviewCurrent(e.reviewedHead, head, w.after, key, w.prDiffSame).ok);
            }
            entries.push({ ...e, current: memo.get(e.reviewedHead) });
          }
- `exafyltd/vitana-platform:scripts/collab/land-guard.mjs:230` — function reviewWalk(o, reviewed, head, laneKey) {
    if (!o.repo || o.repo === true) return { after: afterCommits(o.gh, reviewed, head), prDiffSame: undefined };
    prepareLocal(o.repo, o.gh, o.pr, head);
    return localAfter(o.repo, reviewed, head, laneKey);
  }

Suggestion: Clarify the audit's walk strategy: either (a) checkout is required (and the GATE-INVARIANTS.yml step uses `actions/checkout` with sufficient depth), or (b) the audit uses the local checkout already present (the workflow already checks out the repo at line 25), using `localAfter` with the full repo. State which and ensure the workflow step fetches enough history (currently fetch-depth is not set, so it defaults to 1 — but the checkout step is `actions/checkout@v4` which defaults to depth 1; the audit would need `fetch-depth: 0` or explicit fetches of PR refs).

### R1-F5 [minor]

The plan §3.1.1 says `scripts/collab/gate-audit.mjs` should be added to the protected list. This file doesn't exist yet (it's created by the lane). Adding it to the protected list means any future change to it requires two-model review. However, the plan doesn't mention adding `gate-audit.mjs` to the builtin copy in `queue.mjs` (PROTECTED_GATE_BUILTIN, lines 94-100) or to `governance.ts` (PROTECTED_GATE_GLOBS, lines 48-63) or to `gate-invariants.test.mjs` (REQUIRED_PROTECTED, lines 22-37). The plan says 'all four copies, kept equal by the existing invariant check' but it should be explicit that the new entries go into all four.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:94` — export const PROTECTED_GATE_BUILTIN = ['CLAUDE.md', 'scripts/collab/plan-spar.mjs', 'scripts/collab/queue.mjs',
    'scripts/collab/protected-gate-files.json', 'services/gateway/src/services/plan-sparring/**',
    'services/gateway/src/services/project-manager/governance.ts', '.github/workflows/PLAN-SPAR.yml',
    '.github/workflows/PR-GATE.yml', '.github/workflows/AWS-PROD-*.yml', '.kiro/agents/vitana-lane-reviewer.md',
    'supabase/migrations/*vtid_ledger*.sql', 'supabase/migrations/*plan_sparring*.sql',
    '.github/workflows/VTID-ALLOCATE.yml', 'scripts/collab/gate-invariants.test.mjs'];
- `exafyltd/vitana-platform:scripts/collab/protected-gate-files.json:4` — "globs": [
      "CLAUDE.md",
      ...
      "scripts/collab/gate-invariants.test.mjs"
    ]

Suggestion: This is likely implicit from 'all four copies', but explicitly confirm in the plan that the three new entries (`.github/workflows/GATE-INVARIANTS.yml`, `scripts/ci/workflow-trigger-check.test.mjs`, `scripts/collab/gate-audit.mjs`) are added to all four copies: `protected-gate-files.json`, `PROTECTED_GATE_BUILTIN` in `queue.mjs`, `PROTECTED_GATE_GLOBS` in `governance.ts`, and `REQUIRED_PROTECTED` in `gate-invariants.test.mjs`. The existing invariant check will catch a mismatch, but it only runs after the change lands on main.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
