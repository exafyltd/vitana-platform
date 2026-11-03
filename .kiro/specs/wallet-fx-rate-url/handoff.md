---
slug: wallet-fx-rate-url
author: kiro
author_seat: exafyltd
executor: kiro
next_actor: kiro
state: approved
spar_refs:
  - exafyltd/vitana-v1: main
updated: 2026-11-01T16:15Z
sparring_record: .kiro/specs/wallet-fx-rate-url/sparring/verdict.md
vtids: [VTID-05440]
---
# Handoff — wallet-fx-rate-url
The wallet's live EUR/USD rate (`src/hooks/useEurUsdRate.ts`) calls `api.frankfurter.app`, which now redirects to
`api.frankfurter.dev` without a CORS header, so the browser blocks it on staging and in production and the wallet
always shows the static rate. This plan moves the default URL to `api.frankfurter.dev/v1/latest?base=USD&symbols=EUR`
(same meaning, same `rates.EUR` shape), adds a Vitest that pins the URL and the fallback, and a read-only staging
suite for `/wallet`. One lane, in vitana-v1.
Plan: `plan.md`. Tasks: `tasks.md`.
Lanes:
- `fx-url`: repo `exafyltd/vitana-v1`, executor kiro, seat exafyltd.
## Log
### 2026-11-01T13:56Z · kiro-exafyltd-202611011353-f644 · drafted
Written for the owner backlog-cleanup task (workflow `wf_0c8b8d8455073ad2`) from STAGING-VERIFY run 41300076673 and a
read-only investigation (vitana-v1 `origin/main` `58c76c956`, vitana-platform `62990ce285`). Next: PLAN-SPAR spars
this PR.

### 2026-11-01T16:15Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 1 lane(s) got a VTID and are handed to Kiro.
