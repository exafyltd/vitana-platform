# D - Calendar integrations (session_01Exp4yLAd4ECSuen7Son47q)
- Created 2026-10-06, updated 2026-10-13 10:51 UTC; status completed. Branch ccr-9502f7e4-laaa23 (both repos).
## Goal
Calendar integrations / sharing; latest work VTID-05126 "share any of my upcoming calendar entries" (reminders, private, health entries) to the feed/chat. Early history (Google/Apple/Outlook integrations) not read.
## Done
- exafyltd/vitana-platform#4066 VTID-05126 gateway and exafyltd/vitana-v1#1350 VTID-05126 app + migration - closed; session reports both live in production: migration applied by run 38358687574, app commit 703014b by run 38358748405, gateway on c8d828a since 09:18 UTC (shipped by another person's PUBLISH). Ledger row VTID-05126 closed completed/success.
## State now
- No open PRs seen. Nothing uncommitted known. Prod fully on VTID-05126.
## Blocked on / needs owner
- An admin must enable notification type community_event_shared (otherwise no push when shared).
## Next steps for Kiro
1. Check whether VTID-05103 DB functions claim_routine_run/finish_routine_run exist in prod (read-only); belongs to the VTID-05103 session (was missing at 00:30 UTC, code in prod).
2. LiveKit voice agent update for sharing own entries is merged but needs its own manual deploy (Claude-Code-only / prod).
3. No further calendar-integration work identified.
## Gotchas/lessons
- Gateway deploy failed its safety check when staging moved (another merge a837b41 / VTID-05122); promote-staging only ships what staging currently serves. Don't ship unapproved commits; here someone else's PUBLISH resolved it.
- Small prod regression existed while app was new and gateway old (Einladen button hidden); sequence gateway before app.
