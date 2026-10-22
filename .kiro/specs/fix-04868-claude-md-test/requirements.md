# Requirements — fix-04868-claude-md-test
Authoritative plan: `plan.md` (between the plan markers). This file adds acceptance criteria only.
## R1 — the VTID-04868 session-layer test passes on the current CLAUDE.md
WHEN `cd services/gateway; npx jest test/vtid-04868-plan-sparring-session-layer.test.ts` runs on the lane branch,
THEN every case passes. On `origin/main` the same command fails, on exactly the line-42 assertion
`expect(md).toMatch(/Step 0 \(VTID-04868\): spar the plan first\./);`.
## R2 — the guard keeps its intent and is not weaker
The replaced assertion pins the current canonical §4.1 wording of CLAUDE.md (`CLAUDE.md:498`):
`expect(md).toContain('**It is allocated only after its plan is sparred and approved** (Part 1 rules 51–55)');`
(U+2013 EN DASH in `51–55`). It is one literal single-line match for one literal single-line match: no OR fallback,
no regex widening, a longer and more specific string. It fails if §4.1 loses the sparring-before-allocation sentence
or its link to rules 51–55. Every other assertion of the file is unchanged.
## R3 — nothing else changes
`CLAUDE.md` and every file in `scripts/collab/protected-gate-files.json` are untouched. No other test, no Jest config
and no workflow changes. The lane diff is the test file plus `docs/validation/<VTID>/**`.
## R4 — evidence and staging
`docs/validation/<VTID>/` holds `acceptance.md`, `commands.log`, `outputs/` (red-on-main and green-on-branch Jest
output) and a read-only `staging-tests.json` (GET `/alive`, the Jest file as an `existing` entry). The merge deploys
gateway staging (`services/gateway/**`); STAGING-VERIFY for the merge commit passes before Gate 2.
