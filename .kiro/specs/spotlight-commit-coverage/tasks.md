# Tasks — spotlight-commit-coverage
Authoritative plan: `plan.md`. VTID: allocated by PLAN-SPAR.

<!-- lane: coverage-manifests -->
## coverage-manifests — vitana-v1, docs only
Allowed paths: `docs/validation/commit-coverage.json`, `docs/validation/VTID-*/**`.

- [ ] C1. `docs/validation/commit-coverage.json`: the 10 entries of `plan.md` premise 4 (full sha, lane VTID,
  reason, `approved_by` naming the owner's 2026-10-26 approval).
- [ ] C2. No new suite for VTID-05285–05294: they exist on main (plan premise 3). Confirm each validates.
- [ ] C3. `docs/validation/<lane VTID>/staging-tests.json` (the lane's own suite: the same refs) and `commands.log`.
  It records each suite green, plus a `planRange` dry run (`missing: []`, 10 covered, 0 invalid) that is red
  without the coverage file.

Acceptance:
- The dry run shows `missing: []` and 10 `covered` on the lane head, against 10 `missing` on `origin/main`.
- Every new manifest passes `validateManifest`, and each suite passes locally.
- Only the allowed paths change. No app code. Nothing writes to a live system.
<!-- lane: coverage-manifests -->
