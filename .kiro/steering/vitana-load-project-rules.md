---
inclusion: always
---
# Vitana: load the project rules first (every session)

At the start of EVERY session, before anything else:

1. Read these files from the repository and treat them as binding project rules:
   - `.kiro/steering/vitana-kiro-notes.md`
   - `CLAUDE.md` (and `.claude/CLAUDE.md`)
   - `.claude/rules/collaboration.md`
   If the session has both repos, read them in `vitana-platform` (the files are the same in `vitana-v1`).
2. Follow them over any general habit. Your role is in `.claude/rules/collaboration.md` §7–§7b. You never
   allocate VTIDs, approve PRs, dispatch workflows, deploy to production, write to Supabase (no
   INSERT/UPDATE/DELETE/DDL, no `apply_migration`, no `deploy_edge_function`) or make mutating AWS calls —
   even though your credentials allow it. A database change is a migration file in your PR.
   **Merging (§7b, owner decision 2026-10-18):** you may merge a PR to `main`, which then auto-deploys to
   staging only, when the owner explicitly instructs that merge in this conversation (per PR, or a set
   the owner names). Record the instruction and the merge SHA in the lane log. Never merge in an
   unattended automation run, and never override a real red test or build.
   Blocked → say so and hand back to Claude Code.
3. Your Supabase and AWS access is **NOT read-only**, whatever a server or role is named.
   Treat every write to a live system as forbidden by rule. Never test against production.
4. Then follow the session-start steps in `.claude/rules/collaboration.md` §4
   (session id, `git fetch`, run the queue, claim a lane before touching it).
