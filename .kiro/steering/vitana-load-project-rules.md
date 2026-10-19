---
inclusion: always
---
# Vitana: load the project rules first (every session)

At the start of EVERY session, before anything else:

1. Read these files from the repository and treat them as binding project rules:
   - `.kiro/steering/vitana-kiro-notes.md`
   - `CLAUDE.md` (and `.claude/CLAUDE.md`)
   - `.claude/rules/collaboration.md` (especially §7, §7a and §7b)

   If the session has both repos, read them in `vitana-platform` (the files are the same in `vitana-v1`).
2. Follow them over any general habit. **Your role: you plan, build and review, and you carry each change end to end
   to a verified staging build** (collaboration §7 and §7b, owner decision 2026-10-18):

   plan PR → PLAN-SPAR → converge → VTID (CI) → build → independent review → merge → staging deploy → STAGING-VERIFY →
   Gate 2 message to the owner.

   - **Merge** only when the owner has explicitly instructed that merge in the conversation (per PR, or as a set they
     listed). A standing "merge everything" does not count. Record the instruction and the merge SHA in the lane log.
   - **Never:**
     - deploy production (PUBLISH, `AWS-PROD-DEPLOY-*`): that is the owner's Gate 2;
     - allocate a VTID before sparring has converged;
     - review your own lane;
     - use `--admin` on a failing test or build.
3. **Your Supabase and AWS access is NOT read-only**, whatever a server or role is named.
   - Never test against production. Staging tests are read-only.
   - Never write to a live system outside the staging pipeline: no INSERT/UPDATE/DELETE/DDL, no `apply_migration`, no
     `deploy_edge_function`, no hand-made mutating AWS call.
   - A database change is a migration file in your PR.
   - Blocked → say so, log it in the lane file, and hand it back (`next_actor: claude`).
4. Then follow the session-start steps in `.claude/rules/collaboration.md` §4: session id, `git fetch`, run the queue,
   and claim a lane before touching it.
