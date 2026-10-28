# News feed navigation bugs (session_01QtZhhrnHJKw6D7e8VzwV7Z)
- Created 2026-10-06 20:06, updated 2026-10-08 08:43 (idle); branch ccr-7129936a-yt30s7 (vitana-v1)

## Goal
Fix two News feed bugs: tapping a post body opened the author's profile instead of the post; Back from a post landed at the top of the feed instead of the previous scroll spot.

## Done
- Plan sparred (2 rounds, owner-approved); record docs/validation/VTID-04937/plan-sparring.md. Code fix, 31 unit tests, full npm test (265 files / 1695 tests) passed.
- exafyltd/vitana-v1#1252 "VTID-04937: feed post tap opens the post; Back returns to the same feed spot": opened, 9 files, 3 commits. NOT merged.

## State now
- #1252 is OPEN and still DRAFT (verified on GitHub, last updated 2026-10-14), head 10d2a8b (main merged in by someone on 2026-10-08), base main b74f2cf. As of 2026-10-08 all 6 CI checks were green (including pr-gate, preview-e2e); I did not re-check CI today.
- Staging spec in PR: tests/e2e/staging/vtid-04937-feed-post-open.staging.spec.ts (read-only). Not yet run on staging (needs merge).
- Not deployed anywhere.

## Blocked on / needs owner
- Ledger problem: first VTID-04927, then re-allocated VTID-04937, were both set to status=deleted by the allocated-orphan reaper because the title was never set (session's Supabase execute_sql writes on real rows hung ~60 s).
- Owner said "Fix the connector's writes first". Session's diagnosis: Supabase connector holds writes to real rows for approval that never reaches a cloud session. Owner action requested: claude.ai/customize/connectors -> Supabase -> set execute_sql to Allowed. Owner confirmation that this was done: unknown (none seen).
- Session stopped allocating VTIDs. A fresh VTID (title set immediately) is still needed, then rename in files/PR title.

## Next steps for Kiro
1. Re-read #1252 and confirm CI is still green on current head (merge main again if stale).
2. Get a valid ledger row for the work: allocate a new VTID with title/status set at once, or restore VTID-04937 (title, status=in_progress, spec_status=approved, is_terminal=false, PR link). SQL writes to vtid_ledger from a cloud session may hang; use the gateway path or have the owner/Claude Code do it. Sparring metadata: plan hash 9d645d6f0504dc7530bafdfecb1b27a6ae6aa2f798f0fc4e530386c7d97fc7e5.
3. If the VTID changes, rename docs/validation/<VTID>/ files, staging spec name and the PR title (change-suite reads the VTID from the PR title).
4. Mark PR ready, merge (Claude-Code/PM-only), watch staging deploy and STAGING-VERIFY, then Gate 2 (Claude-Code/PM-only).

## Gotchas/lessons
- A placeholder-titled VTID gets reaped about 10-15 min after allocation unless its title is set.
- change-suite runs on both push and title edit; a run started before a PR rename fails against the old VTID, the later run passes.
- Never test writes against production; spec must stay read-only.
