## VTID Reference

**VTID:** `VTID-05063`

**Layer:** APIL

**Priority:** P1

VALIDATION_PROFILE: gateway_backend

## Summary

The VTID ledger read routes answered anonymous callers with full ledger rows (titles, descriptions, session URLs, plan hashes). Owner directive 2026-10-09: every access must be authenticated.

This PR is **step A**: a read gate `middleware/ledger-read-auth.ts` that reuses the VTID-04727 credential rule (`GATEWAY_SERVICE_TOKEN` bearer or an `exafy_admin` JWT; anonymous or bad token gives 401, a valid non-admin JWT gives 403). It is wired per route (never `router.use`) on the 13 Tier 1 ledger read route groups and ships in **log mode** (`LEDGER_READ_AUTH_MODE`, default `log`): nothing is rejected, every would-be rejection is logged. Health and build-info stay open.

All known callers are fixed first so enforce can follow without breakage: Command Hub (`app.js`, 401 interceptor guard), ORB task-state, voice developer tools, gemini-operator approvals, `vtid-auto-close.cjs`. vitana-v1 task view is a paired PR.

## Changes

- New `services/gateway/src/middleware/ledger-read-auth.ts` plus per-route gating on oasis-tasks, oasis-vtid-ledger, vtid, tasks, board-adapter, approvals; boot line in `index.ts`.
- Caller fixes (explicit opt-in token, `gatewayApiCall` unchanged).
- `AWS-STAGE-DEPLOY-GATEWAY.yml`: strip-list entry for `LEDGER_READ_AUTH_MODE` plus a whitespace-only jq re-indent to stay under the 20,000-char step cap (CI asserts it).
- Review-driven scope additions (sparred, one extra round): `scripts/ci/command-hub-ownership-guard.js` allow pattern, `index.html` app.js/styles.css cache-bust bump, impact-rule allow-list entry, and a docs-only repin of 14 older `staging-tests.json` HTML probes to the new cache-bust string. `debug.html` edit is inert (`/debug.html` is denylisted) and kept for source consistency.

## Not in this PR

- **Step B** (pin `enforce` on staging, `smoke/gateway.json`, flag pins) merges only after this and VTID-04727 are in production (owner PUBLISH), because STAGING-VERIFY runs the suites of every VTID between production and the verified commit.
- Tier 2 reads (OASIS events, `/specs/:vtid`, `/ops/health/vtid-ledger`) and write-side gaps: committed phase 2, own VTID.
- Production enforce: separate dispatch with an explicit owner go.

## Testing

- `npm run typecheck` in `services/gateway`: clean.
- Jest, run locally: 4 new `vtid-05063-*` suites, `vtid-04727-ledger-write-auth`, `staging-deploy-workflow-bash-syntax` (incl. the 20,000-char cap): all pass (163 tests). `node --test scripts/ci/vtid-auto-close.test.cjs`: 9/9. `vtid-04677-scheduled-notifications-auth` has 4 cases that shell out to bash with Windows paths and fail on a Windows dev machine only (unrelated to this change; Linux CI runs them).
- Full `npx jest` runs in CI.

## Plan and sparring

Plan sparred 3 rounds (escalated at the cap, owner-approved), plus one scope-addition round. Record: `docs/validation/VTID-05063/plan-sparring.md` (plan hash cc873442955182f743873f958ca461e745bc5720193fcacb7343b9e9d1019686, owner approval line included).

## Residual exposure

Until Tier 2 ships, anonymous callers can still read VTIDs and task titles/statuses through the OASIS event reads, `GET /api/v1/specs/:vtid` and (VTIDs only) `GET /api/v1/ops/health/vtid-ledger`. The gateway service token is the Supabase service-role secret, so any holder of it carries that exposure.

## Breaking Changes

None in log mode.
