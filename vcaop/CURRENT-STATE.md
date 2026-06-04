# VCAOP — CURRENT STATE

> Resume file. Read this at the start of every session (runbook Sec. 11.2 step 1).
> Update after EVERY task (Sec. 11.1).

**Initiative:** VCAOP — Vitanaland Commerce & Account-Operations Platform
**Working branch:** `claude/vibrant-lovelace-DBM5k` (session-governed; specs authored on `feature/vcaop`)
**Mode:** Autonomous build, dev/staging only, mock-first (runbook Rev. 2)

---

## Current position

- **Current VTID:** `CTRL-GUARD-0001` (Guardrails package) — **DONE** (CI gate green)
- **Last action:** Built guardrails package + 50 tests (all green), wired `VCAOP-GUARDRAILS-CI.yml` as a required gate, committed (`c2aebb43`), pushed to `claude/vibrant-lovelace-DBM5k`, opened draft PR **#2585**. CI: `test:guardrails (must pass)` → **success**; `unit`, `scan`, `Validate Services Structure`, Phase 2B checks → success; `validate` was finishing.
- **Next action:** Begin `CTRL-SCHEMA-0002` — Prisma models (runbook Sec. 4.1–4.7) with reversible migrations; record rollback BEFORE applying (Sec. 0.7). Extend the existing OASIS Prisma schema in place (Sec. 1.1) — do NOT fork. Migration target requires the dev DB (BLOCKERS.md BLK-001); if no reachable dev Supabase, build the schema + reversible migration files and verify `prisma migrate` up/down against a local/ephemeral Postgres or mock, log the live-apply as blocked, and continue.

## Layer progress

| Layer | VTIDs | Status |
|-------|-------|--------|
| CTRL  | GUARD-0001 ✅, SCHEMA-0002, POLICY-0003, API-0004 | GUARD-0001 DONE (PR #2585); rest TODO |
| IAM   | ROLES-0001 | TODO |
| VAULT | CORE-0001, OTP-0002 | TODO |
| CONN  | BASE-0001, API-0002, OAUTH-0003, BROWSER-0004, MANUAL-0005 | TODO |
| KYB   | FLOW-0001 | TODO |
| AGNT  | CONDUCT-0001, WORKER-0002, VALID-0003, MONET-0004 | TODO |
| RWD   | AGG-0001, ATTR-0002, DIRECT-0003, LOYAL-0004 | TODO |
| CMRC  | CART-0001 | TODO |
| UIC   | WALLET-0001, CART-0002 | TODO |
| UIA   | CATALOG-0001, OPS-0002 | TODO |
| OBS   | KPI-0001 | TODO |
| CICD  | PIPE-0001 | TODO |

## Environment notes

- Dev environment target NOT yet confirmed via live `env-boundary` against a real dev Supabase/Cloud Run (no dev connection details present in this session's env). `env-boundary` is built and unit-tested against synthetic targets; live confirmation + dev deploy is a runtime prerequisite (see BLOCKERS.md).
- All third-party calls remain mock/fixture-only (runbook Sec. 0.2/0.5).

## Rollback notes (last migrate/deploy)

- None yet. No migration or deploy performed this session (guardrails layer is pure code + tests; no DB/Cloud Run changes).
