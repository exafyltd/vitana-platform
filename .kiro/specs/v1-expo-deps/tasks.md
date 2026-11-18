# Tasks — v1-expo-deps
Authoritative plan: `plan.md`. VTID: allocated by PLAN-SPAR after approval.

<!-- lane: expo-deps -->
## expo-deps — apps/mobile Expo packages match `expo install --check` (repo vitana-v1)
Allowed paths (in `exafyltd/vitana-v1`):
- `apps/mobile/package.json`
- `apps/mobile/package-lock.json`
- `docs/validation/VTID-*/**`

- [ ] E1. Record `npm run deps:check` red on `origin/main` (the eight packages of plan P1).
- [ ] E2. Set the eight versions to the ones the check expects; regenerate `package-lock.json` with `npm install` in `apps/mobile`.
- [ ] E3. `docs/validation/<VTID>/commands.log`: red → green for `deps:check`, plus `npm test -- --ci` and `npm run typecheck`.

Acceptance:
- `npm run deps:check` exits 0 on the lane head and exits 1 on `origin/main`.
- `npm test -- --ci` and `npm run typecheck` in `apps/mobile` pass. GitLab `mobile-test` is green on the MR.
- Only the allowed paths change. No test is weakened. Nothing writes to a live system.
<!-- lane: expo-deps -->
