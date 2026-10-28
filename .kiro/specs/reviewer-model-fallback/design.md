# Design — reviewer-model-fallback

## Current code (premises, cited at origin/main)
- `services/gateway/src/services/project-manager/governance.ts:35` `REVIEWER_AGENT_MODELS` (frozen, three Claude
  models); `:41` `REVIEWER_AGENT_MODEL = REVIEWER_AGENT_MODELS[0]`; `:130` `AGENT_REVIEWER_VALUES`; `:133-134`
  `isAgentReview`; callers `:162`, `:196`, `decide.ts:213`.
- `services/gateway/test/project-manager/governance.test.ts:216-247` pins the chain and the identity strings.
- `scripts/ci/kiro-steering/guard.cjs:104` `REVIEWER_MODELS` mirror; parity test `guard.test.cjs:92-99`.
- `scripts/ci/staging-verify/lib.cjs:280-292` `parseCommitCoverage`; `:304-307` coverage only for a commit with no
  VTID in its subject; `:321-325` the covering VTID needs `docs/validation/<VTID>/staging-tests.json`.
- `services/gateway/src/routes/project-manager.ts` `GET /mode` (public) and `GET /status` (`requireServiceOrAdmin`).

## Changes (lane `chain-coverage`)
1. `docs/validation/<VTID>/staging-tests.json` — the four tests of plan §Scope, same shape as
   `docs/validation/VTID-05274/staging-tests.json`.
2. `docs/validation/commit-coverage.json` — append one `covers[]` entry for `91d26a15` (existing VTID-05236 entry kept).
3. `docs/validation/<VTID>/plan-sparring.md` — the sparring record.
4. No governance.ts / governance.test.ts change in this lane PR; any future amendment is a separate PR needing a legacy `claude` approve (`governanceMergeAllowed`, `governance.ts:180`).

## Testing
`npx jest test/project-manager`, `npx tsc --noEmit` (services/gateway), `node --test
scripts/ci/kiro-steering/guard.test.cjs`, `node --test scripts/ci/staging-verify/lib.test.cjs`.
