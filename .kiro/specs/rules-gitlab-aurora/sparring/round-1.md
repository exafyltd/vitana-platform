# Sparring round 1 — in_progress

Session: `334750e7-4cb7-46ec-95ae-74f10c89fcee` · plan hash `1bc3a5a44e102326202a8efb67cf2dd31565615cd3ada9afb1cce2b06e83466a`

## Summary

Verified 11 premises against the pinned code. Two are wrong and produce real implementation risks; one is a security gap in the protected-file design. The line references, function boundaries, and DELIVERY_MODE state are mostly accurate, but the plan mis-identifies the function at queue.mjs:240 and omits the new predicate file from the protected-gate list, which breaks defense-in-depth.

## Findings

### R1-F1 [major]

The plan says 'scripts/collab/queue.mjs:240 and :1034: scopeCheck accepts a protected-file change when protectedApprovalOk is true.' Line 240 is NOT in scopeCheck — it is in validateLane (starts at line 213). validateLane validates lane DEFINITIONS (whether a kiro lane may even declare paths reaching protected files), not actual changed files in a PR. scopeCheck starts at line 946; line 1034 is correctly in scopeCheck. The two functions have different semantics: validateLane gates lane front-matter at validation time (no PR, no plan hash, no reviewerSeat trailer available), while scopeCheck gates actual changed files at merge time. Applying protectedApprovalOk (which needs converged, plannedFiles, reviewerSeat, authorSeat) at the validateLane call site (line 240) is semantically wrong — the predicate's inputs are not available during lane definition validation. If validateLane is not also modified, it will continue to reject any kiro lane whose paths reach a protected file ('such a lane needs executor: claude'), making the scopeCheck predicate unreachable. With Claude Code retired, no lane could change protected files at all.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:213` — export function validateLane(fm, slug, lane, laneIds) {
  ...
  if (fm.executor === 'kiro') {
    for (const g of paths) {
      if (globTouchesProtected(g)) e.push(`paths "${g}" reaches a protected gate file ...`);
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:946` — export function scopeCheck(repo, { base, head, branch = '', fetchLane = null, fetchPlanLane = null }) {
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:1032` — else if (fm.executor === 'claude') continue;
// VTID-05276 (plan §4.3): a protected gate file never passes for a non-claude lane, whatever its reviewer.
else if (matchesAny(f, PROTECTED_GATE_PATHS)) errors.push(...);

Suggestion: Describe two separate changes: (a) validateLane line 240 — allow a kiro lane to declare paths reaching a protected file when the lane's plan front-matter has sparring_verdict: converged and a protected_files list that covers the glob (a design-time pre-check, not the full predicate); (b) scopeCheck line 1034 — the full protectedApprovalOk predicate at merge time. Name the correct functions in the plan.

### R1-F2 [major]

The plan creates scripts/collab/protected-approval.mjs as the single canonical implementation of the predicate that unlocks protected-file merges, imported by both queue.mjs and land-guard.mjs. This new file is under scripts/collab/ (a governance path per governance.ts line 73) but is NOT added to the protected-gate-files list. An agent-reviewed kiro lane whose paths cover scripts/collab/protected-approval.mjs could modify the predicate to always return true — that change only needs a reviewer-agent accept (governance-path level), not the full protected-gate authority — and then any subsequent lane could use the weakened predicate to unlock actual protected files. Similarly, land-guard.mjs is a merge-time enforcement point for the predicate but is also not in the protected-gate-files list. This breaks the defense-in-depth guarantee the plan inherits from governance.ts (lines 16-19: 'Both independent layers … keep refusing protected gate files').

- `exafyltd/vitana-platform:scripts/collab/protected-gate-files.json:1` — "globs": [
    "CLAUDE.md",
    "scripts/collab/plan-spar.mjs",
    "scripts/collab/queue.mjs",
    "scripts/collab/protected-gate-files.json",
    ... (no land-guard.mjs, no protected-approval.mjs)
- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:68` — export const GOVERNANCE_PATHS = [
  '.github/',
  '.claude/',
  '.kiro/steering/',
  '.kiro/automations/',
  'scripts/collab/',
  'CLAUDE.md',
  'docs/programs/areas.yaml',
] as const;
- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:14` — a PR that changes a protected gate file is ALWAYS refused in code ... Both independent layers (queue.mjs scope-check AND this guard) keep refusing protected gate files

Suggestion: Add scripts/collab/protected-approval.mjs and scripts/collab/land-guard.mjs to protected-gate-files.json (and the corresponding PROTECTED_GATE_GLOBS in governance.ts). Any file that implements or enforces the predicate must be at the same protection level as the files the predicate gates.

### R1-F3 [minor]

The state table says 'GitLab delivery mode: shadow (config/delivery/services.json, delivery_mode)' implying the field exists now. The actual services.json at the pinned commit has no delivery_mode field. Phase 5 correctly says the flip 'adds a field delivery_mode per repository', but the state table presents it as current state, which is misleading for implementers reading the state table as ground truth.

- `exafyltd/vitana-platform:config/delivery/services.json:1` — {
  "schema": "vitana.delivery-services/v1",
  "$comment": "VTID-05550 ...",
  "ci_config": {
    "project": "vitana/ci-config",
    "ref": "main"
  },
  ... (no delivery_mode)

Suggestion: Mark the delivery_mode row in the state table as 'not yet present; added by Phase 5' or split it into current-state and target-state columns.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
