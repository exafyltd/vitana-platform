---
change_class: standard
---
# plan(gateway-write-auth): authenticate the unguarded governance write routes and remove the VTID deadlock from the lane lifecycle

Author: Claude (cloud session, `session_01Cp885EzYih8JDbJhVcrTJq`), planner. Scope: vitana-platform. Supersedes the code-only PR #5106, whose
implementation is carried into the lanes below without change to its security behaviour. Strategy blocker B3 (SB-CON-22).

<!-- plan:begin -->
## 0. Premises to check first
Each is verified on `origin/main` at `67897e6c`:
1. `services/gateway/src/middleware/require-service-or-admin.ts:71` `requireServiceOrAdmin` (service token or exafy_admin JWT, fail-closed), `:64` `gatewayServiceAuthHeader`.
2. Unguarded write routes: `routes/specs.ts:537,745,854,1024`; `routes/triage-agent.ts:168`; `routes/ai-personality.ts:69,120`; `routes/llm.ts:165,236`. `routes/specs.ts:1182` and `routes/llm.ts:520` already guarded.
3. `routes/llm.ts` read the audit actor from `x-actor-id` / `x-actor-role` headers (spoofable) before this plan.
4. `scripts/ci/command-hub-ownership-guard.js:1052` `ALLOWED_VTID_PATTERN` is a hand-maintained list of VTIDs; `:1113` `evaluateMarkerAuthorization` checks only that list or the `DEV-COMHU` marker.
5. `.github/workflows/PLAN-SPAR.yml:45` runs sparring only on PRs whose title starts with `plan(`; `scripts/collab/plan-spar.mjs:231` `allocateLanes` allocates a VTID per lane lacking one and is idempotent (it skips lanes with a `vtid`).
6. `scripts/collab/queue.mjs:64` `SESSION_RE` accepts `session_…` and `kiro-…` ids only.
7. The PR gates require a VTID in the title (`validate-pr` via `validator-path-guard.cjs`; `change-suite` via `scripts/ci/staging-verify/run.mjs check-pr`). Neither can pass for a code PR that never enters `plan(` sparring.
8. `test/vtid-04696-staging-checks-follow-asset-bumps.test.ts`: every `docs/validation/*/staging-tests.json` must name the asset version `index.html` loads. A bump therefore touches those files.

## 1. Why the lifecycle deadlocks
A back-end change is sparred before it has a VTID (rules 51–55). The only producer of VTIDs is the `plan(` path. A code PR that does not come through that path has no VTID, so `validate-pr`, `change-suite` and the Command Hub guard fail forever, and nothing in the lifecycle moves it onto the path. A second, independent block is the guard's static list: even an allocated VTID fails it. The fix is structural: the lane file, which CI writes, is the one authority for a VTID and for the paths it may touch, and the gates read it.

## 2. Changes
- **Lane A `command-hub-lane-guard`** (build first). The Command Hub guard authorises a frontend edit when the PR title or branch carries a VTID that names a lane whose declared `paths:` cover every changed Command Hub file. The static list stays only as history for VTIDs already shipped; it is no longer the way a new VTID is authorised.
- **Lane B `gateway-write-guards`** (depends on A). Lands the eight guards, the caller updates, the llm audit actor from the verified identity, the Command Hub header changes, the `index.html` cache-bust, the staging-suite version updates (31 files), the symbol index regeneration and the two pinned tests. Content is the PR #5106 commits `55df6aa9`, `d61978e4`, `bb738c03` (on `ccr-7abb241c-onup8r`), moved here without change.
- **Lane C `lane-pr-artifacts`** (depends on A). After CI allocates a lane VTID, a script writes the PR title (`VTID-xxxxx (<slug>/<lane>): …`), the branch key, and `docs/validation/<VTID>/{scope.json,acceptance.md,staging-tests.json}` from the lane file, idempotently: a lane that already has a VTID reuses it and a file that exists is not rewritten with a different VTID. This removes the manual step behind the three checks.

## 3. Constraints kept
- No VTID is written by hand. Lanes carry no `vtid` in this plan; `allocateLanes` writes it after policy approval (`converged-auto-v1`).
- Security: nothing is weakened. The route guards stay fail-closed and each route keeps its test. The human-only production publish boundary (`POST /publish` is `requireAdminAuth`) is unchanged, and Lane B keeps its test that pins it.
- No change to the sparring gate mode, the ledger auth mode, or any gate's enforcement setting.
- Idempotency: every script in Lanes A and C is a no-op on a second run with the same inputs.

## 4. Test plan
- Lane A: unit tests for the guard decision: a lane VTID with covering paths passes; the same VTID with an uncovered Command Hub file fails; no VTID fails; the legacy list still passes its historical VTIDs.
- Lane B: `test/governance-write-route-auth.test.ts` (61 tests), `test/specs-generate-claim.test.ts`, `test/delivery/command-hub-delivery.test.ts`, `test/vtid-04696-staging-checks-follow-asset-bumps.test.ts`, and the full gateway Jest suite (1776 suites passed locally on the PR head).
- Lane C: a test that runs the artifact step twice and asserts identical output and no second VTID.
- CI: `validate-pr`, `change-suite` and Path Ownership Guard green on the lane PR head.

## 5. Decisions taken (conservative)
- Lane B keeps one lane rather than splitting the cache-bust: the bump and the pins must land together or the staging check fails.
- The static allow-list is not removed. Removing it would alter the meaning of shipped history; Lane A only stops it being the sole authority for new work.
- Lane C does not change the sparring gate. It only automates artifacts after allocation.
<!-- plan:end -->
