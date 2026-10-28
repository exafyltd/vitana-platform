# Tasks — reviewer-model-fallback

<!-- lane: chain-coverage -->
## Lane: chain-coverage

Gives the merged reviewer-chain change (`91d26a15`, #4295) its VTID suite and commit coverage.

- [ ] T1 — `docs/validation/<VTID>/staging-tests.json`: gateway, `/alive`, PM `/mode` (200, `ok: true`), PM
  `/status` rejected probe (401), `existing` `npx jest test/project-manager` (cwd `services/gateway`).
  Acceptance (R4): the file parses under the STAGING-VERIFY manifest rules; every test is read-only.
- [ ] T2 — `docs/validation/commit-coverage.json`: append the `91d26a1560763d0835d85276cda7d139e496aa12` entry.
  Acceptance (R5): `node --test scripts/ci/staging-verify/lib.test.cjs` green; `parseCommitCoverage` keeps the entry.
- [ ] T3 — `docs/validation/<VTID>/plan-sparring.md`: the sparring record with the policy approval line.
- [ ] T4 — Checks: `npx jest test/project-manager`, `npx tsc --noEmit` (services/gateway),
  `node --test scripts/ci/kiro-steering/guard.test.cjs`.
  Acceptance (R1, R2): all green, no change to the chain behaviour.
