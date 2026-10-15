# J - Mobile app entry issue (session_01XHYXES5CKde5aa97u6rMhD)
- Created 2026-10-06, updated 2026-10-09 00:45; idle. Branch ccr-90d52f43-krif33 (vitana-v1; platform attached).

## Goal
Members in the Appilix (Android WebView) app were stuck on "App updated - please reload"; Reload/Go Home re-served the same stale shell. Make recovery robust.

## Done
- exafyltd/vitana-v1#1297 (VTID-05000) merged 2026-10-08 23:53 UTC as b0fd646: `src/lib/stale-bundle-recovery.ts` (cache-busted `_vr=<ts>` reload, Cache Storage cleanup skipping firebase-*, max 1 auto recovery/10 s), `vite:preloadError` handler in main.tsx, GlobalErrorBoundary uses helper + 4 strings moved to i18n (DE+EN). Sparred 2 rounds, Gate 1 approved. CI green.
- Staging deployed 00:00 UTC; change-suite STAGING-VERIFY run 37862466518 passed 12/12 (new spec + 15 unit tests).

## State now
- Merged to main/staging only; NOT in production (prod was at 0aae822c8dd1). No open PR known; VTID-05000 still open in ledger.
- Full STAGING-VERIFY run 37863180382 on b0fd646 FAILED 201/216 (15 failures, none in VTID-05000 code).

## Blocked on / needs owner
- Owner choice: (1) send Gate 2 ready message disclosing the failing full run (session recommends), (2) hold until the unrelated suites are fixed, (3) re-run the full suite once. A "yes" would ship 3 commits (no migrations): 1fe86a0 VTID-04989, 5f09b27 VTID-04995 (#1299), b0fd646 VTID-05000.
- Unclear whether a passing full run is a hard gate; only other full run (10-08, 463e22a) also failed.

## Next steps for Kiro
1. If owner picks (2): plan the fix of the pre-existing failing staging specs: VTID-04676 (live_rooms category), 04723 (ORB cache-bust string), 04760-04763 audiobook, 04793/04795/04796 Commerce, 04965 live-room drawer; also check 04843 and 04978 flake. Needs sparred plan and own VTIDs.
2. After release, read `react_error_boundary` beacon logs (gateway stdout) to see whether the recovery works on devices.
3. Gate 2 message and prod dispatch (pinned commit_sha=b0fd646) are Claude Code / Project Manager only.

## Gotchas/lessons
- Root cause on device never observed; fix is defensive. Members with an already stale shell can't get it until the shell refreshes (clear Appilix cache/reinstall).
- Rule 50: failed STAGING-VERIFY means no ready message and no publish; do not loosen tests.
