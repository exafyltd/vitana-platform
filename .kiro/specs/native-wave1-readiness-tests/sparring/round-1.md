# Sparring round 1 — in_progress

Session: `5f2b3055-4acc-4eb6-be8e-6b1f1f4c44df` · plan hash `ca41cbaa252718beeda7945a0170a4aaa2ac15c9eeab3d91d2e67cf7227c98e2`

## Summary

The plan is well-structured and conservative (new test files only, no source changes). However, the vitana-v1 repo is not pinned in this review session, so none of the core premises about Jest config, existing test files, source code line numbers, or helper exports can be verified against actual code. Within the verifiable scope (vitana-platform governance tooling), I found a concrete lane-scope defect that would block the evidence gate, and flagged the unverifiable premises.

## Findings

### R1-F1 [major]

The lane scope declares `docs/validation/VTID-*/{scope.json,staging-tests.json,plan-sparring.md}` but omits `acceptance.md` and `commands.log`, which are two of the three required evidence files. land-guard.mjs (line 31) defines `EVIDENCE_FILES = ['acceptance.md', 'commands.log', 'scope.json']` and the `evidenceMissing` function (lines 38-41) enforces that all three exist before a code commit. The plan's own Measurement section says each lane reports via `docs/validation/<VTID>/acceptance.md`, which contradicts the scope glob. The established convention (VTID-05541, VTID-05542) uses `docs/validation/VTID-XXXXX/**` to cover all validation artifacts.

- `exafyltd/vitana-platform:scripts/collab/land-guard.mjs:31` — export const EVIDENCE_FILES = ['acceptance.md', 'commands.log', 'scope.json'];
...
return EVIDENCE_FILES.map((f) => `docs/validation/${vtid}/${f}`).filter((p) => !have.has(p));
- `exafyltd/vitana-platform:docs/validation/VTID-05541/scope.json:14` — "docs/validation/VTID-05541/**"
- `exafyltd/vitana-platform:docs/validation/VTID-05542/scope.json:19` — "docs/validation/VTID-05542/**"

Suggestion: Change the lane scope docs glob from `docs/validation/VTID-*/{scope.json,staging-tests.json,plan-sparring.md}` to `docs/validation/VTID-*/**` (matching the established convention) so that `acceptance.md` and `commands.log` are in scope and the evidence gate passes.

### R1-F2 [blocker]

Every factual premise about vitana-v1 is unverifiable because that repo has no pinned ref in this review session. The plan's entire Measured State section — Jest config (`roots`, `testMatch`), existence and case-counts of 20+ test files, helper exports (`fakeGateway`, `makeWrapper`, `createSupabaseDouble`, `fakeSession`), source file symbols and line numbers (`AuthGate` at `src/shell/AuthGate.tsx:36`, `LOCALES` at `src/i18n/index.ts:16`, `oauthErrorKey` at `src/auth/sign-in.ts:69`, etc.), the non-existence of `tests/wave1-readiness/`, and the gap analysis — rests on vitana-v1 code that cannot be read. If any of these premises are wrong (file renamed, line numbers shifted, symbol removed, Jest config changed, helper API different), the lanes will produce tests that fail or target the wrong code. The plan declares it was pinned at vitana-v1 commit e31bf46, but the review session only pins vitana-platform@6dc6e1b.

- `exafyltd/vitana-platform:docs/programs/native-app/program.md:6` — repos: [vitana-v1, vitana-platform]

Suggestion: Either (a) pin vitana-v1 in the review session so premises can be verified, or (b) add a lane-zero pre-flight step that re-checks every premise (file existence, line numbers, symbol grep, Jest config roots/testMatch, helper export names) against the vitana-v1 pin before any test file is written, and fails the lane if any premise is stale. Without this, the plan is building on unverified ground.

### R1-F3 [minor]

The plan cites `land-guard.mjs:40` for the evidence file list (`acceptance.md`, `commands.log`, `scope.json`). The `EVIDENCE_FILES` constant is actually on line 31; line 40 is inside the `evidenceMissing` function body. This is a minor inaccuracy in the citation.

- `exafyltd/vitana-platform:scripts/collab/land-guard.mjs:31` — export const EVIDENCE_FILES = ['acceptance.md', 'commands.log', 'scope.json'];
export const OK_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);
...
export function evidenceMissing(paths, vtid) {
  const have = new Set(paths);
  return EVIDENCE_FILES.map((f) => `docs/validation/${vtid}/${f}`).filter((p) => !have.has(p));
}

Suggestion: Correct the citation to `land-guard.mjs:31` (constant) or `:38-41` (function).

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
