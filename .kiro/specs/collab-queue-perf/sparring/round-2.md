# Sparring round 2 — in_progress

Session: `0793eaa6-86ee-4f43-aae1-b09739830129` · plan hash `97da7e8caecae2815c3b59b2b30d646f6bd1c65e4e144b74202e8d556d00480f`

## Summary

All four R1 findings were accepted and addressed in the revision. Two new defects emerge: (1) the plan specifies `execFileSync` without a maxBuffer override, which will silently crash on vitana-platform where 150+ spec files produce more output than the 1 MB Node.js default; (2) the "file deleted on main" fixture scenario is ambiguous — the M-status variant produces a divergence between the new implementation's guard and `collectReference` that breaks the equality assertion, but the plan's test section does not distinguish the two cases. No governance or tenant-isolation issues were found.

## Findings

### R2-F1 [major]

`execFileSync` has a 1 MB default `maxBuffer`; the combined stdout of `git cat-file --batch` for 150+ spec files on vitana-platform will exceed that limit, throwing `ENOBUFS` and crashing the command the plan is meant to fix.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:251` — const consider = (ref, p) => {
  const text = showFile(repo, ref, p);
  if (text === null) return;
  const fm = parseFrontMatter(text);
  const prev = best.get(p);
  if (!prev || (fm?.updated || '') > (prev.fm?.updated || '')) best.set(p, { path: p, ref, fm, text, ...classifyPath(p) });
};
for (const p of specFilesAt(repo, main)) consider(main, p);
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:503` — export function loadPrograms(repo, ref) {
  const out = gitOk(repo, ['ls-tree', '-r', '--name-only', ref, '--', 'docs/programs']);
  if (!out) return [];
  return out.split('\n').map((p) => /^docs\/programs\/([^/]+)\/program\.md$/.exec(p)).filter(Boolean)
    .map((m) => ({ id: m[1], path: m[0], fm: parseFrontMatter(showFile(repo, ref, m[0])) }));

Suggestion: The plan must explicitly set `maxBuffer` to a safe value (e.g., 100 * 1024 * 1024) in every `execFileSync` call that backs the batch reader, or switch to `spawnSync` and set the same option there. The plan already states vitana-platform has '150+ spec files' plus per-branch reads; at a modest 7 KB average per file that is already above 1 MB before git's own object framing overhead. This must be specified in §Changes 1 so the executor cannot omit it.

### R2-F2 [major]

The 'file deleted on main' fixture is ambiguous between the A-status and M-status cases, and the M-status case causes the guard to produce output that diverges from `collectReference`, breaking the equality assertion the plan also requires.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:263` — for (const [ref] of refs) {
  const changed = gitOk(repo, ['diff', '--name-only', `${main}...${ref}`, '--', '.kiro/specs']);
  if (!changed) continue;
  for (const p of changed.split('\n')) if (classifyPath(p)) consider(ref, p);
}
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:263` — for (const [ref] of refs) {
  const changed = gitOk(repo, ['diff', '--name-only', `${main}...${ref}`, '--', '.kiro/specs']);
  if (!changed) continue;
  for (const p of changed.split('\n')) if (classifyPath(p)) consider(ref, p);
}

Suggestion: The plan must specify which variant of the 'file deleted on main' fixture is used. The A-status variant (branch adds the file with status A, then main deletes it) is the only one for which both old and new implementations agree: old's three-dot diff includes the file, new's guard passes it through (A status found). That variant also exercises the guard's passing condition. To also exercise the guard's blocking condition (M-status file deleted on main), add a separate, clearly labelled fixture that asserts the file does NOT appear in `collect()` output, and exclude it from the `collectReference` equality check with an explicit comment. Without this split, an executor who naturally sets up the M-status variant will write a test that fails out of the box, and the impulse will be to weaken either the guard or the assertion.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Plan §Changes 4 explicitly states the exported `listClaims()` keeps its signature and its callers (`claim` L601, `release` L611, `claims` CLI L664) are not edited. The plan introduces an internal `claimsFrom()` helper used only by `collect()`. The fix is complete.
- R1-F2: acknowledged — The walk algorithm is now normative in plan §Changes 3: rev-list builds S and the parent map; log --cc --name-status builds `touched`; DFS per ref tip unions paths; guard handles the deleted-on-main case. The executor no longer needs to invent the algorithm.
- R1-F3: acknowledged — The plan now gives a concrete budget (6 with origin/HEAD set, ≤8 without) and the test asserts both the exact count and that it is independent of branch count. The merged `for-each-ref` that drops the claim filter accounts for the spawn previously consumed by `listClaims`'s own `for-each-ref` inside `collect()`.
- R1-F4: acknowledged — §Changes 5 brings `loadPrograms()` into scope with 2 spawns (ls-tree + cat-file --batch), the CLI budget is raised to ≤10, and a spawn-count assertion at 2 is added to the test plan. The < 10 s target is now explicitly bounded against this remaining cost.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
