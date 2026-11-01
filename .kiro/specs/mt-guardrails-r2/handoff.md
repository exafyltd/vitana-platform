---
slug: mt-guardrails-r2
author: kiro
author_seat: hotmail
executor: kiro
next_actor: kiro
state: drafted
updated: 2026-11-01T15:30Z
---
# Handoff — mt-guardrails-r2
Re-plan of `mt-guardrails` (PR #4162, closed 2026-10-28; session `496d49e4` escalated at the round cap). WS0 guard
rails and test tooling for the multi-tenant program: local stack + fixtures, generated inventories and DB lints,
pgTAP isolation suite, gateway scope lint and contract tests, Maxina golden suite, CI wiring. Plan: `plan.md`.

## Log

### 2026-11-01T15:30Z · kiro-hotmail-202611011402-f523 · drafted
Owner instruction 2026-11-01: "you make the decisions for me". Re-planned instead of approved as escalated. Round-3
findings answered in `plan.md` "Re-plan answers": no GitHub Actions `services:` container (R3-F1), no production
schema dump — the schema is a local replay of the committed migrations (R3-F2), the vulnerable-pin caveat recorded
(R3-F3). `ci-wiring` moves to `executor: kiro` under §3a on `main`. Pushed as a `plan(` PR.

### 2026-11-01T15:45Z · kiro-hotmail-202611011402-f523 · drafted (plan PR held)
Plan PR not opened yet, on purpose: GitHub Actions is backlogged (about 1,168 runs queued, PLAN-SPAR runs queued for
over an hour, several runs stuck in progress since 13:11Z), and `collaboration.md` §8a caps PLAN-SPAR at 2 sessions in
flight repo-wide (3 already queued incl. #4567). Open `plan(mt-guardrails-r2): WS0 guard rails and test tooling
(re-plan)` from this branch when fewer than 2 PLAN-SPAR runs are queued or running.
Re-plan order for the other escalated multi-tenant plans (owner instruction 2026-11-01, same method: new `-r2` slug,
answer the last round's findings in `plan.md`, lanes on today's §3a rules, old PR stays closed): mt-identity,
mt-community-isolation, mt-data-cleanup, mt-packs (its WS5 migration unblocks MIGRATION-QUEUE rows 9–10),
mt-tenant-admin, mt-native-health, mt-frontend-brand-r2, mt-m3, sparring-token-efficiency.
