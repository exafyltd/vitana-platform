# VTID-05303 — fake-checks-dedupe (lane 2, ci-github-modernization)

Lane scope: `.github/workflows/CICDL-GATEWAY-CI.yml` + `docs/validation/**` only.
Base: `origin/main` @ `d592ad98c265edd41112f2db1232866d0572ec7a` (plan merge).

## T1 — Dead commented-out "Gateway Tests" block removed

The commented-out step block (marker `# TESTS DEFERRED TO DEV-CICDL-0035`) was
deleted from `CICDL-GATEWAY-CI.yml`. It was never a live step and was never
re-enabled; real gateway Jest runs in `TEST-SUITE.yml` (4-shard matrix). The
live `Report Validation Success` step was preserved; its echo lines were updated
to drop the now-stale "builds successfully" / "linted" claims (the lint step was
already removed under VTID-04950) and to point at where the build and Jest
actually run.

No test was re-enabled, deleted, or loosened by this change.

## T2 — Duplicate gateway build de-duplicated

The gateway `build` ran in two workflows on the same PRs:

- `CICDL-GATEWAY-CI.yml` → step `Gateway Build Check` (`pnpm run build`, in
  `services/gateway`).
- `ENFORCE-FRONTEND-CANONICAL-SOURCE.yml` → step `Build gateway` (`npm run
  build`, in `services/gateway`). This workflow triggers on `[pull_request]`
  with **no path filter**, so it builds the gateway on every PR, and it is the
  **sole required check** for the canonical-source gate.

`TEST-SUITE.yml` / `PR-GATE.yml` do **not** build the gateway (TEST-SUITE runs
only `npx jest`; PR-GATE installs gateway deps only conditionally for fix-VTIDs),
so they are not the duplicate.

Resolution: keep the build in `ENFORCE-FRONTEND-CANONICAL-SOURCE.yml` (the
required check) and remove the duplicate `Gateway Build Check` step from
`CICDL-GATEWAY-CI.yml`. The `Install gateway dependencies` step in CICDL is kept
because the retained `Gateway Type Check` (`tsc --noEmit`) and
`Validate Dev frontend navigation spec` steps still need the gateway's locked
deps.

`ENFORCE-FRONTEND-CANONICAL-SOURCE.yml` (the required check) was **not** edited
by this lane. The de-dup was achievable without touching it, so no Gate 2
surfacing of a required-check edit is needed for this lane.

### Build coverage after de-dup

| build runner | trigger | path filter | required check |
|---|---|---|---|
| `ENFORCE-FRONTEND-CANONICAL-SOURCE.yml` → `Build gateway` | `pull_request` | none (every PR) | yes |
| `CICDL-GATEWAY-CI.yml` → (removed) | — | — | — |

The gateway `npm run build` gate still runs on every PR via the required ENFORCE
check; coverage is unchanged, duplication removed.

## T3 — Before/after job set (measured proof)

Single CI job in `CICDL-GATEWAY-CI.yml`: `gateway-validation`. Step list:

### Before (`origin/main`, 13 steps)
1. Checkout
2. Setup pnpm
3. Setup Node.js
4. Set Test Environment
5. Install Dependencies
6. Prisma Generate
7. Prisma Migrate
8. Prisma Validate
9. Install gateway dependencies
10. **Gateway Build Check**  ← removed (T2, duplicate of ENFORCE build)
11. Validate Dev frontend navigation spec (17 modules / 87 screens)
12. Gateway Type Check
13. Report Validation Success

Plus a commented-out `Gateway Tests` block between steps 12 and 13 (not a live
step) — removed (T1).

### After (head, 12 steps)
1. Checkout
2. Setup pnpm
3. Setup Node.js
4. Set Test Environment
5. Install Dependencies
6. Prisma Generate
7. Prisma Migrate
8. Prisma Validate
9. Install gateway dependencies
10. Validate Dev frontend navigation spec (17 modules / 87 screens)
11. Gateway Type Check
12. Report Validation Success

Delta: −1 live step (`Gateway Build Check`); commented-out `Gateway Tests` block
removed. No step added. `ENFORCE-FRONTEND-CANONICAL-SOURCE.yml` unchanged
(5 steps, still runs `Build gateway`).

## Acceptance (R1-F1, R1-F2)
- [x] Commented `Gateway Tests` step is gone.
- [x] Live `Report Validation Success` step intact.
- [x] Gateway build no longer duplicated between CICDL and the required ENFORCE
  check (CICDL build removed; ENFORCE build retained).
- [x] `ENFORCE-FRONTEND-CANONICAL-SOURCE.yml` not silently changed (not changed
  at all).
- [x] Before/after job set recorded (above).
- [x] UNIT.yml not rewritten; no other workflow touched.

## Verification
- Both `CICDL-GATEWAY-CI.yml` and `ENFORCE-FRONTEND-CANONICAL-SOURCE.yml` parse as
  valid YAML (js-yaml load, `jobs` present). See `commands.log`.
