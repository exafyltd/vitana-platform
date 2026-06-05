# VCAOP — CURRENT STATE

> Resume file. Read this at the start of every session (runbook Sec. 11.2 step 1).
> Update after EVERY task (Sec. 11.1).

**Initiative:** VCAOP — Vitanaland Commerce & Account-Operations Platform
**Working branch:** `claude/vibrant-lovelace-DBM5k` (session-governed; specs authored on `feature/vcaop`)
**Mode:** Autonomous build, dev/staging only, mock-first (runbook Rev. 2)

---

## Current position

- **Current VTID:** `CMRC-CART-0001` + `OBS-KPI-0001` + **mock E2E (DoD Sec. 0.9)** — **DONE**
- **Last action (CMRC/OBS/E2E):** `src/commerce/` (Universal Cart + checkout ladder UCP→Shopify-agent→Violet→Rye→Skyvern; multi-merchant routing; non-dismissible FTC disclosure; per-merchant SubID), `src/observability/kpi.ts` (KPIs from OASIS projections), and **`test/e2e/mock-e2e.test.ts` proving BOTH DoD flows**: (1) onboard mock supplier→operate; (2) shop mock merchant→SubID→wallet credit→confirm postback→reversal. Full suite **153/153 green**.
- **Prev:** RWD layer complete; AGNT layer complete; KYB-FLOW-0001 done.
- **Last action (AGNT):** `src/agents/` — llm-router (PLANNER→claude/WORKER→gemini-flash/VALIDATOR→claude), `Conductor.planJob` (policy→connector tier + steps; refuses denied), `Worker.executePlan` (runs plan via a Connector; human-gated/CAPTCHA steps → `human_required`+blocked, never skipped; mock onboarding + mock cart route end-to-end), `Validator` (rejects auto-completed human-gated steps; refuses commission confirm without a verified postback), `Monetization.selectRoute` (best aggregator-vs-direct route; **never picks affiliate_cashback_allowed=false for cashback**; deterministic per-user SubID + projected reward). 12 tests; full suite **137/137 green**.
- **Prev current VTID:** `CONN-*` (CONN layer complete); `KYB-FLOW-0001` DONE.
- **Last action (CONN-BROWSER-0004):** `src/connectors/browser-connector.ts` over swappable `BrowserDriver` (Skyvern/Stagehand class) — isolated profile per (provider,account), artifacts scrubbed via no-pii-leak + asserted PII-free, CAPTCHA fixture→`CaptchaEncountered`→human task, irreversible submit→human gate, live driver refused unless explicitly allowed (mock/fixture-only in CI). **(CONN-MANUAL-0005):** `manual-connector.ts` — human-task generator with pre-filled, **PII-free** payload (references + field names; raw identity stays in the RLS portal), asserted via no-pii-leak. Also: `register` policy now allows any non-denied level (human-gate does the real restriction) + overridable `buildRegistrationTaskPayload` hook on BaseConnector. 17 new tests; full suite **120/120 green**.
- **Prev current VTID:** `CONN-OAUTH-0003` — DONE
- **Last action (CONN-OAUTH-0003):** Added `src/connectors/oauth-connector.ts` — token lifecycle over swappable `OAuthClient`+`TokenStore`: proactive refresh near expiry, refresh-on-401 + backoff retry, **refresh-token revocation → `markDegraded` + REAUTH human task (halts)**. Added `REAUTH` to human-gate actions (additive gate) and `markDegraded` to `JobContext`. healthCheck reports degraded on missing/expired token. 6 tests; full suite **110/110 green**.
- **Prev current VTID:** `CONN-API-0002` (ApiConnector) — DONE (mock; vendor SDKs unverified — BLK-002)
- **Last action (CONN-API-0002):** Added `src/connectors/api-connector.ts` — `ApiConnector` over a swappable `ApiClient` interface; `MockApiClient` + provider stubs (amazon/ebay/walmart/cj). operate/healthCheck round-trip through the mock; register human-gated; default-deny for unknown providers. No live calls (Sec. 0.5/0.8). Logged VER-002 / BLK-002 (vendor SDK+auth not independently verified this pass; mock-to-interface). 6 tests; full suite **104/104 green**.
- **Prev current VTID:** `CONN-BASE-0001` — DONE
- **Last action (CONN-BASE-0001):** Added `src/connectors/` — `Connector` interface (Sec. 4.4) and `BaseConnector` that routes every method (register/verify/operate/healthCheck) through the guardrails **before** the adapter hook runs: env-boundary, policy-engine (default-deny, mode→action mapping), human-gate (human-required registration emits a human_task + halts), CAPTCHA→`CaptchaEncountered`. Adapters implement `do*` hooks only and never see an ungated call. 7 tests prove gates fire before adapter logic; full suite **98/98 green**.
- **Prev current VTID:** `VAULT-OTP-0002` — DONE
- **Last action (VAULT-OTP-0002):** Added `src/vault/mailbox.ts` — deterministic per-onboarding alias (`provider+<slug>-<onboardingId>@system-domain`), `assertSystemAlias` (refuses personal inboxes), OTP + verification-link extraction, `resolveVerificationStep()`, and `InMemoryMailbox`. AC met: a simulated verification link/OTP resolves a job step; inboxes isolated per alias. 7 tests; full suite **91/91 green**. **VAULT layer complete.**
- **Prev current VTID:** `VAULT-CORE-0001` (vault / TOTP) — DONE
- **Last action (VAULT-CORE-0001):** Added `services/vcaop/src/vault/` — `SecretStore` interface (+ in-memory impl; Secret Manager impl is the runtime concern, BLK-001), RFC-4226/6238 `totp.ts` (HOTP+TOTP+base32+verify), and `Vault` (putCredential→ref, **scoped short-lived** issuance that never returns the long-lived secret, putTotpSeed/generateTotp/verifyTotp, recovery codes stored **hashed**, single-use). **TOTP verified against RFC-6238 Appendix B + RFC-4226 Appendix D vectors.** Vault refs pass `no-credential-store`. 16 new tests; full suite **84/84 green**, typecheck clean.
- **Prev current VTID:** `IAM-ROLES-0001` (RLS + role matrix) — DONE (verified on ephemeral Postgres; live-apply blocked on BLK-001)
- **Last action (IAM-ROLES-0001):** Added `prisma/migrations/20260605_vcaop_iam_roles_0001/` — 20 RLS policies over 16 tables + `vcaop_uid()`/`vcaop_role()` helpers (Supabase-GUC based); reversible `down.sql`. **Verified on ephemeral Postgres as non-superuser with role switching:** community own-only; staff sees back-office but CANNOT approve human tasks or edit policy (0 rows); admin can (1 row); developer catalog-read-only. Rollback up→down→up clean (20→0→20). Added app-level `test/iam/iam.test.ts` (4 tests, runs in CI). Full suite now **74/74**.
- **Prev current VTID:** `CTRL-API-0004` (VCAOP REST API) — DONE (core router + tests); 2 follow-ups open
- **Last action:** Built `src/api/` — Express router for `/providers /policies /accounts /jobs /tasks /approvals /affiliate-programs /rewards /cart /audit`, over a `Repository` + `OasisSink` abstraction (in-memory impls for tests). Cross-cutting: header→`AuthContext` authz with role matrix; every write emits a **sanitized** OASIS event (PII redacted + asserted, Sec. 9); responses strip `*_ref`/secret keys (secrets unreadable via API); account create enforces single-identity; human-task approvals are admin-only (staff cannot self-approve). 11 supertest tests; full suite **70/70 green**, typecheck clean.
- **Follow-ups (tracked, not blocking next VTID):** (1) mount the router into the real `services/gateway` Express app with a Prisma-backed `Repository` that writes the OASIS event in the **same DB transaction** as the read-model write; (2) generate OpenAPI. Both recorded in BLOCKERS/this file; the second needs the gateway integration.
- **Previously:** `CTRL-GUARD-0001` DONE (guardrails + gate, PR #2585); `CTRL-SCHEMA-0002` DONE (16 Prisma models, migration verified up→down→up on ephemeral Postgres); `CTRL-POLICY-0003` DONE (20 policy seeds).
- **Next action:** Remaining VTIDs are UI + CICD, both partially human/runtime-blocked:
  - `UIC-WALLET-0001`, `UIC-CART-0002` (community UI) and `UIA-CATALOG-0001`, `UIA-OPS-0002` (admin UI) — require the existing Vitanaland Next.js/React apps; the data/logic/API they bind to is DONE. Next session: detect the frontend app structure and wire surfaces, OR (if no frontend app reachable) build the view-model layer + log a BLOCKER for the actual component wiring.
  - `CICD-PIPE-0001` — pipeline workflow can be authored; the deploy-to-dev step is blocked by BLK-001 (no dev Cloud Run/Supabase). Author the workflow with the dev `gcloud run deploy --source` step gated/mock and log the blocker.
  - API follow-ups still open: mount the VCAOP router into `services/gateway` with a Prisma-backed repo (same-tx OASIS write) + OpenAPI.

## Layer progress

| Layer | VTIDs | Status |
|-------|-------|--------|
| CTRL  | GUARD-0001 ✅, SCHEMA-0002 ✅, POLICY-0003 ✅, API-0004 ✅* | **CTRL layer complete** (API has 2 follow-ups) |
| IAM   | ROLES-0001 ✅ | **DONE** (RLS verified on ephemeral PG; live-apply blocked BLK-001) |
| VAULT | CORE-0001 ✅, OTP-0002 ✅ | **VAULT layer complete** |
| CONN  | BASE-0001 ✅, API-0002 ✅, OAUTH-0003 ✅, BROWSER-0004 ✅, MANUAL-0005 ✅ | **CONN layer complete** |
| KYB   | FLOW-0001 ✅ | **DONE** |
| AGNT  | CONDUCT-0001 ✅, WORKER-0002 ✅, VALID-0003 ✅, MONET-0004 ✅ | **AGNT layer complete** |
| RWD   | AGG-0001 ✅, ATTR-0002 ✅, DIRECT-0003 ✅, LOYAL-0004 ✅ | **RWD layer complete** |
| CMRC  | CART-0001 ✅ | **DONE** |
| OBS   | KPI-0001 ✅ | **DONE** |
| E2E   | mock DoD flows ✅ | **both flows pass (Sec. 0.9)** |
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
