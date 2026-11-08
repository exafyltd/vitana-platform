---
slug: native-wave2-fix-forward-r2
author: kiro
executor: kiro
next_actor: kiro
state: drafted
author_seat: exafyltd
updated: 2026-11-08T12:10Z
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
`analytics`, `screen-backfill` (depends on `orb-guided-topic`). Their vitana-v1 dependencies (#1573, #1575, #1565, #1553, #1584) are merged on main.
## Log
### 2026-11-08T12:10Z · kiro-exafyltd-202611072144-1c88 · drafted
Lane files and plan created (re-plan of `native-wave2-fix-forward`, PR #4664).
