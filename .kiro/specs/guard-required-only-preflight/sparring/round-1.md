# Sparring round 1 — in_progress

Session: `a4338163-99f4-4376-b112-eaf754fe9518` · plan hash `bd2f9ea7c6a5a7a25f88d3ed9c4936c604efdc086d5d87c6dba7bf8d1f9af5f8`

## Summary

The plan is well-designed and the core problem is clearly real: `preflight.mjs` exits 1 on any failing check (line 206, 234), but `kiro-web-session.mjs` `checkPush` blocks on any non-zero exit (lines 422-434), meaning report-only failures block the guard even though CI wouldn't block on them. The fix—a `--required-only` flag that changes exit status to follow `requiredOk` while keeping output unchanged—is minimal, backward-compatible, and correctly scoped. All major premises verified. One minor suggestion below.

## Findings

### R1-F1 [minor]

The plan's test section should include a mixed-failure scenario (both a required AND a report-only failure) to prove `requiredOk` is false when a required check fails, even in the presence of concurrent report-only failures. The described `scope` fixture only produces report-only failures, and the `trailer` fixture only produces required failures. A combined fixture (e.g. `{ trailer: true, scope: true }`) would strengthen the regression suite against the case where a report-only failure masks a required one or vice versa.

- `exafyltd/vitana-platform:scripts/collab/preflight.test.mjs:44` — function fixture(bad = {}) { ... if (bad.trailer) { write(work, 'src/b.js', ...); commit(work, 'feat: b without trailers'); } ...
- `exafyltd/vitana-platform:scripts/collab/preflight.mjs:206` — return { ok: !checks.some((c) => c.status === 'fail'), repo, mode, base, head, branch, title: opts.title ?? null, checks };

Suggestion: Add a preflight.test.mjs case with `fixture({ trailer: true, scope: true })`: exits 1 by default, exits 1 with `--required-only`, `requiredOk` is false (required Collab handoff failure), and the report-only `pr-gate-scope` failure is still printed. This proves the two dimensions are independent.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
