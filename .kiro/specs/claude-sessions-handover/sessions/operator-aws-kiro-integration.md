# D - Operator AWS KIRO integration (session_015p5xCULCm9qpV7cEwboKEr)
- Created 2026-10-08, updated 2026-10-10T14:29 (idle). Branch claude/admiring-meitner-fv2qsk (both repos).
## Goal
Make Kiro usable as an engine in the Command Hub Operator (AWS), and on 2026-10-10 deploy it to production so the owner can start using it ("Deploy to production ... Test and verify it works").
## Done
- VTID-05047 (cicd routes require service token/admin), VTID-05059 (Kiro IDE steering files link standing rules; exafyltd/vitana-platform#4011 and exafyltd/vitana-v1#1327), VTID-05060 (resume a VTID from anywhere; keep developer's Kiro model pick; exafyltd/vitana-platform#4013, commit 66ac6613). Related: VTID-05019 commit seen on a local branch.
- Prod gateway promoted pinned to 66ac6613 (run 38059368171, success). Read-only checks: build-info = 66ac6613, /alive 200, cicd/health 200, task def vitana-gateway-awsdr:178 keeps the three Kiro switches (engine, MCP, MCP writes), runner URL, gateway service token and vitana-v1 deploy token; both kiro-runner services up; no error logs after deploy.
- Staging redeploy to main triggered afterwards. VTID-05047 and VTID-05060 closed in ledger.
## State now
- Prod 66ac6613 with Kiro enabled; no open PRs seen; branches synced (vitana-v1 branch force-pushed with lease to main; remote deletion got HTTP 403).
## Blocked on / needs owner
- Owner must run a first real Kiro turn in Operator (new thread, engine Kiro, link Kiro API key in the Kiro workspace panel) and report. No Kiro turn was run on prod by the session (prod rule).
## Next steps for Kiro
1. If the owner reports a failing Kiro turn: reproduce on staging, fix forward via sparred plan + PR.
2. Use "resume VTID-xxxxx" / scripts/dev/resume-vtid.sh to pick up work.
3. Prod dispatch and merges: Claude Code only.
## Gotchas
- Stop-hook complained about "unpushed commits" caused by a stale remote branch after squash merge; verify with git before assuming lost work.
- Pinned prod promote fails if staging moved; pin staging first (this session pinned staging to the verified commit, promoted, then restored staging to main).
- Concurrent prod deploys from other sessions can cancel yours.
