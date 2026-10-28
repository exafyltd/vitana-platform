# D - Memory architecture handover (session_014RAXphspHKkn8WApaC6h2K)
- Created 2026-10-09, updated 2026-10-14 02:30 UTC; idle, status need_input. Branch ccr-c9d0005d-6dryex (both repos). Context had been compacted at least once.

## Goal
Finish five memory-architecture items per docs/MEMORY-SYSTEM-PLAN.md section 8.4 (W1 recall live, W2 EventBridge jobs, W3 retire old Supabase functions, W4 DEV_MEMORY_PACK_TOKEN, W5 diary episodes), plus follow-ups.

## Done
- W1 recall live (env-only flip), W3 and W5 done (per session summary).
- VTID-05097: daily diary recording fix (Android recognition error), live in production (prod serves 2a193a171e96 incl. ab1cdb5f), closed in ledger.
- VTID-05129: fixed 16 failing community-app STAGING-VERIFY suites; closed in ledger. Merged: exafyltd/vitana-platform#4075 (24028b77), #4078 (b2fe1274); exafyltd/vitana-v1#1355, #1361 (fa314551, median-of-3 journey), #1389 (522ac303).
- W2 attempted: failed (iam:CreateRole denied by permissions boundary); W4 failed (secretsmanager:CreateSecret not allowed). Nothing created.

## State now
- No open PRs known; check-in triggers stopped. VTID-05007 to watch until about 2026-10-23.
- Evidence: change run 38492044519 on c2df0191: 33/36 pass (journey passes); run 38486821556 on d9ba742c: only other sessions' suites fail. No fully green full run exists (full run ~50 min but staging redeploys every 20-40 min).

## Blocked on / needs owner
- Choose: (1) pause vitana-v1 merges ~55 min so a full STAGING-VERIFY run can finish, or (2) accept per-change runs as proof once Spotlight owners fix failures (VTID-05111, 05114, 05116, 05117 x3; earlier 05155).
- W2: owner runs setup-eventbridge-cron-migration.sh commands in docs/validation/VTID-05011/owner-runbook.md (8 memory jobs; and gateway-dev-memory-handoff-sweep with AUTOMATIONS_GATEWAY_URL unset).
- W4: owner creates secret vitana/gateway/staging/dev-memory-pack-token (and prod), repo variable DEV_MEMORY_PACK_TOKEN_PROD_ARN, and Claude Code env token.

## Next steps for Kiro
1. Nudge owner for the A/B choice; if pause chosen, dispatch STAGING-VERIFY (service, full 40-char commit_sha, full=true).
2. Help Spotlight suite owners fix their red suites (other lanes) so a full run can go green.
3. Watch VTID-05007 until ~10-23. Production deploy / Gate 2 remain Claude Code/PM-only.

## Gotchas/lessons
- workflow_dispatch needs the full 40-char SHA; merge expectedHeadSha too.
- Staging specs read-only; never write as test user a27552a3-...; never test on prod.
- Full runs get "superseded" when staging moves; tests-only merges need a manual AWS-STAGE-DEPLOY-FRONTEND dispatch.
