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
- With `PLAN_SPAR_GATEWAY_TOKEN` set, PLAN-SPAR sends it and allocation is forced off; without it, behaviour is byte-identical to today.
- Merges only on the owner's instruction naming this plan plus a reviewer-agent accept on the current head.

<!-- lane: incident-record -->
## Lane incident-record
- [ ] `docs/ops/2026-11-17-preview-gateway-scale-down.md` from `artifacts/2026-11-17-scale-down-record.md`.
**Acceptance**
- Change types: Tooling/docs
- Records the two UpdateService calls (09:34:51Z, 09:34:52Z) from d.stevanovic@vitanaland.com; the reason stays "unconfirmed".
