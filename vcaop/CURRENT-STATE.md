# VCAOP — CURRENT STATE

> Resume file. Read this at the start of every session (runbook Sec. 11.2 step 1).
> Update after EVERY task (Sec. 11.1).

**Initiative:** VCAOP — Vitanaland Commerce & Account-Operations Platform
**Working branch:** `claude/vibrant-lovelace-DBM5k` (session-governed; specs authored on `feature/vcaop`)
**Mode:** Autonomous build, dev/staging only, mock-first (runbook Rev. 2)

---

## Current position

- **Current VTID:** `CTRL-POLICY-0003` (policy seeds) — **DONE**
- **Last action:** Added `src/policy/provider-policy-seeds.ts` — 20 conservative provider seeds (all `registration_method=human_required`, `captcha_policy=human_only`, `multi_account_allowed=false`); `seedPolicyEngine()` loader; cashback gated (affiliate networks allow, marketplaces null, loyalty false). 10 new tests; full suite **60/60 green**, typecheck clean. Added a "Unit tests (full suite)" step to `VCAOP-GUARDRAILS-CI.yml`.
- **Previously:** `CTRL-GUARD-0001` DONE (guardrails + gate, PR #2585); `CTRL-SCHEMA-0002` DONE (16 Prisma models, reversible migration verified up→down→up on ephemeral Postgres).
- **Next action:** `CTRL-API-0004` — VCAOP REST API on the Gateway: `/providers /accounts /jobs /tasks /affiliate-programs /rewards /cart /policies /approvals /audit`. Behind authz; every write emits an OASIS event **in the same tx** as the read-model write; no PII in logs; OpenAPI generated. Mount under the existing `services/gateway` Express app (Sec. 1.1). Use the guardrails (policy-engine, no-pii-leak, human-gate, env-boundary) on every handler.

## Layer progress

| Layer | VTIDs | Status |
|-------|-------|--------|
| CTRL  | GUARD-0001 ✅, SCHEMA-0002 ✅, POLICY-0003 ✅, API-0004 | 3/4 DONE; API-0004 next |
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

- **CTRL-SCHEMA-0002 migration** (`prisma/migrations/20260604_vcaop_ctrl_schema_0002/`):
  rollback = `psql "$DATABASE_URL" -f .../down.sql` (drops the 16 VCAOP tables CASCADE,
  leaves OASIS tables intact). Tested up→down→up on ephemeral Postgres. NOT yet applied
  to a live dev DB (BLK-001) — live apply + down-verify is the runtime step.
