# Activity Timeline rebuild and memory catalog (session_01BRavW51BdMPjaEFJrJV11G)
- Created 2026-10-13 17:29, updated 2026-10-14 08:32 UTC; idle, completed. Branch claude/activity-timeline-rebuild-vrtcv4 (both repos). Collab lane: life-timeline/p1..p6.

## Goal
Rebuild the Life/Activity Timeline (six phases, VTID-05168 family) incl. activity catalog and Vitana Index movements (only inferred from title and final report; original request not read).

## Done
- All six phases released to production 2026-10-14 (owner said "publish it now" per PR #4118 body).
- Gateway: 0b875e98 promoted from staging (phases 1,2,3,5), smoke OK. Frontend: built from 49182e04 (phases 4,6), pinned, post-deploy checks OK.
- Migrations applied on prod: P1 activity catalog (7 columns on user_activity_log), P5 learning settings table + 4 routine kinds, P2 Vitana Index movements (20261014140000_vtid_05168_index_movements.sql).
- P2 first run failed (42P13: removed DEFAULT on health_compute_vitana_index(date)); rolled back cleanly. Fixed by exafyltd/vitana-platform#4118 (merged 7093cf51), re-run succeeded, verified.
- Individual phase PR numbers: unknown (not seen).

## State now
- No open PRs known. Nothing running. Migrations table vitana_index_movements starts empty and fills via activity logging / nightly Index recompute.
- Also shipped with the release: other teams' staging commits, including 5 Spotlight screen suites that were already failing; a full gateway staging run showed 1 of 1190 failing (VTID-04880 language-coverage check, not this release).

## Blocked on / needs owner
- Nothing blocking; two open items below.

## Next steps for Kiro
1. Update collaboration lane files p1-p6, one per PR (Git is the channel).
2. Per-entry "Open" links on timeline entries: needs gateway to emit a link per entry first, then a frontend change (plan -> spar).
3. Look at VTID-04880 language-coverage failure and Spotlight suite failures only if assigned (owned by other lanes).

## Gotchas/lessons
- CI SQL test stand-in omitted the live function's DEFAULT, so CI could not see the 42P13; fixtures must match production signatures (pg_get_functiondef md5 capture).
- Pin prod deploys to the session's own commit; main had moved past 49182e04.
- Migrations run via RUN-MIGRATION.yml workflow; production DB checks read-only.
