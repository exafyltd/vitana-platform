# Plan sparring record — reviewer-model-fallback (VTID-05335)

Copy of the sparring record for the `chain-coverage` lane, carried into the VTID's validation folder so the
evidence travels with the change. Source of truth: `.kiro/specs/reviewer-model-fallback/sparring/` on `origin/main`.

## Verdict / policy approval

**CONVERGED** and approved by policy `converged-auto-v1` at **2026-10-22T13:36:26.068+00:00**.

- Session: `a64cc2b2-9167-48f0-af23-be70c780596c`
- Final plan hash: `e94a76d9d40ea093625c855e335d1bfc5362c86d412eda2e05b8a448f720ec1c`
- Rounds: 3 (converged on round 3, no findings)
- VTIDs: VTID-05335
- Partner: independent, adversarial (`agent:plan-sparring-partner`), read-only over plan + code
- Plan sparred: the already-merged three-model reviewer chain of #4295
  (commit `91d26a1560763d0835d85276cda7d139e496aa12`), recording and proving the change — not re-deciding the owner's
  2026-10-21 fallback instruction.

## Round 1 — 3 findings (2 major, 1 minor), all accepted

- **R1-F1 [major]** — `staging-tests.json` omitted the mandatory `reason` (≥10 chars) on the `existing` test
  (`lib.cjs:192`), and `check-pr` exits early for a docs-only PR (`run.mjs:469`, deploy paths `lib.cjs:36`), so a
  malformed manifest would only fail post-merge in STAGING-VERIFY. **Accepted** — the `existing` jest entry now carries
  the reason, and Verification adds a local `lib.validateManifest(m,{vtid,service:'gateway'})` step before the lane PR.
- **R1-F2 [major]** — the plan mis-described the protected-gate unlock: `governanceMergeAllowed` (`governance.ts:180`)
  short-circuits on `touchesProtectedGate` and unlocks only via `isLegacyClaudeReview` (`governance.ts:137`) on the
  current head; agent accepts and any "owner instruction" are not evaluated. **Accepted** — the lane PR is docs-only
  and changes neither `governance.ts` nor its test; any future `governance.ts` amendment goes in its own PR that states
  it needs a legacy `claude` approve (seat-`claude` approve or owner admin merge), never the automated PM merge.
- **R1-F3 [minor]** — two test line-range citations were understated (`governance.test.ts` near-miss `it.each` closes
  at :247; the Claude-only assert is `guard.test.cjs:98`). **Accepted** — citations corrected to
  `governance.test.ts:216-247` and `guard.test.cjs:92-99`.

## Round 2 — 1 new finding (major), accepted; R1-F1/F2/F3 acknowledged addressed

- **R2-F1 [major]** — keeping `governance.ts`/`governance.test.ts` in the lane's `paths` interacts with
  `governanceMergeAllowed`'s `pr?.files ?? lane.paths` fallback: if the observer omits `pr.files`,
  `touchesProtectedGate(lane.paths)` is true and the merge is blocked with `protected_gate_file` unless a legacy
  `claude` approve on the current head is present — contradicting the "merges via the automated PM accept" assertion.
  **Accepted** — the lane must keep `governance.ts` in `paths` (it is the recorded owner of the `91d26a15` change rule
  47 counts; the coverage entry and lane name the same file). The plan now states that the live observer supplies
  `pr.files` from `pulls/<n>/files` for an active lane PR (`observe-live.ts:384-405`, `:683`), so the docs-only PR is
  normally judged on its real files and merges on the agent accept; if `pr.files` is absent (`types.ts:106-107`) the PR
  falls into the protected-gate fork, is not guaranteed to merge on the agent accept, and needs a legacy `claude`
  approve on the current head. The driver does not route around it; such a lane is parked with the five-part stop
  message.

## Round 3 — converged, no findings

Partner independently verified the key premises: with `pr.files` present (docs-only) both `touchesProtectedGate` and
`laneTouchesGovernance` return false (governance.ts is in `PROTECTED_GATE_GLOBS`, not `GOVERNANCE_PATHS`), so the merge
proceeds on the agent accept; `observe-live.ts` supplies `pr.files` (up to 1000 files, no truncation for a docs-only
PR); the staging probe routes are real (`/mode` public → 200 `{ok:true}`, `/status` → 401 without a bearer);
`parseCommitCoverage` (`lib.cjs:280-292`) matches the coverage entry shape. The residual `pr.files`-absent fallback is
correctly flagged as not-guaranteed and parked for the owner. **No new findings; the plan is sound and ready.**
