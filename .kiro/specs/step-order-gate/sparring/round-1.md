# Sparring round 1 — in_progress

Session: `55e09f5d-084b-4621-a992-624a8ce38d1e` · plan hash `636e33db3777ad58d914ee3a22e56a3d22d1e68ff78e47deaf644d402098e67e`

## Summary

The plan's premises about the codebase are accurate: line references for driver.md, common-rules.md, queue.mjs exports, governance paths, the VTID-05276 exception, protected gate files, and lane-land.md steps all check out. Two substantive gaps require attention before implementation.

## Findings

### R1-F1 [major]

The plan's `merge` command blocks the `--admin` governance-artifact false-positive escape that lane-land.md step 3d and common-rules.md rule 4 both require. The `checks` sub-command exits 1 on any non-success/skipped/neutral conclusion, and the `merge` command refuses to call the merge API when `checks` fails. The plan also introduces rule 13 requiring all merges to go through `land-guard merge`, so there is no documented fallback for the `--admin` case. This would prevent merging a lane whose only red check is a known governance-artifact false positive (e.g. Lane scope red solely because the spec is not yet on `main`).

- `exafyltd/vitana-platform:.kiro/pipeline/lane-land.md:38` — Wait (poll 2-3 min, max 60 min) for every required check green on that exact head, then merge at once under the §7b rule (common rule 4) with **squash** ... `--admin` only for the governance-artifact false positive (log why); never over a real red.
- `exafyltd/vitana-platform:.kiro/pipeline/common-rules.md:25` — `gh pr merge --admin` only when the one red check is a governance-artifact false positive for this change (Lane scope failing solely on the executor / governance-path / reviewer rule, or because the spec is not on `main` yet), with the run log linked in `merges.md`.

Suggestion: Either (a) add an `--admin-reason <text>` flag to `land-guard merge` that accepts a governance-artifact false-positive reason, skips the failing governance-artifact check only (still blocks real reds), and logs the reason — or (b) add an explicit exception in rule 13 that the `--admin` governance-artifact case is the one merge that bypasses `land-guard merge`, with the existing lane-land.md safeguards (log why, never over a real red, link in merges.md).

### R1-F2 [major]

The `release` command reads the lane file's front-matter `state` on `origin/main` and refuses unless it is `done` or `parked`. After a squash merge the lane file on `main` carries the state from the branch tip (typically `verified`, since the `verified→done` transition in LANE_EDGES happens post-merge). The plan describes changing lane-land.md step 3f to call `land-guard release` but does not describe the intermediate commit-and-push to `main` that transitions the lane file to `done` before the release. If that push is missing or happens after the release call, `land-guard release` would always refuse a just-merged lane, deadlocking the flow. The same concern applies to `_plan` / `handoff.md`: the driver's step 9 releases `_plan` and the heartbeat, but `handoff.md` must be at `done` on `origin/main` first.

- `exafyltd/vitana-platform:.kiro/pipeline/lane-land.md:49` — f. Record the merge SHA (`gh pr view <n> --json mergeCommit,mergedBy,mergedAt`), who merged (PM or §7b rule), `--admin` and why → `merges.md`, lane log and state; a PR comment on PRs this step merged: `Merged under collaboration.md §7b (PM merge rule): merge commit <sha>`; status `landed`, `done: true`; timing `lane_merged` (`mergedAt`). Release the claim (`queue.mjs release <slug>/<LANE> --session <id>`).
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:47` — const LANE_EDGES = {
  ready: ['executing'],
  executing: ['in-review'],
  'in-review': ['verified', 'executing'],
  verified: ['done'],
  done: [],
};

Suggestion: Make the precondition explicit: (1) the revised lane-land.md step 3f text must state that the lane file's `state: done` (and `handoff.md` for `_plan`) is committed and pushed to `origin/main` *before* `land-guard release` is called; (2) `land-guard release` should print a clear diagnostic when the state is not `done|parked` (including the state it found and the file path) so the caller can distinguish a missing push from a real refusal; (3) add a test case that verifies `release` on a lane whose file is at `verified` on `origin/main` exits 1.

### R1-F3 [minor]

The plan says land-guard.mjs imports only `globToRegex` and `PROTECTED_GATE_PATHS` from queue.mjs. The `release` command must parse lane-file front matter to read the `state` field, which needs `parseFrontMatter` (exported at queue.mjs line 150). The `merge` command likely also needs `matchesAny` (line 127) to check changed files against protected-gate globs. The import list in the plan is incomplete.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:149` — /** Minimal YAML front matter: `key: value`, `key: [a, b]`, and `key:` followed by `  - item` lines. */
export function parseFrontMatter(text) {
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:127` — export const matchesAny = (file, globs) => asList(globs).some((g) => globToRegex(g).test(file));

Suggestion: List all planned imports from queue.mjs (at least `parseFrontMatter`, `matchesAny`, `PROTECTED_GATE_PATHS`, `globToRegex`) so the lane's scope declaration and the implementation are aligned.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
