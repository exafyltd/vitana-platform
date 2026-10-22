# Plan — reviewer-model-fallback

Put the already-merged three-model reviewer chain (#4295, commit `91d26a1560763d0835d85276cda7d139e496aa12`)
through the pipeline it skipped: spar it, give it a CI VTID, a read-only staging suite and a
`commit-coverage.json` entry, so STAGING-VERIFY rule 47 stops failing on it.

<!-- plan:begin -->
## Problem

PR #4295 (`plan(reviewer-model-fallback): reviewer agent falls back across three models`) merged to `main` as
`91d26a1560763d0835d85276cda7d139e496aa12` on 2026-10-22 under an owner-authorized admin merge. It carried no
`.kiro/specs/reviewer-model-fallback/` files, so PLAN-SPAR (`.github/workflows/PLAN-SPAR.yml` `paths:`) never ran,
no sparring record exists and no VTID was allocated.

Among its 15 files it changed gateway code:

- `services/gateway/src/services/project-manager/governance.ts`
  - line 35: new `REVIEWER_AGENT_MODELS = Object.freeze(['claude-sonnet-5.5', 'claude-opus-5.5', 'claude-sonnet-4.5'])`;
  - line 41: `REVIEWER_AGENT_MODEL` becomes `REVIEWER_AGENT_MODELS[0]` (was the literal `'claude-sonnet-5.5'`);
  - line 130: `AGENT_REVIEWER_VALUES` accepts `agent:vitana-lane-reviewer (<m>)` for every chain model;
  - line 133-134: `isAgentReview` therefore counts an `accept` from any chain model (used at lines 162 and 196 and by
    `decide.ts:213` `isAgentReview(review)` in the verify decision).
- `services/gateway/test/project-manager/governance.test.ts` lines 216-241: chain order, Claude-only, exact identity
  strings accepted, near-miss strings rejected.

The gateway staging deploy of `91d26a15` was verified by STAGING-VERIFY run 39749935077: 20/20 tests passed, but the
run failed on rule 47 alone (a `services/gateway` commit with no VTID and no change suite). Every gateway commit in
`a2d069ea..91d26a15` (production..staging) now waits on it for Gate 2.

The owner instruction behind the change (2026-10-21): "if one model is not available it should pick up another one
as fallback ... then a third one". The plan below does not re-decide that instruction; it records the change, proves
it with tests and gives it the coverage rule 47 requires.

## Goal

1. A converged, policy-approved sparring record for exactly the `91d26a15` reviewer-chain change.
2. One CI-allocated VTID for the lane below.
3. `docs/validation/<VTID>/staging-tests.json` (read-only, gateway service) and a
   `docs/validation/commit-coverage.json` entry mapping `91d26a1560763d0835d85276cda7d139e496aa12` to that VTID, so
   the next gateway STAGING-VERIFY whose range contains `91d26a15` lists it as covered instead of missing.

## Behaviour being recorded (no change to it)

- A review entry counts as the reviewer agent's accept when `Collab-Reviewer` is exactly
  `agent:vitana-lane-reviewer` or `agent:vitana-lane-reviewer (<m>)` with `<m>` one of the three chain models, the
  verdict is `accept`, and it is on the PR's current head (`reviewOnCurrentHead`, unchanged).
- Any other model string, a suffix, a missing parenthesis, another agent name or a `null` reviewer never counts
  (`governance.test.ts:221-241`).
- The chain is Claude-only (`governance.test.ts:218`); no Google or non-Claude model can enter it.
- Protected gate files, legacy seat approvals, governance-lane rules and the stale-head rule are unchanged.
- The chain is mirrored in `scripts/ci/kiro-steering/guard.cjs:104` `REVIEWER_MODELS`; `guard.test.cjs:92-97` parses
  the governance.ts literal and asserts parity (run by PR-GATE). Both landed in the same commit and are unchanged here.

## Scope (lane `chain-coverage`)

- `docs/validation/<VTID>/staging-tests.json` — service `gateway`, read-only:
  - `GET /alive` → 200;
  - `GET /api/v1/project-manager/mode` → 200, `{ok: true}` (public route, `routes/project-manager.ts`): proves the
    PM module that imports `governance.ts` loaded on the deployed commit;
  - `GET /api/v1/project-manager/status` with an invalid bearer → 401 (`rejected_probe`): auth gate unchanged;
  - `existing`: `npx jest test/project-manager` in `services/gateway` — the governance unit tests are the proof of
    the chain behaviour, because the PM's merge decision cannot be exercised read-only on staging (rule 48).
- `docs/validation/commit-coverage.json` — one `covers[]` entry
  `{sha: 91d26a1560763d0835d85276cda7d139e496aa12, vtid: <VTID>, reason: <this suite covers the governance.ts chain change of #4295>, approved_by: "owner, 2026-10-21 reviewer fallback instruction; converged-auto-v1 <sparring record>"}`,
  in the format `scripts/ci/staging-verify/lib.cjs:280-292` parses.
- `docs/validation/<VTID>/plan-sparring.md` — copy of the sparring record and verdict.
- Lane `paths` also list `services/gateway/src/services/project-manager/governance.ts` and
  `services/gateway/test/project-manager/governance.test.ts` so that a code amendment the sparring partner requires
  can be made in the same lane. governance.ts is a protected gate file (collaboration.md §3a): a lane PR that changes
  it needs a legacy `claude` review on the current head or the owner's instruction, in addition to the reviewer-agent
  accept. If no amendment is required, the lane PR changes only `docs/validation/**`.

## Out of scope

- Reverting or redesigning the chain (owner instruction; a services-only revert would also break
  `guard.test.cjs:96` in PR-GATE).
- `.claude/rules/collaboration.md`, `.kiro/**`, `scripts/ci/kiro-steering/**`, `scripts/collab/**` changes of #4295
  (governance/docs paths; not part of rule 47, which only counts deploying service paths).
- Any other commit in the production..staging range.

## Verification

- Local: `npx jest test/project-manager` and `npx tsc --noEmit` in `services/gateway`;
  `node --test scripts/ci/kiro-steering/guard.test.cjs`; `node --test scripts/ci/staging-verify/lib.test.cjs` (coverage parse).
- The commit-coverage entry is validated by `lib.cjs` `parseCommitCoverage` (full 40-hex sha, VTID pattern,
  non-empty reason and approved_by) and only applies because `91d26a15`'s subject carries no VTID (`lib.cjs:304-307`)
  and the VTID has a `staging-tests.json` (`lib.cjs:321-325`).
- Staging: the next gateway STAGING-VERIFY on a commit containing the entry lists `91d26a15` as covered, runs this
  suite and passes. Read-only; nothing targets production.

## Risks

- Coverage entries can hide an unverified change. Mitigation: the entry names one sha, this VTID's own suite runs the
  governance tests that pin the exact changed behaviour, and the sparring record is linked in `approved_by`.
- The staging HTTP probes do not exercise the chain itself (no read-only surface exposes it). Accepted: rule 48 puts
  write-path proof in CI tests; the `existing` jest entry is that proof.
<!-- plan:end -->
