# Tasks: preview-gateway-recovery

<!-- lane: runtime-profile -->
## Lane runtime-profile
- [ ] Bring draft PR #5110 (GATEWAY_RUNTIME_PROFILE, fail-closed) onto a lane branch from origin/main; keep its tests.
- [ ] `npx jest test/runtime/preview-sparring-profile.test.ts test/runtime/preview-sparring-boot.test.ts`; full gateway typecheck.
**Acceptance**
- Change types: Backend
- `GATEWAY_RUNTIME_PROFILE` unset = `full`, unchanged boot; `preview-sparring` starts the HTTP API only; unknown value refuses to start.
- No worker, timer, warm or bootstrap starts above the guard (structural test, mutation-checked).

<!-- lane: preview-ops -->
## Lane preview-ops
- [ ] Move every file of `artifacts/` except the record and the patch to `scripts/aws/preview-gateway/` (manifest paths updated, checksums re-pinned).
- [ ] CI job runs `rehearse-restore.sh` (PostgreSQL 17 + PostgREST 12.2.3) and must report 0 failed.
- [ ] Node test: the overlay applied to `vitana-gateway-preview:1` (fixture, names only) passes every refusal check; a production-shaped value or name is refused.
**Acceptance**
- Change types: Infrastructure/CI, Tooling/docs
- Every script is dry run by default, pins account 472838866351 / eu-central-1, never prints a secret value, and has a rollback.

<!-- lane: plan-spar-token -->
## Lane plan-spar-token
- [ ] Apply `artifacts/plan-spar-token.patch` to `.github/workflows/PLAN-SPAR.yml` (protected gate file).
**Acceptance**
- Change types: Infrastructure/CI
- With `PLAN_SPAR_GATEWAY_TOKEN` set, PLAN-SPAR sends it and allocation is forced off; without it, behaviour is identical to today (the env value `''` becomes `'false'` when the variable is unset;
  `plan-spar.mjs` allocates only on the exact string `'true'`).
- Protected gate file (`protected_gate: two-model`, VTID-05765): merges only with two reviewer-agent accepts from two
  different chain models on the current head, the lane marker from a trusted revision, and the owner's instruction
  naming this plan for `PLAN-SPAR.yml` quoted or linked in the PR body.

<!-- lane: incident-record -->
## Lane incident-record
- [ ] `docs/ops/2026-11-17-preview-gateway-scale-down.md` from `artifacts/2026-11-17-scale-down-record.md`.
**Acceptance**
- Change types: Tooling/docs
- Records the two UpdateService calls (09:34:51Z, 09:34:52Z) from d.stevanovic@vitanaland.com; the reason stays "unconfirmed".

<!-- lane: overlay-paths -->
## Lane overlay-paths (late lane, `lane_admin`)
- [ ] O1 Claim `preview-gateway-recovery/overlay-paths` with a seat `jtadic` session; branch
      `kiro/preview-gateway-recovery/overlay-paths` from `origin/main`.
- [ ] O2 In `.kiro/specs/preview-gateway-recovery/lanes/runtime-profile.md` add exactly one entry to `paths`:
      `scripts/aws/preview-sparring/task-overlay.json`, as the last list element. Nothing else in the target changes
      (`state`, `next_actor`, `seat`, `executor`, `reviewer_seat`, `updated`, every log line).
- [ ] O3 Evidence `docs/validation/<VTID>/`: `acceptance.md`, `commands.log`, `scope.json`, `outputs/` with `queue.mjs
      validate` and `scope-check` for this lane, a byte check of the target, and the #5110 scope-check before and after.
**Acceptance**
- Change types: Tooling/docs
- The target lane file differs from `main` only by the one inserted path; its parsed front matter differs only in `paths`.
- Lane scope and Collab handoff pass on the lane head; the admin lane's own fields are unchanged from the trusted revision.
- With the target on `main`, Lane scope for a runtime-profile commit carrying #5110's diff reports no out-of-paths file.
