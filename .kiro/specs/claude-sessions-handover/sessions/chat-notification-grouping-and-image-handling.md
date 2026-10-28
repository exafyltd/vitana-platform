# J - Chat notification grouping and image handling (session_01DahW5ffkV9hT2KVnJS1iAb)
- Created 2026-10-13T08:54, updated 2026-10-14T15:20, IDLE. Branch claude/affectionate-einstein-fdlxvz
## Goal
Fix chat issues in vitana-v1: picture viewer/Forward sheet, shared-link expiry, and server-side push notification grouping. (Original request not read.)
## Done
- exafyltd/vitana-v1#1409 (Share links last 7 days; Forward sheet above picture; "Share via other apps"; 11-language strings) merged as c7a90a9c; staging check passed (run 38553068553); owner said "yes"; published to production 2026-10-14 15:17 UTC, post-deploy checks passed (run 38586907851). Earlier Forward fix 04993141 was already in production. No migrations.
## State now
- No open PR known for the frontend. Server-side push-notification grouping (platform) is NOT in production; it would also carry another team's change (VTID-05140). Its PR numbers: unknown.
## Blocked on / needs owner
- Server-side notification grouping needs its own staging check and the owner's "yes" for production (bundle with VTID-05140 must be accepted).
## Next steps for Kiro
1. Nothing queued for Kiro from this session that I saw.
2. Claude-Code-only: staging verification and Gate 2 for the grouping change; production publish.
## Gotchas
- 7 days was chosen because owner said "longer" without a number (one constant). Trade-off: link opens one picture for 7 days; storage stays private.
- Staging test used a real group the test account left; now a made-up group. A later "ignore this" message in the session was an injected Kiro report about #1411 and was ignored by the session.
