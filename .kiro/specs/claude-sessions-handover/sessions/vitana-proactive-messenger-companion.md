# D - Vitana proactive Messenger companion (session_016Y9ADzi2tLSdr8pKgai5sB)
- Created 2026-10-12T20:30, updated 2026-10-15T09:46, IDLE (status bucket: blocked). Branches claude/vitana-proactive-messenger-1255ww (+ -cards, -chatcard, -boost) in vitana-v1 and vitana-platform. Model opus.
## Goal
Build a proactive daily Vitana message in Messenger for members ("companion"), rolled out staff-first. (Inferred; original request not read.)
## Done
- Companion code is in production on gateway commit 0b875e98; /api/v1/companion/status reports mode: staff. Merged PR numbers: unknown (not read).
- 2026-10-14 ~15:50 on owner's "send staff message now to test": production settings-only redeploy (run 38592888824) opening the delivery window 00:00-23:59, staff mode kept, trial messages for others off; push stays off until admin enables vitana_companion_message.
## State now
- Window is still open all day (should be reset to 07:30-09:30 afterwards). Production has zero companion.* oasis events and zero companion_messages_ledger rows since 2026-10-14 15:50 UTC (read-only check 2026-10-15 09:46).
- Routine "Check first companion staff messages" (trig_019VbEzUmFzYJdBfvoC1wBqu) already fired once; further routines: unknown. Open PRs: unknown.
## Blocked on / needs owner
- Someone with AWS access (acct 472838866351, eu-central-1) must create the missing EventBridge schedule, from vitana-platform: `DEFAULT_TENANT_ID=<prod tenant uuid> ./scripts/aws/setup-eventbridge-cron-migration.sh --only gateway-companion-tick` (try --dry-run first). Then tell the session so it can verify read-only and restore the window.
## Next steps for Kiro
1. Kiro cannot run AWS; Claude Code/owner-only: create the schedule job, verify companion events/ledger, reset window to 07:30-09:30.
2. If job exists and still nothing: inspect gateway AWS logs for `[companion]` errors (needs AWS access).
3. Only after staff messages verified: separate plan for widening beyond staff and enabling push.
## Gotchas
- The deploy workflow does not create EventBridge schedules; only the setup script does (same pattern needed for the welcome-team tick).
- Session has no AWS CLI; do not write to prod DB to work around it.
