# Sparring round 2 — in_progress

Session: `8e2ff780-0c8c-4730-9181-adb96525b085` · plan hash `e7b4e47ba10e42c934b6d28cfd5f5493be0c1bfa731ef3962274ee0ebc7a9fc2`

## Summary

Round 2. All three Round 1 findings were accepted. R1-F2 is fully confirmed by code. R1-F3's lanes-table fix was applied but the prose body still carries two contradictory states for spar-vitana-v1-ref (re-raised as R2-F1, minor). Two new findings: R2-F2 (major) — the plan's "approved→executing self-block" has no machine enforcement; the lane state machine contains no blocked state and all ready lanes with next_actor: kiro/claude are immediately claimable after convergence, meaning the vitana-v1-premise gate accepted under R1-F1 is advisory prose only. R2-F3 (minor) — Decision 7 cites the wrong repo prefix for the NATIVE-CI.yml governance path.

## Findings

### R2-F1 [minor]

R1-F3 was accepted and the lanes table was corrected, but the prose body of the revised plan still contains two mutually contradictory paragraphs about the status of spar-vitana-v1-ref: one headed 'STILL PENDING, gates convergence' that asserts 'extra_refs appears 0 times in plan-spar.mjs on origin/main, so the vitana-v1 ref fix is NOT merged', and immediately after an UPDATE block stating 'spar-vitana-v1-ref is now MERGED to main (PR #4201, merge commit fa73aabd0)'. The pinned commit confirms no extra_refs in plan-spar.mjs (lines 192-194) and no vitana-v1 SHA step in PLAN-SPAR.yml (lines 79-82), consistent with the STILL PENDING paragraph — but that paragraph was not removed when the UPDATE was added, so the plan asserts both 'not merged' and 'merged' in the same document. R1-F3's suggestion was 'the plan text should have one consistent state for each lane'; the revision fixed the table but left the prose contradictory.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:192` — session = await client.create({
        plan_text: planText, producer: `ci-plan-spar.${slug}`, change_class: changeClass, base_ref: baseSha, repo, approval_policy: POLICY,
      });
- `exafyltd/vitana-platform:.github/workflows/PLAN-SPAR.yml:79` — node base/scripts/collab/plan-spar.mjs --dir head --base-sha "$BASE_SHA" --repo "${{ github.repository }}" \
              --changed "$RUNNER_TEMP/changed.txt" --summary "$GITHUB_STEP_SUMMARY"

Suggestion: Remove the entire 'STILL PENDING, gates convergence' paragraph (which was accurate at the time it was written but is now stale). Keep only the UPDATE paragraph (which reflects the current claimed state) and the lanes table row. The plan should have exactly one stated status per lane.

### R2-F2 [major]

The plan's 'approved→executing self-block' — the fix accepted for R1-F1 — has no machine enforcement. The lane state machine defines LANE_STATES as ['ready', 'executing', 'in-review', 'verified', 'done', 'parked'] with no 'blocked' state, and the PLAN_EDGES map shows approved: ['executing'] with no intermediate gate. The collaboration protocol says a session picks 'a lane whose next_actor is you, not blocked, not claimed' — 'blocked' here means depends_on dependencies not yet done, not an external prose condition. The env-profiles lane (no depends_on, next_actor: kiro) and fixture-gateway lane (no depends_on, next_actor: kiro) become immediately claimable the moment this session converges and the plan reaches approved state. Nothing in the state machine, the PR-GATE scope check, or the claim-ref protocol enforces 'wait until a fresh session's tool_log shows a successful read_file(repo: exafyltd/vitana-v1)'. A Kiro session following its automation could take env-profiles before that condition is met and build on premises (env.ts:82/:105/:189, app.config.ts:36, provider.ts:52) that remain unverified in this session. The self-block is advisory prose only.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:33` — export const LANE_STATES = ['ready', 'executing', 'in-review', 'verified', 'done', 'parked'];
const PLAN_EDGES = {
  drafted: ['sparred'],
  sparred: ['approved', 'drafted'],
  approved: ['executing'],
  ...
};
const LANE_EDGES = {
  ready: ['executing'],
  ...
- `exafyltd/vitana-platform:.claude/rules/collaboration.md:65` — Plan transitions: `drafted→sparred→approved→executing→in-review→verified→done`, `in-review→executing`,
`sparred→drafted`. Lane transitions: `ready→executing→in-review→verified→done`, `in-review→executing`. Any
non-terminal state → `parked` (set `parked_from`), and `parked` returns only to `parked_from`. `done` is terminal.
A new plan starts at `drafted`, a new lane at `ready`.
- `exafyltd/vitana-platform:.claude/rules/collaboration.md:108` — Unless the owner gave you a different task, pick a lane whose `next_actor` is you, not `blocked`, not claimed,
oldest `updated` first.

Suggestion: Machine-enforce the vitana-v1 verification gate by setting all non-spar lanes to state: parked (parked_from: ready) in their lane files at the time of plan convergence. Un-park them only after the plan coordinator (in a fresh session whose tool_log confirms a successful read_file on vitana-v1) advances the plan. Alternatively, add a sentinel lane (e.g. vitana-v1-verified, executor: claude, next_actor: claude) that all other lanes depend_on via depends_on; that lane's sole job is to run and confirm vitana-v1 access, then transition to done — which unblocks the rest via the existing depends_on machinery.

### R2-F3 [minor]

Decision 7 in the revised plan states 'only native-ci-workflow touches a governance path (vitana-platform:.github/workflows/NATIVE-CI.yml)' but per Decision 8 and the lanes table the actual target file is vitana-v1:.github/workflows/NATIVE-CI.yml — a new file being created in the vitana-v1 repo, not an existing file in vitana-platform. The wrong repo prefix in Decision 7 could mislead an executor into creating the workflow file in the wrong repository.

- `exafyltd/vitana-platform:.claude/rules/collaboration.md:99` — executor: kiro|claude` (who builds it), `reviewer_seat` (who reviews it: another Kiro
    seat, never the lane's own `seat`, or `claude`) and `paths` (globs of the only files the lane may change; required once
    it is `executing`). The PR-GATE check **Lane scope** fails a lane PR that changes anything else, and any change to a
    governance path (`.github/**`, `.claude/**`, `.kiro/steering/**`, `.kiro/automations/**`, `scripts/collab/**`,
    `CLAUDE.md`, `docs/programs/areas.yaml`) from a lane that is not `executor: claude`.
- `exafyltd/vitana-platform:.claude/rules/collaboration.md:9` — Owner decision 2026-10-13: Claude Code and Kiro IDE work as one team across hundreds of sessions, dozens of them in
parallel, **without the owner relaying anything between them**. Either agent writes plans; the other executes; the
other verifies. This file is identical in `exafyltd/vitana-platform` and `exafyltd/vitana-v1`; the Kiro twin is

Suggestion: In Decision 7, change 'vitana-platform:.github/workflows/NATIVE-CI.yml' to 'vitana-v1:.github/workflows/NATIVE-CI.yml' to match Decision 8 and the lanes table. The executor: claude conclusion and the governance-path reasoning are both correct and should be kept.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Rationale is sound: merging origin/main (containing fa73aabd0) into the plan branch so a fresh session's base checkout carries the vitana-v1 ref fix is the right mechanism. The approved→executing prose self-block is present. However, the machine-enforcement gap in that self-block is raised as new finding R2-F2.
- R1-F2: acknowledged — Confirmed by reading the code this round: plan-sparring-service.ts:86-132 shows extra_refs is accepted and validated against PLAN_SPARRING_REPOS; github-tools.ts:21 shows PLAN_SPARRING_REPOS = ['exafyltd/vitana-platform', 'exafyltd/vitana-v1']. The fix is indeed two files (plan-spar.mjs + PLAN-SPAR.yml), no gateway change required. Planner's rationale is fully verified.
- R1-F3: acknowledged — The lanes table was fixed and now shows spar-vitana-v1-ref as done (PR #4201). However, the prose body still has two contradictory paragraphs (STILL PENDING / UPDATE: MERGED) in the same document. The table fix alone does not satisfy R1-F3's requirement that 'the plan text should have one consistent state for each lane'. Re-raised as R2-F1.

## Next

Planner: answer every finding above in `sparring/s2-responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
