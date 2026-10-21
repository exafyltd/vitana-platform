# VTID-04650 — Community Autopilot: scan templates nobody accepts retire

Plan `docs/COMMUNITY-AUTOPILOT-V2-PLAN.md` §3: "Accept/reject/complete rates feed
ranking; templates nobody accepts retire." Until now only the per-member rule existed
(a template one member rejected twice in 30 days is suppressed for that member). The
population view was missing, so a suggestion the whole community ignores kept
being proposed to everyone.

## What changed
- `services/community-autopilot/template-stats.ts` (new): across all members, over the last
  60 days, each scan template's decided offers (`rejected`, `snoozed`, `activated`,
  `completed`) and its acceptances (`activated`, `completed`). Open rows and system
  retirements (`auto_archived`, the lineup cap and expiry) count for neither side.
  A template with at least 25 decided offers and an acceptance rate below 3% is retired.
- `ranker.ts`: an optional `retiredTemplates` set; a retired template is dropped with
  reason `template_retired`. Without it the ranker is byte-for-byte unchanged.
- `scan-runner.ts`: one stats read per scan run; the summary carries `retired_templates`.
- Fail-open: a failed read retires nothing (the per-member rules still apply).
  `COMMUNITY_AUTOPILOT_TEMPLATE_RETIREMENT=false` switches retirement off.
- `npm run test:community-autopilot` added: the 14 Community Autopilot suites.

VTID: VTID-04650
VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: Stats count decided offers and acceptances only; open and system-archived rows and non-scan rows are ignored.
TEST: services/gateway/test/vtid-04650-community-autopilot-template-retirement.test.ts

AC-2: A template with at least 25 decided offers and under 3% acceptance is retired; below 25 offers, or with real uptake, it is kept.
TEST: services/gateway/test/vtid-04650-community-autopilot-template-retirement.test.ts

AC-3: The ranker never picks a retired template and records `template_retired`; with no retired set its output is identical to before.
TEST: services/gateway/test/vtid-04650-community-autopilot-template-retirement.test.ts

AC-4: A read failure retires nothing; the kill switch skips the read entirely.
TEST: services/gateway/test/vtid-04650-community-autopilot-template-retirement.test.ts

AC-5: The existing scan behaviour is unchanged (off unless enabled, test/service accounts never scanned).
TEST: services/gateway/test/vtid-04505-community-autopilot-scan.test.ts

OASIS_PROOF: none. Retirement is part of the existing scan run and is reported in its summary (`retired_templates`). No new state transition topic.

## Evidence
- `outputs/jest-04650.txt` — 10/10.
- `outputs/mutation.txt` — disabling the ranker drop fails the suite.
- `outputs/staging-http.txt` — read-only probe of the deployed scan tick.

## Not done here
- Retirement only affects new picks. It has no effect until the scan is switched on
  (`COMMUNITY_AUTOPILOT_SCAN_ENABLED=true`, an owner step).
- Titles on scan cards stay catalog text (`tt()`), not model-written: they are displayed
  UI text (rule 42 keeps displayed strings in the reviewed catalog), and voice composes its
  own wording from the suggestion as data. Recorded as a deliberate reading of plan §3.
