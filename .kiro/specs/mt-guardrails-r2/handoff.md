---
slug: mt-guardrails-r2
author: kiro
author_seat: hotmail
executor: kiro
next_actor: kiro
state: approved
updated: 2026-11-01T17:06Z
sparring_record: .kiro/specs/mt-guardrails-r2/sparring/verdict.md
vtids: [VTID-05443, VTID-05444, VTID-05445, VTID-05446, VTID-05447, VTID-05448]
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

### 2026-11-01T16:03Z · kiro-hotmail-202611011452-6d16 · drafted (driver takeover, plan PR reopened)
Driver taken over from `kiro-hotmail-202611011402-f523` (heartbeat older than 45 min, `collaboration.md` §8). PR #4573
had been opened from the previous driver's branch. Collab handoff allows one session per lane (`queue.mjs:879`), so
this session could not answer sparring rounds there. The plan moves unchanged to branch
`kiro/mt-guardrails-r2/_plan`, with this session's commits only.

### 2026-11-01T16:32Z · kiro-hotmail-202611011452-6d16 · drafted (session 1 escalated on the evidence floor)
PLAN-SPAR session `00a5b19f` escalated in round 1 with `evidence_floor_not_met` and no findings. The partner read no
file. The plan now names the premise files, and this push starts session 2.

### 2026-11-01T16:45Z · kiro-hotmail-202611011452-6d16 · drafted (session 2 round 1 answered)
Session `c30d4bc1` round 1 is answered in `sparring/s2-responses-1.md`:
- R1-F1: row 21b keeps `secrets.SUPABASE_URL` and gets a comment instead.
- R1-F2: a runner re-pin trigger is recorded.
- R1-F3: the spike checks for pgtap and documents a fallback.

### 2026-11-01T17:06Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 6 lane(s) got a VTID and are handed to Kiro.
