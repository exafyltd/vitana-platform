# VCAOP — Automated Health-Check Plan (hourly + daily)

> Goal: continuously confirm the Vitanaland Commerce system is healthy **without a
> human watching**, and feed the self-healing loop (`SELF-HEALING-PLAN.md`) the
> signals it needs. Two cadences: a fast **hourly** invariant probe and a deeper
> **daily** verification. Everything emits structured results so remediation is
> automatic.

---

## 1. Cadence & scope

| Cadence | Command / probe | Scope | Budget |
|---------|-----------------|-------|--------|
| **Every 60 min** | `npm run health` | 58 highest-signal invariants: all guardrails, both e2e flows, TOTP RFC vectors, KPI math | < 30s, no external calls |
| **Daily** | `npm test` + `npm run typecheck` + `npm run build` + migration up/down on ephemeral PG | Full 159-test suite + schema reversibility | < 5 min |
| **Daily (when dev env exists, BLK-001)** | live probes | `curl /alive` (JSON 200), DB connectivity, Cloud Run latest-revision-serving, KPI thresholds from OASIS | seconds |

The hourly probe is **CI-runnable today** (no dev env needed). The live probes
activate automatically once `vars.VCAOP_DEV_DEPLOY_ENABLED=true` and the dev
connection details exist.

## 2. What "healthy" means — the invariant set
The hourly probe asserts the things that must NEVER regress:
1. **Safety guardrails hold** — env-boundary fail-closed; policy default-deny; no
   secret/PII leak; human-gate/CAPTCHA/loyalty/account-market guards intact; cost caps.
2. **Money path is correct** — pending→confirm(only with postback)→wallet credit→reversal claws back.
3. **Onboarding is gated** — human-required steps block; KYB needs staff+admin.
4. **TOTP is RFC-correct** — interop vectors pass.
5. **KPIs compute** — no divide-by-zero, ratios sane.

## 3. Live signals (dev, once available)
Collected into an OASIS-backed health snapshot every cycle:
- `/alive` HTTP 200 + `application/json` (HTML 404 ⇒ wrong/failed deploy — CLAUDE.md §15).
- DB reachable; latest migration applied; RLS enabled on all 16 tables.
- Cloud Run: latest revision serving 100% (no stuck rollout).
- KPI thresholds (rolling): `commissions.confirmedShare` not collapsing; `exceptions.queueDepth` not spiking; onboarding `approvalRate` sane; cost-control counters under Sec. 0.5 caps.
- OASIS error-rate: count of `status:'error'` events per window under threshold.

## 4. Thresholds (initial; tune via DECISIONS)
| Signal | Warn | Fail (→ heal) |
|--------|------|----------------|
| hourly invariant suite | — | any test fails |
| `/alive` | >1 missed | 2 consecutive misses |
| OASIS error events / hour | > 5 | > 20 |
| confirmedShare (24h) | < 0.85 | < 0.6 |
| exception queue age | > 4h | > 24h |
| est. dev spend | > $20/day | > $25/day (Sec. 0.5) |

## 5. Wiring (executable today)
`.github/workflows/VCAOP-HEALTH.yml`:
- `schedule: cron '0 * * * *'` → hourly `npm run health`.
- `schedule: cron '30 6 * * *'` → daily full suite + build + migration up/down.
- On **failure** → emit a health-failure signal: dispatch the self-healing workflow
  (or, if not configured, open a GitHub issue tagged `vcaop-health` with the
  failing job logs) so `SELF-HEALING-PLAN.md` can act.
- On **success** → no noise (silent), but writes a heartbeat to the run summary.

> Note: GitHub `schedule` only runs on the default branch. Until this PR merges,
> the hourly job is exercised on push/PR via `VCAOP-CICD.yml`; the cron schedule
> takes effect once merged to `main`.

## 6. Outputs the self-healer consumes
Each cycle produces: `{ ts, cadence, ok, failedChecks:[{name, category, detail}],
signals:{...} }`. `category` ∈ `{transient, service, schema, config, dependency,
guardrail}` — this maps 1:1 to the remediation ladder in `SELF-HEALING-PLAN.md`.
