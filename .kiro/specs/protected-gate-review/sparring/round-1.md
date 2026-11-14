# Sparring round 1 — in_progress

Session: `efb325d3-2b7b-4734-9d87-86434474508e` · plan hash `cd4910c4284dff13d1090eb2393fb159d87b959617bda08053a586e0112e9efb`

## Summary

The plan has three blockers: it omits `land-guard.mjs` and `governance.ts` as change targets, both of which independently enforce `PROTECTED_ACCEPTS_REQUIRED = 2` at merge time; and it does not address `gate-invariants.test.mjs` — itself a protected gate file — which explicitly tests that the two-model rule stays in force and will immediately fail if `land-guard.mjs` is changed without a matching update to the invariant file. Without all three files in scope the described rule change cannot land even with queue.mjs and collaboration.md updated. There are also two major issues: the plan collapses the lane-declaration-time check (queue.mjs scopeCheck) with the merge-time count check (land-guard.mjs / governance.ts) into a single premise without distinguishing them, and it presents two materially different stated rules (collaboration.md §3a "owner instruction + one accept" vs. code "two accepts from different chain models") as if they are the same rule.

## Findings

### R1-F1 [blocker]

`land-guard.mjs` is not in the plan's change scope but is the primary runtime gate that will continue to block the merge after queue.mjs and collaboration.md are updated.

- `exafyltd/vitana-platform:scripts/collab/land-guard.mjs:37` — /** VTID-05765: a protected gate file merges only with this many accepts from distinct chain models. */
export const PROTECTED_ACCEPTS_REQUIRED = 2;
- `exafyltd/vitana-platform:scripts/collab/land-guard.mjs:134` — export function mergeDecision({ review, checks, behindBy, protectedFiles = [], protectedModels = [] }) {
  if (protectedFiles.length) {
    const distinct = new Set(protectedModels);
    if (distinct.size < PROTECTED_ACCEPTS_REQUIRED) return { ok: false, code: 1, reason: `protected gate file(s) changed (${protectedFiles.join(', ')}): needs ${PROTECTED_ACCEPTS_REQUIRED} reviewer-agent accepts from different chain models on the current head ...` };
  }

Suggestion: Add `scripts/collab/land-guard.mjs` to the change scope for every option (A, B, and C). For Option B, `mergeDecision` must accept either the two-model count OR a verified owner instruction token that covers this specific plan's protected files. The constant `PROTECTED_ACCEPTS_REQUIRED` and the surrounding logic are the actual merge gate; updating queue.mjs alone leaves the merge blocked.

### R1-F2 [blocker]

`gate-invariants.test.mjs` — itself a protected gate file — explicitly hard-tests that `PROTECTED_ACCEPTS_REQUIRED == 2` and that `land-guard.mjs` refuses one accept. Any loosening of `land-guard.mjs` will cause this test to fail in PR-GATE, and changing this file is itself subject to the protected-gate rule.

- `exafyltd/vitana-platform:scripts/collab/gate-invariants.test.mjs:1` — // PROTECTED GATE FILE. It backs the two-model rule for protected gate files with a check that does not depend on a
// model: the protected list still names every gate file (this file included), the merge guards still refuse zero, one
// or two same-model accepts ...
- `exafyltd/vitana-platform:scripts/collab/gate-invariants.test.mjs:70` — for (const [label, models] of [['zero accepts', []], ['one accept', [MODELS[0]]], ['two accepts of one model', [MODELS[0], MODELS[0]]]]) {
  if (lg.mergeDecision({ ...base, protectedModels: models }).ok) failures.push(`land-guard.mjs merges a protected gate file with ${label}`);
}
if (!lg.mergeDecision({ ...base, protectedModels: MODELS }).ok) failures.push('land-guard.mjs refuses two accepts from different models (rule not in force)');
- `exafyltd/vitana-platform:scripts/collab/gate-invariants.test.mjs:133` — T('mutation: one accept unlocking a protected gate file fails', async () => {
  const dir = fixture();
  edit(dir, 'scripts/collab/land-guard.mjs', (s) => s.replace('export const PROTECTED_ACCEPTS_REQUIRED = 2;', 'export const PROTECTED_ACCEPTS_REQUIRED = 1;'));
  const { failures } = await checkInvariants(dir);
  assert.ok(failures.some((f) => /with one accept/.test(f)), failures.join('\n'));
});
- `exafyltd/vitana-platform:scripts/collab/protected-gate-files.json:18` —     "scripts/collab/gate-invariants.test.mjs"
- `exafyltd/vitana-platform:scripts/collab/gate-invariants.test.mjs:94` — T('merge-base copy of gate-invariants.mjs holds on this checkout (bootstrap when absent)', async (t) => {
  let src = null;
  try { src = git('show', 'origin/main:scripts/collab/gate-invariants.test.mjs'); } catch { /* not on main yet */ }
  ...the { checkInvariants: baseline } = await import(...); ...assert.deepEqual(failures, []);

Suggestion: Add `scripts/collab/gate-invariants.test.mjs` to the change scope and explicitly describe the new invariant assertions it must enforce for the chosen option. Note that because this file is itself a protected gate file, the PR that changes it is subject to the full gate process — plan the sequencing. The plan's test section must reference `gate-invariants.test.mjs` in addition to `queue.test.mjs`.

### R1-F3 [blocker]

`services/gateway/src/services/project-manager/governance.ts` has its own independent `PROTECTED_ACCEPTS_REQUIRED = 2` and `protectedAcceptModels` enforcement. It is not in the plan's change scope and will independently refuse the merge via the Project Manager path.

- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:65` — /** VTID-05765: distinct chain models whose agent accept is on the PR's current head. */
export const PROTECTED_ACCEPTS_REQUIRED = 2;
- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:14` — * a PR that changes a protected gate file merges only with TWO agent
*   accepts from two different chain models on the current head (VTID-05765,
*   plan autonomous-to-staging); otherwise it is refused (`protected_gate_file`).
*   Defense-in-depth with queue.mjs scope-check and land-guard.mjs
*   mergeDecision, which apply the same rule independently.
- `exafyltd/vitana-platform:scripts/collab/gate-invariants.test.mjs:58` — const gov = read(root, 'services/gateway/src/services/project-manager/governance.ts') || '';
for (const g of REQUIRED_PROTECTED) if (!gov.includes(`'${g}'`)) failures.push(`governance.ts PROTECTED_GATE_GLOBS no longer lists ${g}`);

Suggestion: Add `services/gateway/src/services/project-manager/governance.ts` to the change scope. This is itself a protected gate file (listed in `protected-gate-files.json` line 10), so the sequencing and two-model (or replacement) requirement applies to it as well. The plan comment 'defense-in-depth' means all three enforcement points must be updated consistently.

### R1-F4 [major]

The plan collapses two distinct enforcement points — the lane-declaration check in queue.mjs scopeCheck and the merge-time model-count check in land-guard.mjs — into a single premise, misrepresenting the architecture and making the scope of Option B ambiguous.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:1043` — else if (matchesAny(f, PROTECTED_GATE_PATHS)) {
  // VTID-05765: a trusted two-model lane may change it; the merge then needs two accepts from different models.
  if (isTwoModelLane(fm) && trustedFrom) continue;
  errors.push(`${f} is a protected gate file ... needs protected_gate: ${PROTECTED_GATE_TWO_MODEL} ...`);
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:101` — /** VTID-05765: the lane marker that lets an executor: kiro lane change a protected gate file, under the two-model rule
 * (two reviewer-agent accepts from different chain models on the current head, land-guard.mjs mergeDecision). Read only
 * from a trusted revision of the lane file ... */
export const PROTECTED_GATE_TWO_MODEL = 'two-model';
export const isTwoModelLane = (fm) => !!fm && fm.executor === 'kiro' && fm.protected_gate === PROTECTED_GATE_TWO_MODEL
  && isReviewerAgent(fm.reviewer_seat);

Suggestion: Clarify the two-stage gate in the plan: (1) `queue.mjs scopeCheck` / `validateLane` check the *lane declaration* at PR-GATE time (does the lane have `protected_gate: two-model` from a trusted source?); (2) `land-guard.mjs mergeDecision` and `governance.ts` count the actual accepts at *merge* time. Option B needs a specified mechanism for both stages, not just one.

### R1-F5 [major]

The plan's 'Measured state' presents two materially different rules as a single coherent state: collaboration.md §3a says 'owner instruction + one reviewer accept', but the code enforces two accepts from different chain models. This unresolved inconsistency makes it unclear what Option B is actually replacing.

- `exafyltd/vitana-platform:.claude/rules/collaboration.md:138` — except the protected gate files, which never merge on a reviewer-agent accept alone: they need the owner's instruction naming the plan plus a reviewer-agent accept on the current head.
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:89` — // VTID-05276 (plan §4.3), VTID-05408 (kiro-lane-admin §4): protected gate files — the gates themselves. A Kiro lane
// never changes one on a reviewer-agent accept alone; it needs the owner's instruction naming the plan plus a
// reviewer-agent accept on the current head (Claude Code is retired).
- `exafyltd/vitana-platform:scripts/collab/land-guard.mjs:37` — /** VTID-05765: a protected gate file merges only with this many accepts from distinct chain models. */
export const PROTECTED_ACCEPTS_REQUIRED = 2;

Suggestion: The plan must explicitly acknowledge that the rule text in collaboration.md §3a (and the queue.mjs comment) is a stale description of an earlier rule (VTID-05276/05408) that was superseded by the two-model rule (VTID-05765). The plan should state which layer (text, code, or both) it is changing for each option, and the final state should be consistent across collaboration.md, queue.mjs comments, land-guard.mjs, and governance.ts.

### R1-F6 [minor]

The plan does not document how the rule-change PR itself satisfies the current two-model gate for the protected gate files it touches (queue.mjs, land-guard.mjs once added). The bootstrapping path is unspecified.

- `exafyltd/vitana-platform:scripts/collab/protected-gate-files.json:7` —     "scripts/collab/queue.mjs",
    "scripts/collab/protected-gate-files.json",
- `exafyltd/vitana-platform:.kiro/agents/vitana-lane-reviewer.md:14` — dispatchKind: sub-agent

Suggestion: Add a 'Landing sequence' section to the plan. Options: (a) the lane carries `protected_gate: two-model` and obtains two model-accepts via two sequential reviewer-agent invocations before the owner issues the merge instruction; or (b) the owner uses a manual merge outside land-guard (requires explicit policy justification). The gate-invariants.test.mjs bootstrap clause (line 94-97: 'no baseline on origin/main → pass') is relevant for the first commit to main but should be called out explicitly.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
