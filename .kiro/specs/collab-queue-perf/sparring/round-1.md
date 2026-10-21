# Sparring round 1 — in_progress

Session: `0793eaa6-86ee-4f43-aae1-b09739830129` · plan hash `88ae371b647efe3a6a55bb7f62b40585e1fc30beedba1606c7a60027b1e1c24e`

## Summary

All core premises about the existing code hold. Three substantive issues found: one major (`listClaims` has callers outside `collect` that would break), one major (the `design.md` file the executor is directed to for the hardest algorithmic step doesn't exist), and two minor (spawn-count assertion will fail; `loadPrograms` in the queue CLI path adds unaccounted spawns).

## Findings

### R1-F1 [major]

`listClaims()` is a shared export called from three places outside `collect()`. The plan to switch it to a batch reader doesn't say what happens to those callers, and a naive rewrite breaks them.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:231` — export function listClaims(repo) {
  const out = gitOk(repo, ['for-each-ref', ...]);
  ...
  const msg = gitOk(repo, ['log', '-1', '--format=%B', sha]) || '';
  ...
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:599` — git(repo, ['fetch', '--prune', 'origin']);
const holder = listClaims(repo).find((c) => c.key === key);
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:610` — git(repo, ['fetch', '--prune', 'origin']);
const c = listClaims(repo).find((x) => x.key === key);
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:662` — if (cmd === 'claims') {
  const now = Date.now();
  for (const c of listClaims(repo)) console.log(...);
  return 0;
}
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:268` — return { main, files: [...best.values()], claims: listClaims(repo) };

Suggestion: Either (a) keep `listClaims()` unchanged for its standalone callers and fold the batch path only into `collect()` (inline the for-each-ref + batch-sha logic there, don't change the exported function), or (b) add an optional `{ batch }` parameter to `listClaims` so the standalone callers pass nothing and get the old behaviour. The plan must state which path is taken; without that, the executor will break `claim`, `release`, and the `claims` CLI command.

### R1-F2 [major]

The plan delegates the most complex algorithmic step — the rev-list/log --stdin parent-walk — to `design.md`, but that file does not exist at the pinned commit. The executor has no specification for that algorithm.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:1` — The single copy of this script lives in vitana-platform; vitana-v1 CI fetches it.

Suggestion: Either inline the algorithm into the plan itself (the parent-walk: for each branch tip in the recent-refs set, walk `parents` while the parent SHA is in the off-main set produced by `rev-list`, union file paths seen in `--name-status` along that walk; stop when the parent is not in the set), or create the `design.md` file as a separate, pre-merged commit before this lane begins. Without it the executor must invent the algorithm, which is precisely where the semantic difference from the three-dot diff lives and where bugs would appear.

### R1-F3 [minor]

The test assertion 'git spawn count ≤ 6 per repo' will fail in practice. `defaultRemoteBranch()` adds 1–3 spawns before `collect()` does any work, and the claims `for-each-ref` is a separate call. The true constant is 7–9.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:223` — function defaultRemoteBranch(repo) {
  const sym = gitOk(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (sym) return sym;
  for (const b of ['origin/main', 'origin/master']) if (gitOk(repo, ['rev-parse', '--verify', '-q', b])) return b;
  return null;
}
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:231` — export function listClaims(repo) {
  const out = gitOk(repo, ['for-each-ref', '--format=%(refname)%09%(objectname)%09%(committerdate:unix)', `refs/remotes/origin/${CLAIM_PREFIX}`]);

Suggestion: Change the test bound to ≤ 9 (or whatever the actual fixed count is after implementation), or merge the claims `for-each-ref` into the existing branch `for-each-ref` by not filtering out `collab-claim/*` refs in that call and separating them in JS. Document the actual count in the plan.

### R1-F4 [minor]

`loadPrograms()` is called in the `queue` CLI path immediately after `collect()` and makes one `showFile` call per `docs/programs/*/program.md` file. These spawns are not batched and are not counted in the plan's process budget.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:713` — for (const r of args.repo) {
  const abs = path.resolve(r);
  const c = collect(abs, { days: Number(args.days || 30) });
  rows = rows.concat(buildQueue(c, path.basename(abs)));
  programs.push(...loadPrograms(abs, c.main));
}
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:503` — export function loadPrograms(repo, ref) {
  const out = gitOk(repo, ['ls-tree', '-r', '--name-only', ref, '--', 'docs/programs']);
  ...
  .map((m) => ({ id: m[1], path: m[0], fm: parseFrontMatter(showFile(repo, ref, m[0])) }));

Suggestion: Either note explicitly that `loadPrograms` is out of scope (programs are few and constant), or extend the batch reader to cover it too. At minimum, adjust the '< 10 s' timing claim to acknowledge this remaining per-file cost.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
