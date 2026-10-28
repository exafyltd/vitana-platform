# VCAOP — Test Instructions (for a human starting testing)

> Read this first. It tells you **what to test, how to test it, and what "good" looks
> like** for the Vitanaland Commerce & Account-Operations Platform. The build is
> dev/staging-only and mock-first; live provider/affiliate/KYB calls are out of scope
> until the runtime tasks in `FINAL-REPORT.md` (BLK-001/002/003) are done.

---

## 0. Prerequisites
- Node ≥ 18, `cd services/vcaop && npm install`.
- (Optional, for migration tests) Postgres 16 binaries available locally.
- No real credentials needed — everything runs against mocks/fixtures and an
  ephemeral local DB.

## 1. The 60-second confidence check
```bash
cd services/vcaop
npm run health      # 58 critical-invariant tests (guardrails + both e2e flows + TOTP + KPIs)
```
**Good:** `Tests: 58 passed`. **Bad:** any failure → see `SELF-HEALING-PLAN.md` §Triage.

## 2. The full suite
```bash
npm run typecheck   # tsc --noEmit, must be clean
npm test            # full suite — expect 159 passed / 28 suites
npm run build       # tsc, must be clean
```

## 3. What to test, by area (and how)

| # | Area | What you're verifying | How |
|---|------|----------------------|-----|
| 1 | **Guardrails (safety spine)** | env-boundary refuses prod/destructive/IAM; default-deny policy; no secrets/PII persisted or logged; human-gate not bypassable; no CAPTCHA solving; single-identity; no account/points market; loyalty read-only; cost caps | `npm run test:guardrails` (50 tests). Each guardrail has its own spec in `test/guardrails/`. |
| 2 | **Data model + RLS** | 16 tables migrate up **and** down cleanly; RLS lets community see only own rows; staff cannot approve a human task or edit policy; admin can | `prisma/migrations/*/README.md` has the exact `psql -f down.sql` commands. RLS is verified on ephemeral Postgres — see `IAM-ROLES-0001` README for the role-switch script. |
| 3 | **Vault / TOTP** | secrets never returned to API; TOTP matches RFC-6238 vectors; recovery codes single-use | `npx jest test/vault` |
| 4 | **Connectors** | every method gated before adapter logic; API round-trip; OAuth refresh + revocation→degraded+REAUTH; browser artifacts scrubbed + CAPTCHA→human + live-disabled; manual = PII-free human task | `npx jest test/connectors` |
| 5 | **Onboarding (KYB)** | advances only after **staff + admin**; artifacts reused on next provider | `npx jest test/onboarding` |
| 6 | **Agents** | conductor plans by policy; worker blocks on human-gated steps; validator rejects skipped gates + unverified commissions; monetization never picks cashback=false | `npx jest test/agents` |
| 7 | **Rewards** | postback → pending → confirm (only with postback) → wallet credit → reversal claws back | `npx jest test/rewards` |
| 8 | **Commerce** | multi-merchant cart routes via the ladder; **non-dismissible FTC disclosure** on every cart | `npx jest test/commerce` |
| 9 | **End-to-end (DoD)** | (a) onboard supplier→operate; (b) shop→SubID→wallet credit→confirm→reversal | `npx jest test/e2e` |
| 10 | **UI view-models** | wallet/cart scoped to owner; admin views never render secrets/PII | `npx jest test/ui` |

## 4. Manual / exploratory checks (when the dev env exists — BLK-001)
Once a dev Supabase + `*-dev` Cloud Run is wired and the router is mounted in the Gateway:
1. **Apply migrations** to the dev DB, then immediately verify the down path on a scratch copy.
2. **Authz matrix over HTTP** — call `/api/v1/vcaop/*` with `community`, `staff`, `admin`, `developer` tokens; confirm 401/403 per `IAM` matrix and that no `*_ref`/secret fields appear in any response body.
3. **Secrets never on the wire** — grep responses for `credential_ref`, `mfa_seed_ref`, `sm://` → must be absent.
4. **Disclosure** — open a cart in the UI; confirm the FTC disclosure cannot be dismissed.
5. **Human-task flow** — trigger a KYB onboarding; confirm it parks as a `human_task` and the account does not go `active` until staff **and** admin approve.
6. **/alive** — `curl <vcaop-api-dev>/alive` returns JSON 200 (per CLAUDE.md deploy verification).

## 5. Acceptance bar
- `npm run health` green, `npm test` 159/159, typecheck + build clean.
- Migrations reversible (down verified).
- No guardrail weakened, no secret/PII in any response/log, no production touched.
- Both DoD e2e flows pass.

## 6. If something fails
Do **not** weaken a guardrail or delete a test to go green. Capture the failing
output and follow `SELF-HEALING-PLAN.md` — the automated loop will usually have
already attempted remediation and, if it couldn't, opened an escalation with a diagnosis.
