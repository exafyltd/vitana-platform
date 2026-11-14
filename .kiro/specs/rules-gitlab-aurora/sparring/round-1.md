# Sparring round 1 — in_progress

Session: `85612b1b-8416-44e9-b2de-e45e6c75f3a5` · plan hash `3aad74f127447aa56825159afebb01c92c8c6158324d6cd45e9f77c470c5e183`

## Summary

The plan's line-number references to existing enforcement points are accurate. The three-layer protection model (land-guard.mjs, queue.mjs scopeCheck, governance.ts) is correctly identified and the bootstrap mechanism is coherent. However, the predicate depends on data infrastructure (front-matter fields and commit trailers) that does not exist today and whose introduction is not specified; one of the three copies of the protected-gate-file list is omitted from the update scope; and relaxing the PM's hard refusal removes an explicit defense-in-depth layer.

## Findings

### R1-F1 [major]

The predicate requires `sparring_verdict`, `plan_hash`, and `protected_files` in handoff.md front-matter, plus `Collab-Reviewer-Seat` and `Collab-Seat` commit trailers. None of these exist in the current codebase. The handoff.md schema (collaboration.md lines 32-44) has no such fields; search for `Collab-Reviewer-Seat` returns no hits. The plan describes the predicate's inputs but never specifies what component writes these fields/trailers, when they are written, or how `validatePlan()` in queue.mjs is updated to accept them. Without this, the predicate has no data to evaluate.

- `exafyltd/vitana-platform:.claude/rules/collaboration.md:32` — slug: <slug>\nauthor: claude | kiro\nexecutor: claude | kiro\nnext_actor: claude | kiro | owner\nstate: drafted | sparred | approved | executing | in-review | verified | done | parked\nparked_from: <state>\nvtids: [VTID-xxxxx, ...]\nsparring_record: <path>\nupdated: 2026-10-13T10:00Z
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:196` — function validatePlan(fm) { ... if (!PLAN_STATES.includes(fm.state)) ... if (PLAN_NEEDS_VTIDS.has(fm.state) ... if (fm.author_seat !== undefined && !SEAT_RE.test(fm.author_seat))

Suggestion: Specify: (a) which component writes `sparring_verdict`, `plan_hash`, and `protected_files` to handoff.md (CI PLAN-SPAR? the planner?); (b) add them to validatePlan; (c) define who emits the `Collab-Reviewer-Seat` / `Collab-Seat` trailers (or clarify if seat is derived from the existing `Collab-Session` trailer via `seatOf()` — if so, say so explicitly and drop the separate-trailer language).

### R1-F2 [major]

The protected-gate-file list exists in THREE copies: (1) protected-gate-files.json, (2) PROTECTED_GATE_BUILTIN in queue.mjs (lines 94-98, the compiled-in fallback for single-file runs), and (3) PROTECTED_GATE_GLOBS in governance.ts (lines 48-61). The plan says Phase 3 adds `protected-approval.mjs` and `land-guard.mjs` to #1 (JSON) and #3 (governance.ts) but never mentions updating #2 (PROTECTED_GATE_BUILTIN). When queue.mjs runs as a single file (CI in vitana-v1, per the comment on line 92), it falls back to BUILTIN and would miss the two new entries — leaving those files unprotected in that code path.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:89` — // VTID-05276 ... CI and vitana-v1 run single-file copies of queue.mjs, so the same list is compiled in for when the JSON is absent.
export const PROTECTED_GATE_BUILTIN = ['CLAUDE.md', 'scripts/collab/plan-spar.mjs', 'scripts/collab/queue.mjs', 'scripts/collab/protected-gate-files.json', 'services/gateway/src/services/plan-sparring/**', 'services/gateway/src/services/project-manager/governance.ts', '.github/workflows/PLAN-SPAR.yml', '.github/workflows/PR-GATE.yml', '.github/workflows/AWS-PROD-*.yml', '.kiro/agents/vitana-lane-reviewer.md', 'supabase/migrations/*vtid_ledger*.sql', 'supabase/migrations/*plan_sparring*.sql'];
- `exafyltd/vitana-platform:scripts/collab/protected-gate-files.json:1`
- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:47` — export const PROTECTED_GATE_GLOBS: readonly string[] = Object.freeze([...])

Suggestion: Add an explicit step in Phase 3 to update PROTECTED_GATE_BUILTIN in queue.mjs alongside the JSON and governance.ts. Consider adding a parity test (or extending the existing one referenced in governance.ts line 23) that asserts all three copies are identical, so future additions can't drift.

### R1-F3 [major]

The plan relaxes the governance.ts hard refusal (lines 197-198) from 'always refuse protected gate files' to 'accept when protectedApprovalOk is true'. But governance.ts runs in the Project Manager service, which observes PRs and can call merge autonomously. Today's hard refusal is an independent defense-in-depth layer — the comment at lines 191-196 explicitly says 'the PM ALWAYS refuses a protected gate file in code — no review ever unlocks one programmatically.' Replacing this with the predicate means a compromised or buggy plan front-matter + a reviewer-agent accept could unlock a protected file merge through the PM without any human. The plan should justify why removing this defense-in-depth layer is safe, or keep the PM's hard refusal and limit the predicate to land-guard.mjs only.

- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:191` — // VTID-05408 (kiro-lane-admin §5): the PM ALWAYS refuses a protected gate file in code — no review (legacy-claude or
// agent) ever unlocks one programmatically. The legacy-claude unlock is RETIRED, not transferred ...
if (touchesProtectedGate(files)) {
  return { ok: false, reason: 'protected_gate_file' };
}
- `exafyltd/vitana-platform:scripts/collab/land-guard.mjs:108` — export function mergeDecision({ review, checks, behindBy, protectedFiles = [] }) {
  if (protectedFiles.length) return { ok: false, code: 1, reason: `protected gate file(s) changed ...` };

Suggestion: Keep the governance.ts hard refusal as-is (defense-in-depth: the PM never merges a protected file). Apply the predicate only in land-guard.mjs (the CLI merge guard the plan driver calls). This preserves the independent-layer property: even if land-guard.mjs is tricked, the PM still refuses. The plan's 'zero human in the loop' goal still works because the plan driver uses land-guard.mjs, not the PM, as the merge actuator.

### R1-F4 [minor]

The plan describes the data path ('the merge command in land-guard.mjs computes a protectedApproval object from the lane's trusted front-matter and the head's trailers') using present-tense language that implies this infrastructure already exists. In fact, the current merge command (lines 268-287) computes protectedFiles via protectedTouched() and passes a flat file list — the protectedApproval object, lane front-matter reading, and trailer extraction are all new code that must be built.

- `exafyltd/vitana-platform:scripts/collab/land-guard.mjs:268` — if (cmd === 'merge') {
  ...
  const d = mergeDecision({ review, checks, behindBy: cmp.behind_by, protectedFiles: protectedTouched(files, PROTECTED_GATE_PATHS) });
  ...

Suggestion: In the Phase 3 description, clearly separate 'existing code that is being changed' (current mergeDecision signature, current protectedTouched call) from 'new code being added' (protectedApproval object construction, front-matter parsing in the merge command, trailer extraction). This helps the implementer understand the delta.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
