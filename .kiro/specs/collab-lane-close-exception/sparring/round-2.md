# Sparring round 2 — in_progress

Session: `6f2d854a-85b8-4727-b10b-4b9ac49378d1` · plan hash `302eed0d943e57ed0fe62048b2f09ed87fa053f328b8dbff764f97fa81cfd8ce`

## Summary

The revised plan correctly addresses all three R1 findings: per-file chains are now accurate (R1-F1), the slug is threaded into transitionChain (R1-F2), and the §3a protected-gate-file merge procedure is documented in Risks (R1-F3). One new finding: the plan describes `reviewer_exception:` as carrying structured sub-fields (`owner_approval`, `pr`, `merge_sha`), but the custom `parseFrontMatter` function cannot parse nested YAML objects — the implementer needs a flat encoding.

## Findings

### R2-F1 [major]

The plan says the lane file's front matter carries `reviewer_exception:` with sub-fields `owner_approval`, `pr`, and `merge_sha`. But `parseFrontMatter` (queue.mjs lines 152-170) is a minimal parser that only supports top-level scalars, inline lists (`[a, b]`), and block lists (`- item`). It cannot parse nested YAML objects. An indented `owner_approval: ...` line under `reviewer_exception:` would be silently ignored (the `^([A-Za-z_][\w-]*):\s*(.*)$` regex at line 161 requires the key to start at column 0). The implementer would produce front matter that the validator silently misreads, potentially always seeing the exception as absent and rejecting valid closures, or — if they work around it ad-hoc — introducing an inconsistent encoding.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:151` — /** Minimal YAML front matter: `key: value`, `key: [a, b]`, and `key:` followed by `  - item` lines. */
export function parseFrontMatter(text) {
  ...
  const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw);
  if (!kv) continue;
  const v = kv[2].replace(/\s+#.*$/, '').trim();
  if (v === '') { listKey = kv[1]; out[listKey] = []; continue; }
  ...
- `exafyltd/vitana-platform:scripts/collab/queue.test.mjs:28` — const fm = parseFrontMatter('---\na: 1\nb: [x, y]\nc:\n  - p\n  - "q"\nd: v # note\n---\nbody');
assert.deepEqual(fm, { a: '1', b: ['x', 'y'], c: ['p', 'q'], d: 'v' });

Suggestion: Specify a flat encoding that parseFrontMatter can actually parse. Simplest option: three separate top-level scalar fields — `reviewer_exception: true`, `reviewer_exception_approval: <owner ref + date>`, `reviewer_exception_pr: <url>`, `reviewer_exception_merge_sha: <sha>`. The code checks `after.reviewer_exception === 'true' && after.reviewer_exception_pr && after.reviewer_exception_merge_sha && after.reviewer_exception_approval && CLOSED_BY_OWNER_EXCEPTION.includes(slug)`. Alternatively, encode as a single delimited scalar (`reviewer_exception: owner_approval=2026-11-11; pr=…; merge_sha=…`) and parse it in transitionChain, but this is more fragile. Either way the encoding must be stated in the plan so the test cases match.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
