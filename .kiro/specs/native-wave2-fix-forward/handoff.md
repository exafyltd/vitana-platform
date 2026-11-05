---
slug: native-wave2-fix-forward
author: kiro
executor: kiro
next_actor: kiro
state: drafted
author_seat: exafyltd
updated: 2026-11-03T16:20Z
spar_refs:
  - exafyltd/vitana-v1: main
---
# Handoff — Native Wave 2 fix-forward
Follow-ups recorded while building native Wave 2 lanes (vitana-v1 `apps/mobile/`) that no lane could close inside its
own `paths`: a shared utility bar with one voucher modal and global Life Compass / gift-voucher hosts, backfilled into
Home and Daily Diary; the ORB guided-topic hooks and the journey bridge; the storefront at `/` and cold-start invite
links; per-folder test timeouts; the Connectors AI-key sheet; a native analytics client; a dedicated
`/discover/ai-picks` screen. Plan block: `plan.md`. Lanes (`ready`, executor kiro, seat exafyltd → reviewer_seat
agent:vitana-lane-reviewer, no `vtid` yet): `utility-bar`, `orb-guided-topic`, `public-entry`, `test-timeouts`,
`analytics`, `screen-backfill` (depends on `orb-guided-topic`). `utility-bar`, `public-entry` and `screen-backfill`
wait for open vitana-v1 PRs (#1573, #1575, #1565/#1566, #1553, #1584) as each lane file states.
## Log
### 2026-11-03T16:20Z · kiro-exafyltd-202611011658-9f52 · created → drafted
Holder of the `native-wave2-fix-forward/_plan` claim. Plan, requirements, design, tasks and six lanes written; every
follow-up re-measured on vitana-v1 origin/main `aac65bfeb` with file:line in `plan.md` (none already fixed, none
dropped). Registered in `docs/programs/native-app/program.md`. No VTID allocated, no product code changed, no live
system touched. Next: PLAN-SPAR spars the `plan(native-wave2-fix-forward)` PR; this session answers each round in
`sparring/responses-<n>.md`.
