# VTID-05085 — acceptance (sparring record + Kiro work package, docs only)

This PR ships documentation only: the converged plan-sparring record for the Unified Card System
(VTID-05085/05086/05087) and the Kiro work package. Nothing deploys, so there is no Gate 2.
Kiro's Phase 1 PR appends its own AC entries below these.

VALIDATION_PROFILE: gateway_backend

AC-1 `plan-sparring.md` carries the approved plan; the sha256 of the text between the plan markers equals the hash recorded in the ledger and the record (`e7abbebb…a238ab7`).
TEST: python3 hash of the text between `<!-- plan:begin -->` and `<!-- plan:end -->` in docs/validation/VTID-05085/plan-sparring.md (outputs/plan-hash.log)

AC-2 Every correction the work package gives Kiro is true in the code today: `social_connections` has `is_active`/`disconnected_at` and no `status`; the social router is mounted at `/api/v1/social-accounts`; `fetchUserDiaryStreak` exists; `/me/profile`, `/connectors`, `/calendar`, `/comm/media-hub` are routes and `/comm/create-post` is not.
TEST: grep checks in commands.log (outputs/code-facts.log)

AC-3 VTID-05086 and VTID-05087 point at the same record and hash.
TEST: grep e7abbebb1e777f3aa27eea0356a5ca697328ee180c32a24e04150e2f5a238ab7 docs/validation/VTID-05086/plan-sparring.md docs/validation/VTID-05087/plan-sparring.md

## Decisions taken
- One VTID per phase (three), because each phase ships and is staging-verified separately.
- The ledger rows carry `metadata.executor = kiro` and no `autonomous_execution` flag, so the worker-runner never claims them (VTID-03516).
