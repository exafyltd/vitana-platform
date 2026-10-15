# Vitana onboarding assistant plan (session_01ABAU43knKr272BoCMFmp4Q)
- Created 2026-09-29, updated 2026-10-14 07:02 UTC; idle, status need_input ("Shall I go ahead?"). Branch ccr-1fe62e7a-kbdptt (both repos).

## Goal
Plan and roll out an onboarding assistant/coach for new members (slice 1: onboarding coach in shadow mode; slice 2 planned: "Your start" card in the app). Original request text not read.

## Done (from final reports; PR numbers/VTIDs: unknown)
- Onboarding coach live on production in shadow mode (stays in shadow after later deploys; prod was on e1ad8a0f on 10-13).
- AWS EventBridge job gateway-onboarding-coach-tick created by owner in CloudShell (daily 06:17 UTC, -> /api/v1/scheduled-notifications/onboarding-coach-tick, prod gateway).
- Welcome-chat / login path now skips test and service accounts (since a Friday prod deploy).
- Prod data cleanups with owner approval: shared E2E test account removed from group "Alle Beisammen" (now 242 members); group "FIRST 100" deleted (100 members, 61 messages; full backup was attached in chat only, session folder is ephemeral).
- First coach run (10-14 06:17 UTC): 27 decisions, no test accounts, nothing sent, one daily summary event.

## State now
- No known open PR. Coach running daily in shadow mode; send log empty.
- Bug found: all 27 members marked "listen to your first episode" including one who has completed 7 episodes. Cause: "has listened" derived only from a per-day "listened today" record (exists for 1 of 170 members); completed-episode count ignored.
- 23 of 25 new members with a journey record skipped the guided journey.

## Blocked on / needs owner
- Owner yes to proceed with the fix (small ~3-line change counting completed episodes as "has listened" + test) after a short sparring round.

## Next steps for Kiro
1. Spar and plan the has-listened fix (plan( PR), then implement with test; coach is under the coach code in gateway.
2. Keep collecting ~2 weeks of shadow data; compare to baseline (day-1 return 5.1%, days 2-7 17.6%, voice assistant use 17.9%, welcome-DM reply 2.6%).
3. Plan slice 2 "Your start" card (sparring + owner approval, frontend in vitana-v1; needs i18n DE/EN, Spotlight archetype).
4. Production changes / merges are Claude Code/PM only.

## Gotchas/lessons
- Session AWS identity cannot create schedules; owner ran the script in CloudShell (needs DEFAULT_TENANT_ID; CloudShell disk is 1 GB, use sparse checkout).
- Prod deletes done only with explicit owner approval and backups; verify triggers/notifications first.
