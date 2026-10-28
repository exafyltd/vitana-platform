# Sparring round 1 — in_progress

Session: `0921821e-6c01-41f0-8784-58227461ddae` · plan hash `42b0ffe6949929dee5bc2976911fb164c7f2c5a896e1769c28079fb77caaed70`

## Summary

The plan is well-scoped and most of its premises about the existing codebase are accurate. The key concern is that while the plan adds `land-guard.mjs` as an enforcement tool and adds rule 13 to `common-rules.md`, the existing pipeline step documents (`lane-land.md`, `driver.md`) that explicitly instruct sessions to call the unguarded commands (`queue.mjs release`, raw merge) are not updated. This creates contradictory guidance even though common-rules.md is technically binding. There is also ambiguity about how `land-guard.mjs` will consume the protected-gate-file glob matching (import vs reimplement).

## Findings

### R1-F1 [major]

lane-land.md step 3f explicitly tells sessions to call `queue.mjs release <slug>/<LANE> --session <id>` directly (line 51), and step 3d tells them to merge directly under §7b (lines 38-40). driver.md step 9 tells sessions to delete the heartbeat ref directly (line 81-82). These are the exact bypass paths land-guard.mjs is meant to guard. The plan adds rule 13 to common-rules.md but leaves these step texts unchanged, creating contradictory instructions. While common-rules.md is 'binding for every pipeline step', an agent following the step text literally will use the unguarded commands. The plan's §5 explicitly excludes `driver.md` from changes but does not mention `lane-land.md` at all.

- `exafyltd/vitana-platform:.kiro/pipeline/lane-land.md:38` — Wait (poll 2-3 min, max 60 min) for every required check green on that exact head, then merge at once under
       the §7b rule (common rule 4) with the method recent merged PRs use; ... Release the claim (`queue.mjs release <slug>/<LANE> --session <id>`).
- `exafyltd/vitana-platform:.kiro/pipeline/driver.md:81` — 9. **Done**: plan `done`, `_plan` claim released, and the heartbeat ref removed as the last action
   (`git push origin --delete refs/heads/collab-driver/<slug>`; it holds no work).
- `exafyltd/vitana-platform:.kiro/pipeline/common-rules.md:1` — # Common rules (binding for every pipeline step)

Suggestion: Either (a) add `.kiro/pipeline/lane-land.md` to the lane paths and update steps 3d/3f to call `land-guard.mjs merge` / `land-guard.mjs release` instead of the raw commands, or (b) explicitly acknowledge lane-land.md and driver.md as bypass-path follow-ups (like the PreToolUse guard in §6) and add them to the same follow-up list. Option (a) is preferred since `.kiro/pipeline/` is not a governance path and would not complicate the lane's reviewer setup.

### R1-F2 [minor]

The plan says land-guard.mjs has 'no dependencies' yet its `merge` subcommand must match changed files against globs in `protected-gate-files.json` using 'queue.mjs glob semantics'. It must either import `globToRegex`/`matchesAny`/`PROTECTED_GATE_PATHS` from queue.mjs (an intra-repo dependency, contradicting the 'no dependencies' framing) or reimplement them (risking divergence from queue.mjs lines 111-127). The plan does not state which approach is used.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:111` — /** Glob → RegExp: `**` any path (incl. `/`), `*` within one segment, `?` one char. `dir/**` also matches `dir`. */
export function globToRegex(glob) { ... }
export const matchesAny = (file, globs) => asList(globs).some((g) => globToRegex(g).test(file));
- `exafyltd/vitana-platform:scripts/collab/protected-gate-files.json:1` — { "schema": "vitana.protected-gate-files/v1", ... "globs": [ ... ] }

Suggestion: Clarify in the plan that land-guard.mjs imports `globToRegex` and `matchesAny` (or `PROTECTED_GATE_PATHS`) from `queue.mjs`, and reword 'no dependencies' to 'no npm dependencies' to avoid confusion. Importing from a co-located module is fine and prevents divergence.

### R1-F3 [minor]

The `review` subcommand's entry-only check allows 'commits that change only `.kiro/specs/<slug>/lanes/<lane>.md`', but collaboration.md §3 (lines 102-104) also allows 'a `pm-agent` lane-state commit' after the reviewed head. A pm-agent commit that touches `handoff.md` on a lane's PR branch would be rejected by the guard even though §3 considers the review still valid. While unlikely today on a lane branch, the guard's definition of entry-only should match the protocol definition.

- `exafyltd/vitana-platform:.claude/rules/collaboration.md:99` — `agent: vitana-lane-reviewer` (else: blocker, ignore that file and try the next; `unstated` or the bare identity
   never counts on a new entry).
   ...An entry counts for the **current head** when
   `Collab-Reviewed-Head` equals the PR head, or every commit after it only appends review entries to this lane file
   (front matter unchanged) or is a `pm-agent` lane-state commit.

Suggestion: The `review` subcommand's entry-only pattern should also accept commits whose author is `pm-agent` (verifiable via `Collab-Session: pm-agent` trailer in the compare range), matching the §3 definition. Add a test case for a pm-agent commit after the reviewed head.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
