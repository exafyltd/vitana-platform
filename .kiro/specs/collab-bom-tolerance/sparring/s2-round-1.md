# Sparring round 1 — in_progress

Session: `22b90391-bb43-44f2-9393-7d61843c80e9` · plan hash `26b7c1156ca69974c187fa8d1aa49398717076f3e094c2f91186166a59212742`

## Summary

All eight stated premises hold. The proposed one-line fix (`replace(/^\uFEFF/, '')`) is correct and complete for the declared goal. One governance blocker is present: the plan never documents that this PR changes a protected gate file and therefore cannot be merged by the Project Manager via the normal reviewer-agent path. Two minor citation/coverage gaps round out the findings.

## Findings

### R1-F1 [blocker]

The plan says the lane is 'done when merged with green checks', but `governance.ts` hard-blocks the PM from ever merging a PR that touches `scripts/collab/queue.mjs`. The §3a owner-instruction merge requirement is entirely absent from the plan and lane body.

- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:185` — export function governanceMergeAllowed(
  lane: ObservedLane,
  pr: ObservedPr | null,
  review: ReviewEntry | null,
): GovernanceVerdict {
  const files = pr?.files ?? lane.paths;
  // VTID-05408 ... the PM ALWAYS refuses a protected gate file in code — no review (legacy-claude or
  // agent) ever unlocks one programmatically.
  if (touchesProtectedGate(files)) {
    return { ok: false, reason: 'protected_gate_file' };
  }
- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:48` — export const PROTECTED_GATE_GLOBS: readonly string[] = Object.freeze([
  'CLAUDE.md',
  'scripts/collab/plan-spar.mjs',
  'scripts/collab/queue.mjs',
  'scripts/collab/protected-gate-files.json',
- `exafyltd/vitana-platform:scripts/collab/protected-gate-files.json:4` — "globs": [
  "CLAUDE.md",
  "scripts/collab/plan-spar.mjs",
  "scripts/collab/queue.mjs",
  "scripts/collab/protected-gate-files.json",
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:992` — if (paths.length === 0) {
  warnings.push(`lane ${key} declares no paths (pre-VTID-05213 lane): Lane scope reports only, and the Project Manager never merges it`);
}
- `exafyltd/vitana-platform:.kiro/specs/kiro-lane-admin/lanes/enforcement.md:34` — **Protected gate file (§3a):** this lane changes `scripts/collab/queue.mjs` and
`scripts/collab/protected-gate-files.json` (and the PM `governance.ts` mirror). Merge only on the owner's instruction
naming this plan (recorded in handoff.md) plus a reviewer-agent accept on the current head — never a reviewer-agent
accept alone, never routed to Claude.

Suggestion: The `bom-strip` lane body must explicitly state — as `enforcement.md` does — that this is a §3a protected-gate merge: owner instruction naming the plan recorded in the lane log, plus reviewer-agent accept on the current head; the PM never merges it programmatically. The Test Plan section's 'done when merged with green checks' must be replaced with the §3a process description. Without this, an implementer following the plan has no documented path to land the PR: the PM always refuses with `protected_gate_file` when `pr.files` includes `scripts/collab/queue.mjs`, and a manual merge without owner instruction is itself a governance violation.

### R1-F2 [minor]

Evidence item 2 in the 'Today' section cites line `:744` for the `toString('utf8')` decode that preserves the BOM, but line 744 performs a `toString('latin1')` header verification; the UTF-8 content decode is at line 745. `showFile` reaches the same result via `git()` → `spawnGit` with `encoding: 'utf8'` (line 445), and `catFileBatch` via line 476.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:744` — if (bytes(at - hlen, hlen).toString('latin1') !== header) { close(); throw new Error(...); }
return bytes(at, size).toString('utf8').trimEnd();
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:444` — function git(repo, args, opts = {}) {
  return spawnGit(repo, args, { encoding: 'utf8', ...opts }).trimEnd();
}
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:486` — function showFile(repo, ref, p) {
  return gitOk(repo, ['show', `${ref}:${p}`]);
}
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:474` — const size = Number(m[1]);
...
out.set(q, buf.toString('utf8', pos, pos + size));

Suggestion: Correct the line reference in the plan's 'Today' item 2: the UTF-8 content decode in `commitFileReader` is at line 745 (not 744); `catFileBatch` uses `buf.toString('utf8', …)` at line 476; `showFile` inherits `encoding: 'utf8'` from `git()` at line 445. The substance of the claim (BOM survives into the string) is correct.

### R1-F3 [minor]

The test plan captures only `validate` output, not `scope-check`. The CI gate runs both commands separately. For a path-free `executor: kiro` lane that actually changes `queue.mjs`, `scope-check` exits 0 (warning only, line 992-993) but the warning text 'Lane scope reports only, and the Project Manager never merges it' is directly relevant evidence for the §3a merge decision and belongs in `commands.log`.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:1347` — if (cmd === 'scope-check') {
  ...
  return r.errors.length ? 1 : 0;
}
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:992` — if (paths.length === 0) {
  warnings.push(`lane ${key} declares no paths (pre-VTID-05213 lane): Lane scope reports only, and the Project Manager never merges it`);
}

Suggestion: Add `node scripts/collab/queue.mjs scope-check --base origin/main --head HEAD` to the test plan commands (expecting exit 0 with the path-free warning) and capture its output to `commands.log`. This makes the PM-will-not-auto-merge evidence explicit and supports the reviewer confirming the §3a merge path.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
