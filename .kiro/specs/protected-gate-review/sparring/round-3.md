# Sparring round 3 — converged

Session: `efb325d3-2b7b-4734-9d87-86434474508e` · plan hash `c71025024344afef824dedd642c884b5787879f57d1754184c7e61c754b71a64`

## Summary

Round 3 review of the revised plan. The plan has properly addressed R2-F1 (land-guard.mjs correctly identified as governance path, not protected gate file). The two deferred findings (R2-F2 and R2-F3) have reasonable rationale — specifying concrete assertions and code-level mechanisms for all three options before the owner's Gate 1 choice is indeed premature. The plan commits to updating the relevant files in the Change section. One minor new finding about incomplete cataloguing of stale text locations. The plan is in good shape for a decision-framework plan.

## Findings

### R3-F1 [minor]

The plan's 'Stale text (R1-F5)' section catalogues stale rule descriptions in collaboration.md §3a and queue.mjs near line 89, but omits governance.ts's header comment (lines 4-7) which contains the identical stale description: 'needs the owner's instruction naming the plan plus a reviewer-agent accept on the current head (Claude Code is retired, VTID-05408).' Additionally, the inline protected-file list in collaboration.md (lines 141-144) is missing the two VTID-05765 additions (`.github/workflows/VTID-ALLOCATE.yml` and `scripts/collab/gate-invariants.test.mjs`). Both are covered by the Change section's scope, but an implementer relying on the Stale text analysis could miss these locations.

- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:4` — * PROTECTED GATE FILE. This file is itself on the protected list below, so a
* change to it never merges on a reviewer-agent accept alone: it needs the
* owner's instruction naming the plan plus a reviewer-agent accept on the
* current head (Claude Code is retired, VTID-05408).
- `exafyltd/vitana-platform:.claude/rules/collaboration.md:141` — `CLAUDE.md`, `scripts/collab/plan-spar.mjs`, `scripts/collab/queue.mjs`, `scripts/collab/protected-gate-files.json`,
`services/gateway/src/services/plan-sparring/**`, `services/gateway/src/services/project-manager/governance.ts`,
`.github/workflows/PLAN-SPAR.yml`, `.github/workflows/PR-GATE.yml`, `.github/workflows/AWS-PROD-*.yml`,
`.kiro/agents/vitana-lane-reviewer.md`, `supabase/migrations/*vtid_ledger*.sql`, `supabase/migrations/*plan_sparring*.sql`.
- `exafyltd/vitana-platform:scripts/collab/protected-gate-files.json:17` —     ".github/workflows/VTID-ALLOCATE.yml",
    "scripts/collab/gate-invariants.test.mjs"

Suggestion: Add governance.ts lines 4-7 to the 'Stale text' catalogue, and note that the inline protected-file list in collaboration.md §3a is two entries behind protected-gate-files.json (missing VTID-ALLOCATE.yml and gate-invariants.test.mjs). This gives the implementer a complete inventory of stale locations.

## Acknowledgements of earlier responses

- R2-F2: acknowledged — Deferral is reasonable. The concrete assertions depend on which option the owner picks, and writing them for all three options is premature. The plan's Change section commits to updating gate-invariants.test.mjs as part of the implementation PR. The origin/main baseline test provides a safety net: the old checkInvariants runs against the new checkout, so an implementer cannot weaken existing invariants. The gap remains that NEW bypass-path assertions won't be sparred until the implementation is reviewed, but that's acceptable given the plan is structured as a decision framework.
- R2-F3: acknowledged — Deferral is reasonable for the same reasons as R2-F2. The plan correctly describes the policy intent for each option and identifies all three enforcement points (queue.mjs, land-guard.mjs, governance.ts) that must be updated. The code-level mechanism (new parameters, validation logic) is implementation detail that depends on the chosen option. The two-model gate on the implementation PR itself ensures the code will be reviewed by two distinct models before landing.
