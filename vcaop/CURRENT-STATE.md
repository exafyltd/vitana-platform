# VCAOP — CURRENT STATE

> Resume file. Read this at the start of every session (runbook Sec. 11.2 step 1).
> Update after EVERY task (Sec. 11.1).

**Initiative:** VCAOP — Vitanaland Commerce & Account-Operations Platform
**Working branch:** `claude/vibrant-lovelace-DBM5k` (session-governed; specs authored on `feature/vcaop`)
**Mode:** Autonomous build, dev/staging only, mock-first (runbook Rev. 2)

---

## Current position

- **Current VTID:** `VAULT-OTP-0002` (alias mailbox + OTP) — **DONE**
- **Last action (VAULT-OTP-0002):** Added `src/vault/mailbox.ts` — deterministic per-onboarding alias (`provider+<slug>-<onboardingId>@system-domain`), `assertSystemAlias` (refuses personal inboxes), OTP + verification-link extraction, `resolveVerificationStep()`, and `InMemoryMailbox`. AC met: a simulated verification link/OTP resolves a job step; inboxes isolated per alias. 7 tests; full suite **91/91 green**. **VAULT layer complete.**
- **Prev current VTID:** `VAULT-CORE-0001` (vault / TOTP) — DONE
- **Last action (VAULT-CORE-0001):** Added `services/vcaop/src/vault/` — `SecretStore` interface (+ in-memory impl; Secret Manager impl is the runtime concern, BLK-001), RFC-4226/6238 `totp.ts` (HOTP+TOTP+base32+verify), and `Vault` (putCredential→ref, **scoped short-lived** issuance that never returns the long-lived secret, putTotpSeed/generateTotp/verifyTotp, recovery codes stored **hashed**, single-use). **TOTP verified against RFC-6238 Appendix B + RFC-4226 Appendix D vectors.** Vault refs pass `no-credential-store`. 16 new tests; full suite **84/84 green**, typecheck clean.
- **Prev current VTID:** `IAM-ROLES-0001` (RLS + role matrix) — DONE (verified on ephemeral Postgres; live-apply blocked on BLK-001)
- **Last action (IAM-ROLES-0001):** Added `prisma/migrations/20260605_vcaop_iam_roles_0001/` — 20 RLS policies over 16 tables + `vcaop_uid()`/`vcaop_role()` helpers (Supabase-GUC based); reversible `down.sql`. **Verified on ephemeral Postgres as non-superuser with role switching:** community own-only; staff sees back-office but CANNOT approve human tasks or edit policy (0 rows); admin can (1 row); developer catalog-read-only. Rollback up→down→up clean (20→0→20). Added app-level `test/iam/iam.test.ts` (4 tests, runs in CI). Full suite now **74/74**.
- **Prev current VTID:** `CTRL-API-0004` (VCAOP REST API) — DONE (core router + tests); 2 follow-ups open
- **Last action:** Built `src/api/` — Express router for `/providers /policies /accounts /jobs /tasks /approvals /affiliate-programs /rewards /cart /audit`, over a `Repository` + `OasisSink` abstraction (in-memory impls for tests). Cross-cutting: header→`AuthContext` authz with role matrix; every write emits a **sanitized** OASIS event (PII redacted + asserted, Sec. 9); responses strip `*_ref`/secret keys (secrets unreadable via API); account create enforces single-identity; human-task approvals are admin-only (staff cannot self-approve). 11 supertest tests; full suite **70/70 green**, typecheck clean.
- **Follow-ups (tracked, not blocking next VTID):** (1) mount the router into the real `services/gateway` Express app with a Prisma-backed `Repository` that writes the OASIS event in the **same DB transaction** as the read-model write; (2) generate OpenAPI. Both recorded in BLOCKERS/this file; the second needs the gateway integration.
- **Previously:** `CTRL-GUARD-0001` DONE (guardrails + gate, PR #2585); `CTRL-SCHEMA-0002` DONE (16 Prisma models, migration verified up→down→up on ephemeral Postgres); `CTRL-POLICY-0003` DONE (20 policy seeds).
- **Next action:** `CONN-BASE-0001` — `Connector` interface + base class enforcing policy-engine / human-gate / CAPTCHA→task / env-boundary on every method (Sec. 4.4). **AC:** gates not bypassable. Build `src/connectors/Connector.ts` + `BaseConnector` that wraps `register/verify/operate/healthCheck` with the guardrails. Then `CONN-API/OAUTH/BROWSER/MANUAL` adapters (mocks; verify each vendor per Sec. 0.8 → DECISIONS/BLOCKERS). **Sec. 0.8 vendor verification starts here** — log findings (SP-API/eBay/Shopify/Skyvern/etc.) before wiring any real adapter; build mocks to the interface and continue.

## Layer progress

| Layer | VTIDs | Status |
|-------|-------|--------|
| CTRL  | GUARD-0001 ✅, SCHEMA-0002 ✅, POLICY-0003 ✅, API-0004 ✅* | **CTRL layer complete** (API has 2 follow-ups) |
| IAM   | ROLES-0001 ✅ | **DONE** (RLS verified on ephemeral PG; live-apply blocked BLK-001) |
| VAULT | CORE-0001 ✅, OTP-0002 ✅ | **VAULT layer complete** |
| CONN  | BASE-0001, API-0002, OAUTH-0003, BROWSER-0004, MANUAL-0005 | next |
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
