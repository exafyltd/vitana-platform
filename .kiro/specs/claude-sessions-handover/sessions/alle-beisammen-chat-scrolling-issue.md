# J - Alle Beisammen chat scrolling issue (session_01NJ1qaxpMCUAkKRVreSCfZi)
- Created 2026-10-06 13:32, updated 2026-10-07 08:13 (idle); branch ccr-bf612154-r0nw0r (vitana-v1)

## Goal
Group chat "Alle Beisammen" opened at the oldest message (worse in the Android Appilix webview) and notification taps did not land on the message; open at the newest message and make notification links land on and highlight the message.

## Done
- VTID-04921 (group chat opens at newest message, commit 3e28249) and VTID-04928 (app-webview whole-page-scroll fix a6004a1 plus notification landing): live in production. Production deploy of main ea5f9a2 finished 08:05 UTC 2026-10-07 with post-deploy check passed; it was dispatched at 07:59 by someone else, and also shipped other sessions' work (@mentions, calendar, partner terms, translations). Notification links live since 07:14.
- Only app file changed: GroupChat.tsx. Both VTIDs marked complete in the ledger.
- Draft PR #1255 (test fix) closed because identical fix is on main as #1256 (VTID-04924, other session).
- PR numbers for the feature commits: unknown.

## State now
- Nothing open known. Unused branch release/vtid-04928-group-chat still exists (session offered to delete it). Not verified on a real device.

## Blocked on / needs owner
- Owner phone check after fully closing/reopening the app: opens on newest message; tapping a new group-message notification opens and highlights the message. Older notifications (before 07:14) still open at newest.
- Owner said earlier there were other issues and will send them.

## Next steps for Kiro
1. Wait for the owner's device confirmation or screenshots; if still landing on oldest message, investigate GroupChat.tsx in the Appilix webview.
2. Delete branch release/vtid-04928-group-chat only if the owner agrees.
3. Take the owner's further issues one at a time (plan sparring, VTID, staging check). Merge and prod publish are Claude-Code-only.

## Gotchas/lessons
- An old VTID-04921 staging spec fetched an image attachment URL and failed the read-only network guard; fixed by VTID-04924 on main.
- Shared staging is overwritten by whichever session deploys last; check before deploying a release branch.
- Release-only builds can be superseded when another session's production deploy of main ships everything.
