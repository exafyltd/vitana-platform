# J - Community cards design customization (session_018VfGKtixLYyQb3ub6VkXiK)
- Created 2026-10-07, updated 2026-10-08 16:33; idle. Branch claude/brave-ramanujan-umq97p (vitana-v1; platform attached).

## Goal
Title says community cards design customization; the transcript tail I read shows the work ended as VTID-04991: hold the unpublished What's New entries (owner decision 2026-10-08). The earlier card-design work is unknown to me (not read).

## Done
- exafyltd/vitana-v1#1291 (VTID-04991) merged 2026-10-08 16:23 UTC as 758173b: moved 4 entries (mentions-everywhere, calendar-day-overview, calendar-share-to-feed, messenger-group-manage) from src/whats-new/entries/ to held/; README "Holding an entry"; validation docs. Sparred 2 rounds. No migrations.
- Staging: STAGING-VERIFY passed 6/6 (run 37809046846, platform repo) on 758173b.

## State now
- Merged to main/staging; production was on 9d4904e (as of 2026-10-08 16:33), 758173b is the only commit in between. Whether prod was deployed afterwards: unknown. The 2026-10-09 16:00 UTC gateway run would have published mentions-everywhere if no build without those entries was live.
- No open PR known.

## Blocked on / needs owner
- Gate 2 "yes" to deploy 758173b to prod (deadline was 2026-10-09 16:00 UTC, already passed - check what happened).
- Decision: deactivate the one published Live Room card (`feature_announcements` row for live-room-interested-list)? Session recommended yes; it cannot recall the push already sent.

## Next steps for Kiro
1. Read-only check of prod build-info: is 758173b (or a later commit containing the hold) live? Check whether mentions-everywhere was published on 2026-10-09 16:00.
2. If not live, prepare Gate 2 evidence only; the prod dispatch (pinned commit_sha) is Claude Code / owner only.
3. Do not touch the feature_announcements row without owner say-so (production write).

## Gotchas/lessons
- live-room-interested-list was published at 16:00 UTC while the plan waited for approval, so the plan changed from five held entries to four.
- Rule: What's New cards are for new, finished features only; holding cannot recall a sent card; update `added` when releasing (entries older than 14 days never publish).
