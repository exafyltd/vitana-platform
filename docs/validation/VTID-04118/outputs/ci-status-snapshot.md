# VTID-04118 — CI status snapshot at evidence-pack write time

Head commit under test: 86a9d98 (services/gateway/test/... fix)

| Check | Status |
|---|---|
| autopilot-worker (jest) | success |
| oasis-projector (jest) | success |
| worker-runner (jest) | success |
| openclaw-bridge (vitest) | success |
| vcaop (jest) | success |
| Validate Services Structure | success |
| Gateway Validation (Minimal CI) | success |
| check-phase-2b-docs | success |
| Reporter Script Validation | success |
| Enforce Phase 2B Naming Standards | success |
| scan | success |
| validate | success |
| Prisma Schema Check | success |
| unit | success |
| Gateway (Jest, ~7.5k tests) | in_progress (was FAILING on the prior commit, exactly the assertion this PR's own test fix addresses) |
| Gateway Service Tests | in_progress |
| validate-pr | failure — this evidence pack + PR body markers are the fix for this exact check |
