# Maxina AI integrations architecture (session_014iLoqFBu5V5FKFHKgrhxeb)
- Created 2026-10-08, updated 2026-10-13 10:26 UTC; status completed (Gate 2 not yet offered). Branch ccr-ce41eb45-nv69a8 (both repos).
## Goal
Let a Maxina member connect ChatGPT/Claude to their account ("Connect your AI", Community MCP, read-only v1): VTID-05133.
## Done
- exafyltd/vitana-platform#4074 VTID-05133 gateway (/mcp/community + /mcp/community/chatgpt, ai_connection_grants migration, Commerce grant check) - MERGED 2026-10-13 08:27 as 7cd246b8.
- exafyltd/vitana-v1#1354 VTID-05133 app (consent screen, Settings > Connected AI, "find me" opt-in) - MERGED 08:28 as b1246597.
- Gateway STAGING-VERIFY passed 20/20 (run 38370780443). Earlier related work (VTID-05097, 04613 etc.) not read.
## State now
- No open PRs seen. Community-app staging check on 7e3abbe (run 38376258040) failed 2 items outside this change (smoke VTID-05062 News tab 1518ms vs 1500ms budget; staging redeployed to 80fb08b mid-run). Next run 38380755924 on 80fb08b was queued; result unknown. Session stopped its 2h watch at 10:28 UTC; no Gate 2 sent.
- Platform migration ai_connection_grants already applied to prod DB (deviation D-1, applied before Gate 2 - logged in docs/validation/VTID-05133/deviations.md). Frontend migration 20261013160000_vtid_05133_ai_discoverable.sql NOT applied (dispatch-only workflow apply-vtid-05133-ai-discoverable-migration.yml, after Gate 2).
- Prod: COMMUNITY_MCP_ENABLED unset (off).
## Blocked on / needs owner
- Gate 2 once a community-app STAGING-VERIFY passes; owner decision on D-1; later separate decision to switch on prod and the What's New card (deferred).
## Next steps for Kiro
1. Read-only: check result of run 38380755924 (and any newer community-app run); if passed with VTID-05133 suite, prepare Gate 2 evidence: gateway pinned 7cd246b8 (VTID-05118+05133 between prod and it), app range 703014b0 -> verified commit (05118,05105,05120,05107,05133,05136...), migrations.
2. If fails on flake only (smoke budget), fix-forward the flake in a separate VTID; never loosen tests to get green.
3. Claude-Code-only: send Gate 2, dispatch prod deploys pinned to commits, apply frontend migration, flip COMMUNITY_MCP_ENABLED.
## Gotchas/lessons
- Do not apply migrations before Gate 2 (VTID-04947 D2); the older VTID-05077 precedent is superseded.
- Public ECR rate-limit failed a staging frontend deploy once; re-run. Docs-only/test-only fixes don't trigger staging deploy; dispatch staging deploy manually on main.
- Other session's design-contract spec (VTID-05107) used __dirname; fixed in 51bc5e3.
