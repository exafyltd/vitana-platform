# Sparring round 1 — in_progress

Session: `64363084-889a-4b1b-a227-b0edc72ee6f4` · plan hash `5269b61a872d9c5d16d4f7e02de3b318ad2896a59bcac7e2eec40049b975a36e`

## Summary

Three premises are false or unproven, producing two majors and one blocker-risk major. One additional minor. The core slot-skip/gate-watch design is structurally sound and guard.cjs compatibility is confirmed. The principal defects are: (1) D5 preflight provably omits two of the five PR-GATE verdict checks; (2) D3's hang-recovery mechanism has no implementation path because the "gated node" is never identified and the watchdog safety net has no sequencing guarantee relative to slot-sizing; (3) D4's structural rearrangement of wf.steps has no migration plan for the seven confirmed paused runs.

## Findings

### R1-F1 [major]

D5 preflight provably omits `gate.mjs weakening` and `gate.mjs red-green` from its command list, contradicting the plan's stated goal of running 'every governance check CI runs on a lane or plan( PR'.

- `exafyltd/vitana-platform:.github/workflows/PR-GATE.yml:72` — - name: Test-weakening guard
  id: weakening
  continue-on-error: true
  run: node scripts/ci/pr-gate/gate.mjs weakening --base "$BASE" --head "$HEAD"
...  weakening=${{ steps.weakening.outcome }}
  red-green=${{ steps.redgreen.outcome }}
- `exafyltd/vitana-platform:scripts/ci/pr-gate/config.json:1` — {
  "enforce": false,
  "note": "VTID-04950: PR-GATE starts report-only (plan rollout: 3 days on real PRs). Set enforce=true by PR to block on failures

Suggestion: Add `gate.mjs weakening --base <base> --head <head>` to the D5 preflight command list. Label it `report-only in CI (until enforce=true)` per the plan's own label scheme. Also add `gate.mjs red-green` with the same label; it exits early when there are no fix-kind VTIDs, so the cost is negligible. The plan's stated goal — byte-for-byte CI parity — requires all five verdict checks, not three. Omitting them while `enforce` is false is low-risk today, but (a) the plan's own guarantee is broken from day one, and (b) once `enforce` flips to `true` these become blocking failures that preflight would still miss.

### R1-F2 [major]

D3's hang-on-failure recovery is unimplementable as written: 'the gated node' is never identified in run-gate.cjs's config, the engine state schema is admittedly undocumented, and the safety-net watchdog has no sequencing guarantee over slot-sizing — meaning the fallback for D3 may not exist when slot-sizing's gated workflow first goes live.

- `exafyltd/vitana-platform:.kiro/workflows/vitana-pipeline.workflow.json:80` — "type": "repeat",
"id": "lane-slot-1",
"maxIterations": 40,
"onMaxIterations": "continue",
"stopWhen": "{{land-1.output}} contains VITANA_SLOT_DONE"
- `exafyltd/vitana-platform:scripts/collab/store-review.cjs:95` — module.exports = { store, runDirFrom, verdictFrom, laneFrom };

Suggestion: D3 needs three concrete additions before the coder lane can implement it correctly: (1) specify a `gatedNodeId` config key on every skip-watch config so run-gate.cjs knows which workflow node to look up in the engine state (e.g., `"gatedNodeId": "lane-slot-1"`); (2) document the expected field path inside workflow-state.json (e.g., `steps[id].status`) as a best-effort fixture — even if version-sensitive — so there is a starting implementation rather than a blank page; (3) add a `depends_on: [slot-sizing]` to restart-watchdog (or at minimum a 'merge slot-sizing only after restart-watchdog is live' instruction in the driver), so the R2 watchdog safety net is guaranteed to exist before the structural workflow change deploys. Without (3) the plan's own risk ladder (D3 → R2 → watchdog) has a gap in the middle.

### R1-F3 [major]

D4 structurally relocates five previously top-level workflow steps (investigate, spec, plan-pr, spar-loop, merge-plan) into nested gate parallels. The plan documents seven currently-paused runs and provides no migration guidance; any of those paused at a now-nested step will fail on resume against the new workflow file.

- `exafyltd/vitana-platform:.kiro/workflows/vitana-pipeline.workflow.json:15` — "type": "parallel",
"id": "investigate",
"joinPolicy": "allSettled" ... "type": "step",
"id": "spec" ... "type": "step",
"id": "plan-pr" ... "type": "repeat",
"id": "spar-loop" ... "type": "step",
"id": "merge-plan"
- `exafyltd/vitana-platform:.github/workflows/PR-GATE.yml:1` — # PR-GATE — mechanical damage protection before merge

Suggestion: Add a mandatory pre-merge step for slot-sizing: before slot-sizing's lane PR may be merged, the owner must inspect-and-close (or complete) all active runs using the watchdog tool (which will exist by then if restart-watchdog merges first). Enforce this ordering by adding `depends_on: [restart-watchdog]` to the slot-sizing lane. Alternatively, document in the slot-sizing lane file that the merge commit comment must confirm 'zero active pipeline runs at time of merge', because the engine will be presented with a structural change to a workflow that in-flight state is based on. This is not theoretical: §2.8 explicitly counted seven paused runs.

### R1-F4 [minor]

D3 specifies that run-gate.cjs reads `~/.kiro/sessions/*/workflows/<wf id>/workflow-state.json` using a wildcard glob, but Node.js `fs` has no native glob support. On the Windows target the implementation must fall back to `fs.readdirSync(os.homedir()+'/.kiro/sessions/')` enumeration, which is not stated. The plan's own 'tolerant of absence → idle' policy means any traversal failure silently disables D3 entirely.

- `exafyltd/vitana-platform:scripts/collab/store-review.cjs:1` — stdin (Kiro command watch): {"cursor":…,"config":{"run":"<setup output>","model":"<pinned id>","slot":"<N>",
  "output":"<the review step's output>"},"workspacePath":"…"}
- `exafyltd/vitana-platform:.github/workflows/UNIT.yml:16` — - name: Script unit tests (node:test, no install)
  run: |
    FILES=$(find scripts -path '*/node_modules' -prune -o \( -name '*.test.cjs' -o -name '*.test.mjs' \) -print | sort)

Suggestion: In the run-gate.cjs spec (or in the slot-sizing coder's impl-notes), explicitly state: 'enumerate `os.homedir()/.kiro/sessions/` with `fs.readdirSync`, for each entry check `<dir>/workflows/<wfId>/workflow-state.json` existence before reading'. Also add a test fixture that covers the case where `.kiro/sessions/` does not exist (returns idle), so the silent-failure path is exercised. This is low-severity because R2 is the acknowledged recovery path, but without the explicit enumeration pattern, the coder will likely attempt a glob and be surprised by the Node.js limitation.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
