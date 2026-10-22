# Tasks — staging-verify-runner-fix

<!-- lane: runner -->
## Lane `runner` — runner image + allowlisted env (vitana-platform)
- [ ] R1 `lib.test.cjs`: cases for the `existing` `env` allowlist and `existingEnv`, written first, red on main.
- [ ] R2 `lib.cjs`: `EXISTING_ENV_ALLOW`, `env` validation in `validateTest` `existing`, export `existingEnv`.
- [ ] R3 `run.mjs` `runExisting`: merge `lib.existingEnv(t)` into the explicit env.
- [ ] R4 `STAGING-VERIFY.yml` `verify` only: `runs-on: ubuntu-24.04` with a comment (`report` unchanged).

**Acceptance (reviewer agent):** new tests red on main and green on the head; `node --test
scripts/ci/staging-verify/lib.test.cjs scripts/ci/staging-verify/workflow.test.cjs` green; `production` and unknown
keys rejected; `runExisting` passes no secret and no `process.env` spread; only these four files changed; PR-GATE,
Collab handoff and Lane scope green; no live write.

<!-- lane: manifests -->
## Lane `manifests` — native change-suite commands (vitana-v1)
- [ ] M1 `VTID-05298/staging-tests.json`: `npm run gen:i18n` before `npx jest tests/news`; `env: {APP_PROFILE:
      development}` on `npm run bundle`.
- [ ] M2 `VTID-05296/staging-tests.json`: `npm run gen:i18n` before `npx jest tests/community` (no `--config`);
      `env: {APP_PROFILE: development}` on `npm run bundle`.
- [ ] M3 Before merge: vitana-platform main exports `existingEnv` (`node -e`, output in the PR); both manifests pass `lib.validateManifest` from that main; the commands
      run locally in `apps/mobile` (`npm run gen:i18n && npx jest tests/news`, `npx jest tests/community`,
      `APP_PROFILE=development npm run bundle`).

**Acceptance (reviewer agent):** only the two manifests change; no suite is removed or weakened (every existing entry
is still present); the commands pass locally; PR-GATE and Lane scope green.
