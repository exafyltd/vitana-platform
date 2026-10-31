# Design — collab-handoff-check-fix
Authoritative plan: `plan.md`. Line numbers: `scripts/collab/queue.mjs` on `origin/main` @ `28aaab2331`.

## R1 — session map (`validateRange`, :566-596)
```js
// VTID-<lane>: PLAN-SPAR's own `_plan` commits are CI, not a second session; their writes are checked per file above.
const isCiPlanCommit = k.session === CI_PLAN_SPAR && k.lane && k.lane.split(',').every((l) => l.trim().endsWith(`/${PLAN_LANE}`));
if (k.lane && k.session !== PM_AGENT && !isCiPlanCommit) { ... }
```
The file loop (:574-592) is untouched, so `ci-plan-spar` keeps exactly today's write permissions.

## Silent failure (CLI, :988 and :1003)
```js
if (args.summary) {
  appendFileSync(args.summary, out);
  for (const e of r.errors) console.error(`::error::collab handoff: ${e}`);
  for (const w of r.warnings) console.error(`::warning::collab handoff: ${w}`);
  console.error(status.split('\n')[0]);
} else console.log(out);
```
Same shape for `scope-check` with the prefix `lane scope:`. Newlines inside a problem are escaped as `%0A` (GitHub
annotation syntax).

## Batching
`commitsInRange(repo, base, head)`:
```
git log --no-merges --name-only --format=%x1e%H%x1f<trailers…> <base>..<head>
```
Split on `\x1e`; per record the first line holds the fields, the remaining non-empty lines are the files. Same
order as today (`git log` default order).

A small helper builds the file-read Map once per `validateRange` / `scopeCheck` call:
```js
function commitFileReader(repo, needs /* [{sha, path}] */) {
  const qs = needs.flatMap(({ sha, path }) => [`${sha}^:${path}`, `${sha}:${path}`]);
  const m = catFileBatch(repo, qs);
  return (rev, p) => { const v = m.get(`${rev}:${p}`); return v == null ? null : v.trimEnd(); };
}
```
`needs` = every (commit, lane file) pair the loops will look at (the same conditions as today, evaluated on the
already-parsed trailers and file lists). `pmAgentOverreach` and `frontMatterChanged` take the reader as a parameter
instead of calling `showFile`. `trimEnd()` keeps parity with `showFile` (`git()` trims the end). A missing object is
`null`, the same as a failing `git show`.

Spawn budget per call, independent of the commit count: `diff` 1, `merge-base` 1, `log` 1, `cat-file --batch` 1, plus
today's per-touched-file `ls-tree` / `show` reads for head and merge-base (unchanged, they scale with spec files).

## Programme registry
Front matter `specs:` block lists in `docs/programs/{native-app,desktop-redesign,standalone}/program.md`; one programme
per spec. `program-registry.test.mjs` imports `loadPrograms`, `validatePrograms`, `programIndex` from `queue.mjs` and
runs against the repository root at `HEAD`.
