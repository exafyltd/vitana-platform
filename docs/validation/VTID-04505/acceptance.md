# VTID-04505 — Community Autopilot CA-5: twice-daily scanners + ranker, old inbox folded in

Step CA-5 of `docs/COMMUNITY-AUTOPILOT-V2-PLAN.md`.

## What changed

- `services/community-autopilot/scanners.ts` — pure area scanners over one
  member's snapshot, each proposing at most one candidate with a typed action:
  Vitana Index weakest pillar (own-data log), diary gap (opens the diary — never
  drafted), unanswered message (reply draft), fresh match (hello draft), event
  with free places (RSVP), share progress (post draft, app only), first Media
  Hub video, Discover, invite a friend, and the folded health inbox item.
- `ranker.ts` — pure: at most 3 open per member (owner decision 3), one per
  category, novelty bonus for a never-used feature, a template rejected twice in
  30 days suppressed, a fingerprint open or acted on in 14 days not re-proposed,
  a 14 h expiry per row.
- `scan-runner.ts` — reads the snapshot (every read fails soft), ranks, inserts
  rows (`source_ref scan_<template>`, title/summary via the gateway catalog in
  the member's language, `action`, `provenance`). Members are due at local
  07:00 / 17:00 (reminder tz → timezone fact → Europe/Berlin).
  Test/service accounts are never scanned and never a target (rules 43-45).
- `POST /api/v1/autopilot/recommendations/community-scan` — EventBridge
  dispatcher (`X-Gateway-Internal`) or exafy admin; emits
  `community_autopilot.scan.completed`. **Writes nothing unless
  `COMMUNITY_AUTOPILOT_SCAN_ENABLED=true`** (not set anywhere in this PR) and
  never notifies anyone — rows only appear in the member's own Autopilot.
- `scripts/aws/setup-eventbridge-cron-migration.sh` — hourly
  `gateway-community-autopilot-scan` job on the staging gateway. `--apply` is
  the owner's step (decision 2).
- The old `/api/v1/recommendations` inbox is folded in (decision 4): its items
  become Autopilot suggestions; its routes answer with
  `X-Vitana-Superseded-By`.
- Catalog: `autopilot.scan.*` and `autopilot.pillar.*` in 10 gateway locales; `ar` stays untranslated until the audit pipeline and falls back via `tt()` (catalog-coverage rule).
- The list keeps rows that carry a typed action even when their `source_ref` is
  not a legacy template (CA-4 change, relied on here).

## Acceptance criteria

AC-1: Scanners propose registry actions only; the weakest pillar gets a matching own-data action; the diary is opened, never drafted; a reply draft is proposed only after 12 hours.
TEST: services/gateway/test/vtid-04505-community-autopilot-scan.test.ts

AC-2: The ranker caps at 3 open per member, one per category, counts open rows, suppresses a template rejected twice in 30 days, does not re-propose a target within 14 days, and gives a never-used feature a bonus.
TEST: services/gateway/test/vtid-04505-community-autopilot-scan.test.ts

AC-3: Members are due only at local 07 and 17; rows are written in the member's language with a typed action and an expiry.
TEST: services/gateway/test/vtid-04505-community-autopilot-scan.test.ts

AC-4: Nothing is written unless COMMUNITY_AUTOPILOT_SCAN_ENABLED is exactly true; test/service accounts are neither scanned nor targeted.
TEST: services/gateway/test/vtid-04505-community-autopilot-scan.test.ts

AC-5: Only the internal token or an exafy admin can run the scan endpoint; it emits community_autopilot.scan.completed.
TEST: services/gateway/test/routes/autopilot-recommendations.test.ts

AC-6: The EventBridge job list carries the hourly community scan job.
TEST: services/gateway/test/vtid-04226-eventbridge-test-contract-schedules.test.ts

OASIS_PROOF: `community_autopilot.scan.completed` (vtid SYSTEM, source community-autopilot) with members_considered/due/scanned, rows_inserted, enabled, dry_run — asserted in services/gateway/test/routes/autopilot-recommendations.test.ts (CA-5 block).

## Evidence

- `outputs/jest-ca5.txt` — 10 suites / 202 tests.
- `outputs/mutation-reject-suppression-removed.txt` — disabling the 2-rejects rule fails its test.

## Not done here, owner steps

- `COMMUNITY_AUTOPILOT_SCAN_ENABLED=true` on the staging task def, and
  `setup-eventbridge-cron-migration.sh --apply` (this session has no
  `scheduler:*` rights). Until both, the endpoint dry-runs.
- The one daily digest push (decision 2) is not built into the scan; it follows
  after a week of shadow mode.

## Route mount

ROUTE_MOUNT: `router.post('/community-scan')` in services/gateway/src/routes/autopilot-recommendations.ts, a router mounted at `/api/v1/autopilot/recommendations` (services/gateway/src/index.ts:829, `mountRouterSync`).
FINAL_URL: POST https://preview-aws-gateway.vitanaland.com/api/v1/autopilot/recommendations/community-scan
CURL_PROOF: `curl -X POST https://preview-aws-gateway.vitanaland.com/api/v1/autopilot/recommendations/community-scan` (no credentials, writes nothing) → `401 application/json` `{"ok":false,"error":"missing bearer token"}`, taken before merge. This shows the router is mounted and answers JSON. The handler itself runs only after this merges and deploys; its auth and behaviour are covered by the route tests above.
