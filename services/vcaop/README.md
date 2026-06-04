# VCAOP — Vitanaland Commerce & Account-Operations Platform

Dev/staging-only control plane + connectors + commerce/rewards. Built per
`vcaop/VCAOP-BUILD-RUNBOOK.md` (Rev. 2). **Mock-first. Never production.**

## Status

This package is being built layer by layer (runbook Sec. 6). See
`vcaop/CURRENT-STATE.md` at the repo root for live progress.

- ✅ `CTRL-GUARD-0001` — **Guardrails** (this is the first gate; see below)
- ⏳ `CTRL-SCHEMA-0002` … and the rest of Sec. 6 (TODO)

## Guardrails (`src/guardrails/`) — the control layer (runbook Sec. 3)

Every feature must route through these. The suite is a **required CI gate**
(`.github/workflows/VCAOP-GUARDRAILS-CI.yml`) — it runs before any feature/deploy
and is never weakened to make a feature pass (Sec. 0.3, Sec. 11.3).

| Guardrail | Enforces |
|-----------|----------|
| `policy-engine` | Per-provider policy; **default-deny** unknown providers/actions (Sec. 4.3) |
| `env-boundary` | Dev/staging only; refuses prod targets, destructive SQL, IAM/billing; guards deploy/migration (Sec. 0.2) |
| `no-credential-store` | No secret material persisted to Postgres; only `*_ref`/`*_hash` (Sec. 0.3 #7) |
| `no-pii-leak` | Redaction + assertion: no PII in logs/prompts/traces/artifacts/OASIS/fixtures (Sec. 9) |
| `human-gate` | KYB/LIVENESS/CAPTCHA/PAYOUT/ESCALATION/IRREVERSIBLE/TRANSFER → human task, not bypassable |
| `no-captcha-solve` | No CAPTCHA-solver deps; `onCaptcha()` always throws (Sec. 0.3 #3) |
| `single-identity` | ≤1 active provider_account per (tenant, provider) unless policy allows (Sec. 0.3 #5/6) |
| `no-account-market` | No account/points transfer/sale/pool semantics anywhere (Sec. 10) |
| `loyalty-guard` | Loyalty links read-only, credential-free; no pool/transfer/resale (Sec. 0.3 #4/5) |
| `cost-guard` | Cloud Run caps, step/job timeouts, per-provider call caps, spend ceiling (Sec. 0.5) |

## Commands

```bash
npm install            # dev toolchain (jest/ts-jest/typescript)
npm run typecheck      # tsc --noEmit
npm run test:guardrails  # the required gate
npm test               # full suite
```
