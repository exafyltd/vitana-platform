# Sparring round 1 — in_progress

Session: `7bf26903-b794-418f-9ddf-9567453ee4f7` · plan hash `a81bfd65bd35e68e996b0c165701fa2fccf13139a0fdbdff14b1e4177bcd5170`

## Summary

The plan's premises about existing code are largely accurate. The governance model, PERM-change logic, trusted-source pinning, protected-gate enforcement, and the dormant retire-claude-code plan are all correctly described. However, the plan has one blocker (the `validate` function blocks the intended mechanism) and two major gaps (governance.ts defense-in-depth weakened, admin lane can self-widen PERM fields).

## Findings

### R1-F1 [blocker]

The `validate` function (Collab handoff CI check) at lines 574-591 refuses any commit that modifies a lane file when the commit's `Collab-Lane` trailer doesn't match that lane file's classified key. The plan's mechanism requires a lane-admin PR (whose commits carry `Collab-Lane: <admin-slug>/<admin-lane>`) to edit a target lane file (`.kiro/specs/<target-slug>/lanes/<target>.md`). `classifyPath` at line 575 classifies the target file as `<target-slug>/<target>`, line 584 does not skip (the keys differ), and none of the exemptions at lines 586-590 apply. Line 591 emits an error. The plan's changes section mentions updating `validateLane` and `scopeCheck` but never mentions updating the `validate` function's cross-lane-file check. Without this update, every lane-admin PR would fail Collab handoff.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:574` — for (const f of k.files) {
  const c = classifyPath(f);
  if (!c) continue;
  const key = `${c.slug}/${c.lane}`;
  ...
  if (k.lane === key) continue;
  ...
  errors.push(`${short}: changes ${f} but its Collab-Lane is "${k.lane || 'none'}" (needs "${key}"...`);

Suggestion: Add an explicit exemption in `validate` (around line 584-591) for a `lane_admin` lane modifying a target lane file: when the committing lane's trusted front matter has `lane_admin: true`, `executor: kiro`, `reviewer_seat: agent:vitana-lane-reviewer`, and the changed file is a lane file within the admin lane's declared `paths`, skip the trailer-mismatch error. Include this in the `enforcement` lane's changes section, with a new test case.

### R1-F2 [major]

The plan modifies the PERM-change allow condition at line 683 to `(trustedFm.executor === 'claude' && claudeOnly) || laneAdmin`. Since `PERM` includes `paths`, `executor`, `seat`, and `reviewer_seat`, this lets a `lane_admin` lane change its OWN PERM fields (not just the target lane's). At line 686, when the change is allowed, `fm` keeps the head values (not pinned to trusted). So an admin lane could widen its own `paths` in a PR and immediately use the wider paths to edit additional target lane files, or change its own `executor` / `reviewer_seat` to escape the lane-admin constraints on future PRs. The plan promises 'Narrow paths stay narrow' but this exception contradicts it.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:679` — const PERM = ['executor', 'seat', 'reviewer_seat', 'paths'];
const changed = PERM.filter((k) => JSON.stringify(asList(trustedFm[k])) !== JSON.stringify(asList(fm[k])));
...
if (changed.length && !(trustedFm.executor === 'claude' && claudeOnly)) {
  errors.push(...);
}
if (!(trustedFm.executor === 'claude' && claudeOnly)) fm = { ...fm, ...Object.fromEntries(PERM.map((k) => [k, trustedFm[k]])) };

Suggestion: The `laneAdmin` exception should NOT apply to the admin lane's own PERM fields — only to PERM fields of a target lane file the admin lane is administering. Either (a) keep the PERM check unchanged for the admin lane's own front matter (the admin lane shouldn't need to change its own PERM fields in an admin PR), or (b) split the PERM-change check into 'own lane PERM' (never laneAdmin-exempt) and 'target lane PERM' (laneAdmin-exempt), which requires new logic to detect target-lane PERM changes (see R1-F1 — they aren't detected today at all).

### R1-F3 [major]

The plan says governance.ts's protected-gate unlock should 'replace the legacy claude review with the owner-instruction-backed reviewer-agent accept'. Currently `governanceMergeAllowed` (lines 186-189) requires `isLegacyClaudeReview(review)` for protected gate files. If changed to accept an agent review (`isAgentReview`), the PM's independent defense-in-depth layer for protected gate files is removed: any agent-reviewed lane PR touching protected gate files would pass the PM's governance guard. The 'owner instruction' is procedural and unverifiable in code. Today both queue.mjs (scope-check line 699) AND governance.ts (line 188) independently refuse protected gate files without a claude review. After this change only queue.mjs refuses, so a `--admin` override of Lane scope (allowed by the rules for governance-artifact false positives) would no longer be caught by the PM. The plan promises 'nothing becomes less protected than today' but this is a real protection reduction.

- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:186` — if (touchesProtectedGate(files)) {
  const unlocked =
    review != null && pr != null && isLegacyClaudeReview(review) && review.head_sha === pr.head_sha;
  return unlocked ? { ok: true } : { ok: false, reason: 'protected_gate_file' };
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:699` — else if (matchesAny(f, PROTECTED_GATE_PATHS)) errors.push(`${f} is a protected gate file ...`)

Suggestion: Keep `governanceMergeAllowed` returning `{ ok: false, reason: 'protected_gate_file' }` for all protected gate file PRs (the only programmatic unlock is retired, so the PM should ALWAYS refuse and require the owner instruction as an out-of-band override recorded in the lane log). Alternatively, introduce an explicit `owner_instruction` field in the review/PR data that the PM can verify, rather than silently accepting an agent review.

### R1-F4 [minor]

The plan says 'validateLane (:around 190)' but validateLane starts at line 206, and the protected-gate check is at lines 231-234. The trusted-source logic is claimed at ':671-677' but is actually at lines 664-670. The seat-ownership check is at lines 714-715, not ':711-715' (711 starts the review-entry validation branch).

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:206` — export function validateLane(fm, slug, lane, laneIds) {
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:664` — const mergeBase = gitOk(repo, ['merge-base', base, head]);
let trustedFm = mergeBase ? parseFrontMatter(showFile(repo, mergeBase, lanePath)) : null;
let trustedFrom = trustedFm ? 'merge-base' : null;
if (!trustedFm && planLaneQualifies(planLaneOnce())) { trustedFm = parseFrontMatter(plan.text); trustedFrom = trustedFm ? 'plan-pr' : null; }
if (!trustedFm && fetchLane) {
  trustedFm = parseFrontMatter(source === 'vitana-platform' ? text : fetchLane(lanePath));
  trustedFrom = trustedFm ? 'vitana-platform' : null;

Suggestion: Correct the line references in the plan to match the actual code: validateLane at line 206, trusted-source logic at lines 664-670, seat-ownership check at lines 714-715.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
